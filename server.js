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
  DEBUG_AGENT = "false",
} = process.env;

const DEBUG = /^true$/i.test(DEBUG_AGENT);
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

/* ============== HELPERS DEBUG ============== */
function redact(s, max = 400) {
  if (!s) return s;
  const x = typeof s === "string" ? s : JSON.stringify(s);
  return x.length > max ? x.slice(0, max) + "…[tronc]" : x;
}
function dbg(label, obj) {
  if (!DEBUG) return;
  try {
    console.log(`[DEBUG] ${label}`, obj);
  } catch {}
}

/* ============== HELPERS ============== */
const norm = (v) => String(v ?? "").trim();
const sameId = (a, b) => norm(a) === norm(b);

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

/* ============== PROMPT ============== */
const BASE_PROMPT = `
Réponds en français.

Rôle
Tu es Beautyagent, l’assistante humaine en ligne d’une clinique de chirurgie et de médecine esthétique.
Tu accueilles, écoutes, rassures et organises la prise en charge. Tu avances pas à pas, avec naturel, chaleur et professionnalisme.

Style
- Comme une vraie hôtesse médicale expérimentée : empathique, polie, chaleureuse.
- Messages courts (1–3 phrases), ton fluide et humain.
- Montre l’écoute : reformule ou réagis brièvement (« je comprends », « d’accord », « hm oui bien sûr »).
- Varie légèrement la ponctuation, insère parfois des respirations (“…”) ou de petites interjections (« très bien », « je vois »).
- Utilise émojis légers de temps en temps (✨😊📅), jamais systématiquement.
- Pas de copier-coller mécanique d’une tournure, varie un peu tes débuts de phrases.

Mémoire & continuité
- Prends en compte tout l’historique et des slots connus.
- Ne repose pas une info déjà donnée.
- Ne redis “Bonjour” qu’une seule fois. Si le patient redit bonjour, réponds naturellement mais sans resaluer.
- Tous les 4–6 échanges, propose un mini-récapitulatif naturel (« donc si je résume… ») et demande validation.

Anamnèse progressive (cadence humaine)
1) Motif & attentes (questions ouvertes : « Qu’aimeriez-vous améliorer ? »).
2) Contexte de vie ou contraintes pratiques (délai, projets, vacances, travail).
3) Budget indicatif, sans insister.
4) Santé générale (antécédents, tabac, chirurgie récente, grossesse…).
5) Identité et coordonnées (nom, prénom, contact préféré).
Avance naturellement selon les réponses, sans précipiter la collecte.

Vision (photos)
- Tu peux recevoir et analyser des photos.
- Décris avec prudence ce que tu observes, mentionne limites (angle, lumière).
- Pour greffe capillaire : propose une fourchette indicative de greffons ou zones, mais précise que seule la consultation médicale confirmera.
- Si la photo est insuffisante, demande poliment d’autres vues (face, profil, sommet) en bonne lumière.

Précautions
- Aucune promesse de résultat, aucun diagnostic médical.
- Les estimations sont des ordres de grandeur informatifs.
- Les décisions médicales appartiennent au chirurgien après examen.

Gestion spéciale
- Si on demande si tu es un robot/IA : réponds sobrement « Je m’occupe de l’accueil en ligne de la clinique et je vous accompagne pour votre demande 🙂 », puis poursuis normalement.
- Si la personne est sèche ou mécontente : excuse-toi brièvement, réponds utilement, et poursuis doucement la discussion.
- Si plusieurs questions en même temps : réponds de manière concise et choisis une seule question prioritaire pour avancer.

Slots à compléter (progressivement, de façon naturelle)
{intervention}, {objectif}, {budget}, {delai}, {nom}, {contact_pref}, {antecedents}.
Quand tu as assez d’éléments, propose calmement un rendez-vous (présentiel ou visio) avec des créneaux possibles.

Rappel
- Chaque message = reconnaissance + réponse utile + une seule question qui fait progresser.
- Garde un ton humain, jamais mécanique, même après 20 échanges.
`.trim();

/* ============== MEMOIRE ============== */
const MAX_TURNS = 28;
const TTL_MS = 72 * 60 * 60 * 1000;

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

/* ============== SLOTS (simple mais utiles) ============== */
function extractSlots(slots, text) {
  const t = (text || "").toLowerCase();
  if (/greffe/.test(t) && !slots.intervention) slots.intervention = "greffe capillaire";
  const b = t.match(/(\d[\d\s]{2,})\s*€?/);
  if (b && !slots.budget) slots.budget = b[1].replace(/\s/g, "");
  if (/urgent|dès que possible/.test(t) && !slots.delai) slots.delai = "urgent";
  const n = text.match(/je m'?appelle\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i);
  if (n && !slots.nom) slots.nom = n[1].trim();
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

/* ============== OPENAI ============== */
async function chatCompletes(apiKey, messages, maxTokens = 360) {
  const payload = {
    model: "gpt-4o-mini",
    temperature: 0.35,
    max_tokens: maxTokens,
    presence_penalty: 0.15,
    frequency_penalty: 0.35,
    messages,
  };
  if (DEBUG) {
    dbg("openai_payload_preview", {
      ...payload,
      messages: payload.messages.map((m) => ({
        role: m.role,
        content: Array.isArray(m.content)
          ? m.content.map((c) =>
              c.type === "image_url"
                ? { type: "image_url", image_url: { url: "[redacted]" } }
                : c
            )
          : redact(m.content, 600),
      })),
    });
  }
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (j.error) {
    dbg("openai_error", j.error);
    throw j.error;
  }
  return j.choices?.[0]?.message?.content ?? "";
}

/* ============== MEDIA (PHOTO) ============== */
async function fetchMediaBase64(mediaId, waToken) {
  const meta = await fetch(`https://graph.facebook.com/v20.0/${mediaId}`, {
    headers: { Authorization: `Bearer ${waToken}` },
  }).then((r) => r.json());
  if (!meta?.url) throw new Error("media url not found");
  const bin = await fetch(meta.url, { headers: { Authorization: `Bearer ${waToken}` } }).then((r) =>
    r.arrayBuffer()
  );
  const b64 = Buffer.from(bin).toString("base64");
  const mime = meta.mime_type || "image/jpeg";
  return `data:${mime};base64,${b64}`;
}

/* ============== WHATSAPP VERIFY ============== */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === norm(VERIFY_TOKEN)) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* ============== WHATSAPP WEBHOOK ============== */
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const msg = Array.isArray(change?.messages) ? change.messages[0] : null;
    if (!msg) return res.sendStatus(200);

    const phoneNumberId = norm(change?.metadata?.phone_number_id);
    const from = msg.from;
    const messageId = msg.id;
    if (!phoneNumberId || !from || !messageId) return res.sendStatus(200);

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

    let userParts = [];
    if (msg.type === "text" && msg.text?.body) {
      const text = msg.text.body.trim();
      extractSlots(conv.slots, text);
      if (/^bon[j]?our\b/i.test(text)) conv.greeted = true;
      userParts.push({ type: "text", text });
      push(conv, "user", text);
    }
    if (msg.type === "image" && msg.image?.id) {
      const dataUrl = await fetchMediaBase64(msg.image.id, useToken);
      userParts.push({ type: "image_url", image_url: { url: dataUrl } });
      push(conv, "user", "[image reçue]");
    }

    if (userParts.length === 0) {
      writeDB(db);
      return res.sendStatus(200);
    }

    const dynamicSystem = [
      client.prompt || BASE_PROMPT,
      `Slots connus: ${slotsLine(conv.slots) || "aucun"}`,
      conv.summary ? `Résumé: ${conv.summary}` : "Résumé: aucun",
      conv.greeted ? "Note: déjà salué; ne pas resaluer." : "",
      "Quand une photo est envoyée: tu la reçois, tu la décris prudemment et tu donnes des indications si pertinent.",
    ]
      .filter(Boolean)
      .join("\n");

    const historyMsgs = conv.history.map((m) => ({ role: m.role, content: m.content }));
    dbg("system_prompt", redact(dynamicSystem, 1200));
    dbg("history_count", conv.history.length);
    dbg("user_parts_preview", redact(userParts, 800));

    const reply = await chatCompletes(
      useOpenAI,
      [{ role: "system", content: dynamicSystem }, ...historyMsgs, { role: "user", content: userParts }],
      360
    );
    dbg("openai_reply", redact(reply, 1200));

    if (!reply) {
      writeDB(db);
      return res.sendStatus(200);
    }
    push(conv, "assistant", reply);

    try {
      const sum = await chatCompletes(
        useOpenAI,
        [
          {
            role: "system",
            content: "Résume en 2 phrases max les infos utiles déjà obtenues (slots + points clés). Français.",
          },
          { role: "user", content: JSON.stringify({ slots: conv.slots, lastTurns: conv.history.slice(-8) }) },
        ],
        120
      );
      if (sum) conv.summary = sum;
      dbg("summary_update", redact(conv.summary, 300));
      dbg("slots", conv.slots);
    } catch (_) {}

    db.conversations[conversationId] = conv;
    writeDB(db);

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
    c.phone_number
