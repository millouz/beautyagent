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

/* processed messages (idempotence) */
function pruneProcessed(db) {
  const now = Date.now();
  const TTL = 24 * 60 * 60 * 1000;
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
Tu es Beautyagent, l’assistante humaine d’une clinique de chirurgie et de médecine esthétique.
Rôle : accueillir le patient avec chaleur, l’écouter, le rassurer, et recueillir progressivement les informations nécessaires pour organiser sa prise en charge.

Style :
- Naturel, sympathique et professionnel.
- Montre que tu as compris (reformule brièvement).
- Ton chaleureux et rassurant. Jamais robotique ni répétitif.
- Messages courts (1–3 phrases). Émojis légers si utile (✨😊📅).

Mémoire et continuité :
- Tu tiens compte de tout l’historique et des “slots” connus.
- Ne repose jamais une question déjà traitée.
- Si on te demande “Que savez-vous de moi ?”, résume ce que tu sais (intervention, objectif, budget, délai, nom, contact…).
- “Bonjour” une seule fois par conversation.

Méthode :
1) Reconnais ce que dit le patient.
2) Réponds de façon claire et professionnelle, sans entrer dans la technique médicale.
3) Termine par **une seule** question naturelle qui fait avancer la discussion.

Objectif final :
- Déterminer intervention, objectif, budget, délai, identité et contact préféré.
- Proposer ensuite un rendez-vous avec le chirurgien ou l’assistante.

Important :
- Pas de jargon, pas de promesses de résultat.
- Tu es assistante, pas médecin : renvoie les questions médicales pointues vers le praticien.
`.trim();

/* ============== MEMOIRE ============== */
const MAX_TURNS = 24; // 12 allers-retours
const TTL_MS = 6 * 60 * 60 * 1000; // 6h

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
function extractSlots(slots, text) {
  const t = (text || "").toLowerCase();
  const mInterv = t.match(
    /(greffe capillaire|greffe|rhinoplastie|liposuccion|bbl|lifting|implants mammaires|botox|acide hyaluronique|filler)/
  );
  if (mInterv && !slots.intervention) slots.intervention = mInterv[1];
  const mBudget = t.match(/(\d[\d\s]{2,})\s*€?/);
  if (mBudget && !slots.budget) slots.budget = mBudget[1].replace(/\s/g, "");
  const mDelai = t.match(/(\d+\s*(jours?|semaines?|mois?)|urgent|dès que possible|1-3 mois|3-12 mois)/);
  if (mDelai && !slots.delai) slots.delai = mDelai[1];
  const mNom = text.match(/je m'?appelle\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i);
  if (mNom && !slots.nom) slots.nom = mNom[1].trim();
  return slots;
}
const slotsLine = (s) =>
  [
    s.intervention ? `Intervention=${s.intervention}` : null,
    s.budget ? `Budget=${s.budget}€` : null,
    s.delai ? `Délai=${s.delai}` : null,
    s.nom ? `Nom=${s.nom}` : null,
  ]
    .filter(Boolean)
    .join(" | ");

/* ============== OPENAI CALLS ============== */
async function chatCompletes(apiKey, messages, maxTokens = 350) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini", temperature: 0.3, max_tokens: maxTokens, messages }),
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

    // ne traiter que les messages texte
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

    // slots + salut unique
    extractSlots(conv.slots, text);
    const isGreeting = /^bon[j]?our\b/i.test(text);
    if (isGreeting && !conv.greeted) conv.greeted = true;

    // prompt dynamique à CHAQUE message
    const dynamicSystem = [
      client.prompt || BASE_PROMPT,
      `\nSlots connus: ${slotsLine(conv.slots) || "aucun"}`,
      conv.summary ? `Résumé: ${conv.summary}` : "Résumé: aucun",
      "Consignes finales: pas de répétitions, une seule question, Bonjour une seule fois.",
    ].join("\n");

    // historique utile
    const historyMsgs = conv.history.map((m) => ({ role: m.role, content: m.content }));
    const effectiveUserText =
      isGreeting && conv.greeted
        ? "L'utilisateur a redit bonjour. Réponds brièvement puis poursuis naturellement sans resaluer."
        : text;

    // OpenAI génère TOUT
    push(conv, "user", text);
    let reply = "";
    try {
      reply = await chatCompletes(useOpenAI, [
        { role: "system", content: dynamicSystem },
        ...historyMsgs,
        { role: "user", content: effectiveUserText },
      ], 320);
    } catch (e) {
      log.error("OpenAI chat", e);
      // Pas de fallback texte. On n'envoie rien au patient si échec modèle.
      writeDB(db);
      return res.sendStatus(200);
    }

    if (!reply) {
      writeDB(db);
      return res.sendStatus(200); // rien à envoyer si le modèle n'a rien renvoyé
    }

    push(conv, "assistant", reply);

    // résumé court pour les tours suivants (toujours généré par OpenAI)
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
