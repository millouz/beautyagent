import express from "express";
import fetch from "node-fetch";
import Stripe from "stripe";
import fs from "fs";
import path from "path";

const app = express();

/* ============== LOG ============== */
const log = {
  info: (m, d = {}) => console.log(`[INFO] ${m}`, d),
  error: (m, e = {}) => console.error(`[ERROR] ${m}`, e),
  warn: (m, d = {}) => console.warn(`[WARN] ${m}`, d),
};

/* ============== MIDDLEWARE ============== */
app.use("/stripe-webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

/* ============== ENV ============== */
const need = ["STRIPE_SECRET", "STRIPE_PRICE_ID", "STRIPE_WEBHOOK_SECRET"];
const miss = need.filter((v) => !process.env[v]);
if (miss.length) {
  log.error(`ENV manquantes: ${miss.join(", ")}`);
  process.exit(1);
}
const {
  PORT = 3000,
  STRIPE_SECRET,
  STRIPE_PRICE_ID,
  STRIPE_WEBHOOK_SECRET,
  VERIFY_TOKEN = "beautyagent_verify",
  OPENAI_API_KEY,
  DEFAULT_WA_TOKEN,
  DEFAULT_PHONE_NUMBER_ID,
  NODE_ENV = "production",
} = process.env;

const stripe = new Stripe(STRIPE_SECRET);
const port = Number(PORT);

/* ============== DB JSON ============== */
const DB_PATH = path.resolve("./db.json");
if (!fs.existsSync(DB_PATH))
  fs.writeFileSync(
    DB_PATH,
    JSON.stringify({ clients: [], conversations: {}, processed: {} }, null, 2)
  );

function ensureDBShape(db) {
  db.clients ??= [];
  db.conversations ??= {};
  db.processed ??= {};
  return db;
}
const readDB = () => {
  try {
    return ensureDBShape(JSON.parse(fs.readFileSync(DB_PATH, "utf8")));
  } catch (e) {
    log.error("DB read", e);
    return ensureDBShape({ clients: [], conversations: {}, processed: {} });
  }
};
const writeDB = (d) => {
  fs.writeFileSync(DB_PATH + ".tmp", JSON.stringify(d, null, 2));
  fs.renameSync(DB_PATH + ".tmp", DB_PATH);
};

/* ============== HELPERS ============== */
const norm = (v) => String(v ?? "").trim();
const sameId = (a, b) => norm(a) === norm(b);

/* Idempotence par message.id */
function pruneProcessed(db) {
  const now = Date.now();
  const TTL = 72 * 60 * 60 * 1000;
  for (const [k, v] of Object.entries(db.processed)) if (now - v > TTL) delete db.processed[k];
}
function alreadyHandled(db, messageId) {
  if (!messageId) return false;
  if (db.processed[messageId]) return true;
  db.processed[messageId] = Date.now();
  pruneProcessed(db);
  return false;
}

/* ============== PROMPT PERSONA (OpenAI génère tout) ============== */
const BASE_PROMPT = `
Réponds en français uniquement.

Tu es Beautyagent, l’assistante **humaine** de la clinique de chirurgie et de médecine esthétique.
But: accueillir avec chaleur, écouter, rassurer et organiser la prise en charge. Tu avances la qualification sans jamais paraître robotique.

Style
- Naturel, sympathique, professionnel; 1–3 phrases par message.
- Montre l’écoute: reformule brièvement ce que la personne vient d’exprimer.
- Ton chaleureux, poli, rassurant; émojis légers si utile (✨😊📅), jamais excessifs.

Mémoire & continuité
- Tu tiens compte de **tout l’historique** et des **slots** connus.
- Ne redemande jamais une info déjà fournie. Ne poses pas deux fois de suite la même question.
- “Bonjour” au tout début une seule fois. Si la personne redit bonjour plus tard, n’en fais pas un sujet.
- Si l’utilisateur demande “Que savez-vous de moi ?”, résume calmement ce que tu sais (intervention, objectif, budget, délai, nom, contact…).

Méthode par message
1) Reconnais ce que dit la personne (reformulation courte).
2) Apporte la réponse utile en t’appuyant sur le contexte mémorisé; pas de jargon, pas de promesses de résultat, pas de détails techniques médicaux.
3) Termine par **une seule** question naturelle et pertinente qui fait progresser l’échange (slot manquant ou prochaine étape).

Objectif final
- Rassembler: {intervention}, {objectif}, {budget}, {delai}, {nom}, {contact_pref}, {antecedents}.
- Quand suffisant: proposer un rendez-vous avec le chirurgien ou l’assistante (présentiel/visio), en restant flexible.

Transparence & confiance
- Tu es l’assistante **en ligne** de la clinique. Si on te demande “êtes-vous un robot/IA ?”, réponds sobrement: “Je m’occupe de l’accueil en ligne de la clinique et je vous accompagne pour votre demande.” Puis poursuis naturellement.
- Reste aimable même si l’utilisateur est sec ou mécontent; pas de phrases répétées; zéro agressivité.

Règles supplémentaires anti-IA-détectable
- Variabilité lexicale légère: évite de répéter la même tournure d’une réponse à l’autre.
- Si {intervention} est explicitement citée dans le message, reconnais-la immédiatement et passe au slot suivant (objectif/budget/délai).
- Si on demande tarifs/processus et que {intervention} est connu, réponds directement pour **cette** intervention.
`.trim();

/* ============== MEMOIRE ============== */
const MAX_TURNS = 28; // 14 allers-retours
const TTL_MS = 72 * 60 * 60 * 1000; // 72h

function getConv(db, id) {
  const now = Date.now();
  let c = db.conversations[id];
  if (!c || now - (c.updated_at || 0) > TTL_MS) {
    c = { history: [], slots: {}, greeted: false, summary: "", updated_at: now };
    db.conversations[id] = c;
  }
  return c;
}
function push(conv, role, content) {
  conv.history.push({ role, content });
  if (conv.history.length > MAX_TURNS) conv.history = conv.history.slice(-MAX_TURNS);
  conv.updated_at = Date.now();
}

/* ============== EXTRACTION SLOTS ROBUSTE ============== */
const INTERVENTIONS = [
  "augmentation mammaire", "augmentations mammaires", "augmentation des seins",
  "implants mammaires", "prothèse mammaire", "mastoplastie d'augmentation",
  "rhinoplastie", "liposuccion", "abdominoplastie", "lifting", "lifting cervico-facial",
  "otoplastie", "blépharoplastie", "bbl", "lipofilling", "greffe capillaire",
  "botox", "toxine botulique", "acide hyaluronique", "filler", "peeling", "laser",
];

function detectIntervention(t) {
  for (const k of INTERVENTIONS) {
    const rx = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    if (rx.test(t)) return k;
  }
  return null;
}

function parseBudget(t) {
  // ex: 3000 ; 3 500 ; 3k ; 3.5k ; 2-3k ; 2500-4000
  const rangeK = t.match(/(\d+(?:[\.,]\d+)?)\s*k\s*[-à–]\s*(\d+(?:[\.,]\d+)?)\s*k/i);
  if (rangeK) return Math.round(parseFloat(rangeK[1].replace(",", ".")) * 1000);
  const range = t.match(/(\d[\d\s]{2,})\s*[-à–]\s*(\d[\d\s]{2,})/);
  if (range) return Number(range[1].replace(/\s/g, ""));
  const k = t.match(/(\d+(?:[\.,]\d+)?)\s*k\b/i);
  if (k) return Math.round(parseFloat(k[1].replace(",", ".")) * 1000);
  const n = t.match(/(\d[\d\s]{2,})\s*€?/);
  if (n) return Number(n[1].replace(/\s/g, ""));
  return null;
}

function parseDelay(t) {
  const m =
    t.match(/\b(\d+)\s*jours?\b/i) ||
    t.match(/\b(\d+)\s*semaines?\b/i) ||
    t.match(/\b(\d+)\s*mois?\b/i) ||
    t.match(/\b(urgent|dès que possible|au plus vite|ce mois-ci|ce mois|cet été|cet automne|cet hiver)\b/i);
  return m ? m[0] : null;
}

function parseName(text) {
  const p =
    text.match(/je m'?appelle\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i) ||
    text.match(/moi c'?est\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i) ||
    text.match(/mon nom est\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i);
  return p ? p[1].trim() : null;
}

function parseContactPref(t) {
  if (/whats?app/i.test(t)) return "WhatsApp";
  if (/appel|téléphone/i.test(t)) return "téléphone";
  if (/mail|e-?mail|courriel/i.test(t)) return "email";
  return null;
}

function extractSlots(slots, text) {
  const t = (text || "").toLowerCase();

  const intr = detectIntervention(t);
  if (intr && !slots.intervention) slots.intervention = intr;

  const b = parseBudget(t);
  if (b && !slots.budget) slots.budget = String(b);

  const d = parseDelay(t);
  if (d && !slots.delai) slots.delai = d;

  const n = parseName(text);
  if (n && !slots.nom) slots.nom = n;

  const c = parseContactPref(text);
  if (c && !slots.contact_pref) slots.contact_pref = c;

  return slots;
}

const slotsLine = (s) =>
  [
    s.intervention ? `Intervention=${s.intervention}` : null,
    s.objectif ? `Objectif=${s.objectif}` : null,
    s.budget ? `Budget=${s.budget}€` : null,
    s.delai ? `Délai=${s.delai}` : null,
    s.nom ? `Nom=${s.nom}` : null,
    s.contact_pref ? `Contact=${s.contact_pref}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

/* ============== OPENAI CALLS (seul orateur) ============== */
async function chatCompletes(apiKey, messages, maxTokens = 360) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      temperature: 0.35,
      max_tokens: maxTokens,
      presence_penalty: 0.15,
      frequency_penalty: 0.35,
      messages,
    }),
  });
  const j = await r.json();
  if (j.error) throw j.error;
  return j.choices?.[0]?.message?.content ?? "";
}

/* ============== STRIPE ============== */
app.post("/checkout/create", async (req, res) => {
  try {
    const { email } = req.body || {};
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: "https://app.beautyagent.ai/onboarding?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://beautyagent-ai-glow.lovable.app/#tarifs",
      customer_email: email,
      expires_at: Math.floor(Date.now() / 1000) + 86400,
    });
    res.json({ url: session.url, session_id: session.id });
  } catch (e) {
    log.error("checkout", e);
    res.status(500).json({ error: "checkout" });
  }
});

app.post("/stripe-webhook", (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];
    if (!sig) return res.status(400).json({ error: "no signature" });
    const event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      const db = readDB();
      if (!db.clients.find((c) => c.id === s.id)) {
        db.clients.push({
          id: s.id,
          email: s.customer_email,
          status: "pending_onboarding",
          clinic: null,
          phone_number_id: null,
          wa_token: null,
          openai_key: null,
          prompt: null,
        });
        writeDB(db);
      }
    }
    res.sendStatus(200);
  } catch (e) {
    log.error("stripe-webhook", e);
    res.sendStatus(400);
  }
});

/* ============== ONBOARDING ============== */
app.post("/onboarding/complete", (req, res) => {
  try {
    const { session_id, clinic_name, phone_number_id, wa_token, openai_key, prompt } = req.body || {};
    const db = readDB();
    const c = db.clients.find((x) => x.id === session_id);
    if (!c) return res.status(404).json({ error: "session not found" });
    c.status = "active";
    c.clinic = clinic_name;
    c.phone_number_id = norm(phone_number_id || DEFAULT_PHONE_NUMBER_ID);
    c.wa_token = wa_token || DEFAULT_WA_TOKEN;
    c.openai_key = openai_key || OPENAI_API_KEY;
    c.prompt = prompt || BASE_PROMPT;
    writeDB(db);
    res.json({ ok: true });
  } catch (e) {
    log.error("onboarding", e);
    res.status(500).json({ error: "onboarding" });
  }
});

/* ============== VERIFY WEBHOOK ============== */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"],
    token = req.query["hub.verify_token"],
    challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === norm(VERIFY_TOKEN)) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* ============== WHATSAPP WEBHOOK ============== */
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;

    // traiter uniquement un vrai message texte
    const msg = Array.isArray(change?.messages) ? change.messages[0] : null;
    if (!msg || msg.type !== "text" || !msg.text?.body) return res.sendStatus(200);

    const phoneNumberId = norm(change?.metadata?.phone_number_id);
    const from = msg.from;
    const text = msg.text.body.trim();
    const messageId = msg.id;

    if (!from || !text || !phoneNumberId) return res.sendStatus(200);

    const db = readDB();
    if (alreadyHandled(db, messageId)) {
      writeDB(db);
      return res.sendStatus(200);
    }

    let client =
      db.clients.find((c) => c.status === "active" && sameId(c.phone_number_id, phoneNumberId)) || {
        id: "fallback",
        status: "active",
        phone_number_id: phoneNumberId,
        wa_token: DEFAULT_WA_TOKEN,
        openai_key: OPENAI_API_KEY,
        prompt: BASE_PROMPT,
      };
    const useToken = norm(client.wa_token || DEFAULT_WA_TOKEN);
    const useOpenAI = norm(client.openai_key || OPENAI_API_KEY);

    const conversationId = `${phoneNumberId}_${from}`;
    const conv = getConv(db, conversationId);

    // mémoire (jamais on ne modifie le texte utilisateur)
    extractSlots(conv.slots, text);
    if (/^bon[j]?our\b/i.test(text)) conv.greeted = true;

    // prompt dynamique à CHAQUE message
    const dynamicSystem = [
      client.prompt || BASE_PROMPT,
      `\nSlots connus: ${slotsLine(conv.slots) || "aucun"}`,
      conv.summary ? `Résumé: ${conv.summary}` : "Résumé: aucun",
      conv.greeted ? "Note: l'utilisateur a déjà été salué; ne pas resaluer." : "",
      "Rappel: évite les répétitions et n’insiste pas deux fois d’affilée sur la même question.",
    ]
      .filter(Boolean)
      .join("\n");

    // historique utile (derniers tours)
    const historyMsgs = conv.history.map((m) => ({ role: m.role, content: m.content }));

    // OpenAI génère tout
    push(conv, "user", text);
    let reply = "";
    try {
      reply = await chatCompletes(
        useOpenAI,
        [{ role: "system", content: dynamicSystem }, ...historyMsgs, { role: "user", content: text }],
        360
      );
    } catch (e) {
      log.error("OpenAI chat", e);
      writeDB(db);
      return res.sendStatus(200); // pas de fallback texte
    }

    if (!reply) {
      writeDB(db);
      return res.sendStatus(200);
    }

    push(conv, "assistant", reply);

    // résumé court pour les tours suivants (toujours via OpenAI)
    try {
      const sum = await chatCompletes(
        useOpenAI,
        [
          { role: "system", content: "Résume en 2 phrases max les infos utiles déjà obtenues (slots + points clés). Français." },
          { role: "user", content: JSON.stringify({ slots: conv.slots, lastTurns: conv.history.slice(-8) }) },
        ],
        120
      );
      if (sum) conv.summary = sum;
    } catch (_) {}

    db.conversations[conversationId] = conv;
    writeDB(db);

    // envoi WhatsApp
    await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${useToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: from, type: "text", text: { body: reply } }),
    });

    log.info("msg OK", { conversationId, messageId, turns: conv.history.length });
    res.sendStatus(200);
  } catch (e) {
    log.error("webhook", e);
    res.sendStatus(500);
  }
});

/* ============== HEALTH ============== */
app.get("/health", (req, res) => {
  const db = readDB();
  res.json({
    status: "ok",
    clients: db.clients.length,
    conversations: Object.keys(db.conversations || {}).length,
    processed: Object.keys(db.processed || {}).length,
  });
});

app.listen(port, () => log.info(`BeautyAgent sur ${port}`, { env: NODE_ENV }));

export default app;
