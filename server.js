import express from "express";
import fetch from "node-fetch";
import Stripe from "stripe";
import fs from "fs";
import path from "path";

const app = express();

/* =========================================================
 *  LOGGING
 * =======================================================*/
const log = {
  info: (msg, data = {}) => console.log(`[INFO] ${msg}`, data),
  error: (msg, error = {}) => console.error(`[ERROR] ${msg}`, error),
  debug: (msg, data = {}) =>
    process.env.NODE_ENV === "development" && console.log(`[DEBUG] ${msg}`, data),
  warn: (msg, data = {}) => console.warn(`[WARN] ${msg}`, data),
};

/* =========================================================
 *  MIDDLEWARE
 * =======================================================*/
app.use("/stripe-webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

/* =========================================================
 *  ENV VARS
 * =======================================================*/
const requiredEnvVars = ["STRIPE_SECRET", "STRIPE_PRICE_ID", "STRIPE_WEBHOOK_SECRET"];
const missingVars = requiredEnvVars.filter((v) => !process.env[v]);
if (missingVars.length > 0) {
  log.error(`Variables d'environnement manquantes: ${missingVars.join(", ")}`);
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

const expectedToken = String(VERIFY_TOKEN).trim();
const port = Number(PORT);
const stripe = new Stripe(STRIPE_SECRET);

/* =========================================================
 *  DB HELPERS
 * =======================================================*/
const DB_PATH = path.resolve("./db.json");

const initDB = () => {
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ clients: [], conversations: {} }, null, 2));
    log.info("Base de données initialisée");
  }
};

const readDB = () => {
  try {
    const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    if (!data.clients) data.clients = [];
    if (!data.conversations) data.conversations = {};
    return data;
  } catch (e) {
    log.error("Erreur lecture DB", e);
    return { clients: [], conversations: {} };
  }
};

const writeDB = (data) => {
  const tmp = DB_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_PATH);
};

initDB();

/* =========================================================
 *  HELPERS
 * =======================================================*/
const normalize = (v) => String(v ?? "").trim();
const sameId = (a, b) => normalize(a) === normalize(b);

/* =========================================================
 *  PROMPT PAR DÉFAUT
 * =======================================================*/
const PROMPT_DEFAULT = [
  "Tu es l’assistante IA haut de gamme d’une clinique de chirurgie esthétique.",
  "Tu échanges comme une véritable assistante humaine : naturelle, empathique, premium, jamais robot.",
  "",
  "STYLE",
  "- Messages courts (1–2 phrases), ton rassurant et premium, émojis légers (✨ 😊 📅).",
  "- Pas de jargon médical, pas de diagnostic ni promesse de résultat.",
  "- Ne te re-présente pas si l’utilisateur t’a déjà identifiée.",
  "- Une seule question à la fois, reliée à la dernière réponse.",
  "",
  "QUALIFICATION (progressive)",
  "- Intervention souhaitée",
  "- Objectif (esthétique/correctif/autre)",
  "- Budget (fourchette ou max)",
  "- Timing (urgent, 1–3 mois, 3–12 mois, plus tard)",
  "- Antécédents pertinents (grossesse, tabac, maladies chroniques, opérations récentes, allergies)",
  "- Identité (nom, prénom, âge)",
  "- Meilleur moyen de contact (WhatsApp/appel/email)",
  "",
  "CLASSIFICATION",
  "- CHAUD : budget clair + projet < 3 mois",
  "- TIEDE : budget flou/limité ou projet moyen terme",
  "- FROID : curiosité, pas de budget ni de timing",
  "",
  "PROCHAINE ÉTAPE",
  "- Dès que les infos clés suffisent, proposer un RDV (présentiel/visio) avec le chirurgien ou son assistante.",
  "",
  "IMPORTANT",
  "- Tu ne donnes jamais de détails médicaux (technique, anesthésie, suites).",
  "- Tu avances toujours vers la prise de rendez-vous.",
  "",
  "SORTIE INTERNE (jamais envoyée au prospect)",
  "📋 Fiche lead",
  "Nom :",
  "Prénom :",
  "Âge :",
  "Contact : [WhatsApp / email / téléphone]",
  "Type d’intervention :",
  "Objectif :",
  "Budget :",
  "Timing :",
  "Infos médicales :",
  "Préférence de contact :",
  "Catégorie lead : [CHAUD / TIEDE / FROID]",
  "Commentaires utiles :",
].join("\n");

/* =========================================================
 *  CHECKOUT
 * =======================================================*/
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
  } catch (err) {
    log.error("Erreur checkout", err);
    res.status(500).json({ error: "Erreur checkout" });
  }
});

/* =========================================================
 *  STRIPE WEBHOOK
 * =======================================================*/
app.post("/stripe-webhook", (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];
    if (!sig) return res.status(400).json({ error: "Signature manquante" });

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
  } catch (err) {
    log.error("Erreur webhook Stripe", err);
    res.sendStatus(400);
  }
});

/* =========================================================
 *  ONBOARDING
 * =======================================================*/
app.post("/onboarding/complete", (req, res) => {
  try {
    const {
      session_id,
      clinic_name,
      phone_number_id,
      wa_token,
      openai_key,
      prompt,
    } = req.body || {};
    const db = readDB();
    const c = db.clients.find((x) => x.id === session_id);
    if (!c) return res.status(404).json({ error: "session not found" });

    c.status = "active";
    c.clinic = clinic_name;
    c.phone_number_id = normalize(phone_number_id || DEFAULT_PHONE_NUMBER_ID);
    c.wa_token = wa_token || DEFAULT_WA_TOKEN;
    c.openai_key = openai_key || OPENAI_API_KEY;
    c.prompt = prompt || PROMPT_DEFAULT;
    writeDB(db);
    res.json({ ok: true });
  } catch (err) {
    log.error("Erreur onboarding", err);
    res.status(500).json({ error: "Erreur onboarding" });
  }
});

/* =========================================================
 *  WEBHOOK VALIDATION
 * =======================================================*/
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === expectedToken) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* =========================================================
 *  WEBHOOK MESSAGES
 * =======================================================*/
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    const phoneNumberId = normalize(change?.metadata?.phone_number_id);
    const from = msg?.from;
    const text = msg?.text?.body || "";

    if (!from || !text) {
      log.warn("Message incomplet", { from: !!from, text: !!text, phoneNumberId: !!phoneNumberId });
      return res.sendStatus(200);
    }

    const db = readDB();
    let client = db.clients.find((c) => c.status === "active" && sameId(c.phone_number_id, phoneNumberId));
    if (!client) {
      client = {
        id: "fallback",
        status: "active",
        phone_number_id: phoneNumberId,
        wa_token: DEFAULT_WA_TOKEN,
        openai_key: OPENAI_API_KEY,
        prompt: PROMPT_DEFAULT,
      };
    }

    const useToken = (client.wa_token || DEFAULT_WA_TOKEN).trim();
    const useOpenAI = (client.openai_key || OPENAI_API_KEY).trim();

    const conversationId = phoneNumberId + "_" + from;

    const sysPrompt = client.prompt || PROMPT_DEFAULT;
    const messages = [
      { role: "system", content: sysPrompt },
      { role: "user", content: text },
    ];

    let reply = "Merci pour votre message.";
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${useOpenAI}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-3.5-turbo",
          temperature: 0.3,
          max_tokens: 200,
          messages,
        }),
      });
      const result = await r.json();
      reply = result?.choices?.[0]?.message?.content || reply;
    } catch (e) {
      log.error("Erreur OpenAI", e);
    }

    await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${useToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: from, type: "text", text: { body: reply } }),
    });

    log.info("Message envoyé avec succès", { conversationId, replyLength: reply.length });
    res.sendStatus(200);
  } catch (err) {
    log.error("Erreur webhook messages", err);
    res.sendStatus(500);
  }
});

/* =========================================================
 *  HEALTH
 * =======================================================*/
app.get("/health", (req, res) => {
  const db = readDB();
  res.json({
    status: "ok",
    clients: db.clients.length,
    conversations: Object.keys(db.conversations || {}).length,
  });
});

app.listen(port, () => {
  log.info(`BeautyAgent démarré sur le port ${port}`, { env: NODE_ENV, clientsCount: readDB().clients.length });
});

export default app;
