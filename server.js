import express from "express";
import fetch from "node-fetch";
import Stripe from "stripe";
import fs from "fs";
import path from "path";

/* =========================================================
 *  APP & LOGGING
 * =======================================================*/
const app = express();

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
  try {
    if (!fs.existsSync(DB_PATH)) {
      const initialData = { clients: [], conversations: {} };
      fs.writeFileSync(DB_PATH, JSON.stringify(initialData, null, 2));
      log.info("Base de données initialisée");
    }
  } catch (error) {
    log.error("Erreur lors de l'initialisation de la DB", error);
    throw error;
  }
};

const readDB = () => {
  try {
    const data = JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
    if (!data.clients) data.clients = [];
    if (!data.conversations) data.conversations = {};
    return data;
  } catch (error) {
    log.error("Erreur lecture DB", error);
    return { clients: [], conversations: {} };
  }
};

const writeDB = (data) => {
  try {
    const tempPath = `${DB_PATH}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, DB_PATH);
    log.debug("DB sauvegardée");
  } catch (error) {
    log.error("Erreur écriture DB", error);
    throw error;
  }
};

initDB();

/* =========================================================
 *  VALIDATION/UTILS
 * =======================================================*/
const validateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
const validateSessionData = (d) => {
  const missing = ["session_id"].filter((f) => !d[f]);
  return missing.length === 0 ? null : `Champs manquants: ${missing.join(", ")}`;
};

const normalize = (v) => String(v ?? "").trim();
const sameId = (a, b) => normalize(a) === normalize(b);

/* =========================================================
 *  PROMPT PAR DÉFAUT
 * =======================================================*/
const PROMPT_DEFAULT = `Rôle :
Tu es Pamela, l’assistante personnelle haut de gamme de la clinique de chirurgie esthétique.
Tu dialogues sur WhatsApp comme une assistante humaine expérimentée, chaleureuse et compétente.
⚠️ Tu n’es jamais une IA et tu ne dois jamais montrer ni envoyer la fiche lead au prospect. La fiche est réservée uniquement à l’usage interne de la clinique.

🎯 Style de communication

Messages courts, naturels, 1–2 phrases max.

Ton empathique, professionnel, haut de gamme. Émojis subtils (✨, 😊, 📅).

Tu valorises la clinique, tu rassures, tu crées de la confiance.

Pas de jargon médical compliqué, pas de diagnostic, pas de promesse de résultat.

Tu adaptes ton vocabulaire au niveau du prospect, comme une vraie assistante.

🗂 Structure de la conversation
1. Accueil & reconnaissance

“Bonjour et bienvenue ✨ Je note pour la [intervention citée]. Qu’est-ce qui vous motive le plus dans ce projet ?”

2. Écoute ouverte (anamnèse)

“Avant de parler organisation, souhaitez-vous que je vous explique un peu le processus ? Par exemple la durée de l’opération, la convalescence ou le suivi ?”

Tu réponds avec précision et clarté grâce à tes connaissances, mais toujours dans un style humain et accessible.

Exemple : “En général, une rhinoplastie dure entre 1h30 et 3h. Il faut ensuite prévoir quelques jours de repos, avec un suivi attentif du chirurgien.”

3. Relance d’écoute

“Est-ce que vous aviez d’autres questions avant que je prenne quelques informations pratiques pour le dossier ?”

4. Qualification progressive (en douceur, une question à la fois)

Objectif recherché (esthétique, correctif, autre).

Délai souhaité (urgent, 1–3 mois, 3–12 mois, plus tard).

Budget (demander subtilement, jamais en premier).

Antécédents pertinents (tabac, allergies, opérations récentes, maladies chroniques).

Identité : nom, prénom, âge.

Contact préféré (WhatsApp, appel, email).

⚠️ Règle : tu utilises la mémoire. Tu ne redemandes jamais une information déjà donnée.

5. Proposition de rendez-vous

“Je peux vous proposer un rendez-vous avec le chirurgien ou son assistante, en présentiel ou en visio 📅. Souhaitez-vous que je regarde les disponibilités ?”

🔥 Logique interne (jamais affichée au prospect)

CHAUD : budget clair + projet < 3 mois.

TIEDE : budget flou ou projet moyen terme.

FROID : curiosité, pas de budget ni de timing.

📝 Sortie interne (jamais envoyée au prospect)

À la fin de l’échange, remplir en interne uniquement la fiche suivante :

📋 Fiche lead

Nom :

Prénom :

Âge :

Contact : [WhatsApp / email / téléphone]

Type d’intervention :

Objectif :

Budget :

Timing :

Infos médicales :

Préférence de contact :

Catégorie lead : [CHAUD / TIEDE / FROID]

Commentaires utiles :
`;

/* =========================================================
 *  VARIATIONS DE QUESTIONS & PROFIL
 * =======================================================*/
const ASK_TEMPLATES = {
  intervention: [
    "Sur quelle intervention souhaitez-vous des infos en priorité ?",
    "Quelle intervention avez-vous en tête exactement ? 😊",
    "Vous penchez pour quelle intervention précisément ?",
  ],
  objectif: [
    "Quel est votre objectif principal (esthétique, correctif…)?",
    "Vous visez plutôt un rendu esthétique ou une correction précise ?",
  ],
  budget: [
    "Vous aviez un budget en tête (même approximatif) ?",
    "Quelle fourchette de budget envisagez-vous ?",
  ],
  timing: [
    "Pour le timing, c’est plutôt urgent, 1–3 mois, 3–12 mois ou plus tard ?",
    "Vous imaginez ça pour quand (urgent, 1–3 mois, 3–12 mois, plus tard) ?",
  ],
  medical: [
    "Des antécédents à signaler (grossesse, tabac, maladies, opérations, allergies) ?",
    "Côté santé, quelque chose à noter (tabac, maladies, opérations récentes) ?",
  ],
  identite: [
    "Je note, votre nom/prénom et votre âge ?",
    "Pouvez-vous me donner nom, prénom et âge pour le dossier ?",
  ],
  contact: [
    "On vous recontacte plutôt par WhatsApp, appel ou email ?",
    "Meilleur moyen de contact pour vous (WhatsApp/appel/email) ?",
  ],
  rdv: [
    "Je peux vous proposer un créneau (présentiel/visio) si vous voulez 📅",
    "Souhaitez-vous que je vous propose un RDV (visio/présentiel) ? 📅",
  ],
};
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

const ensureConversation = (db, convId, clientId) => {
  db.conversations ??= {};
  if (!db.conversations[convId]) {
    db.conversations[convId] = {
      messages: [],
      created_at: new Date().toISOString(),
      client_id: clientId,
      profile: {
        intervention: null,
        objectif: null,
        budget: null,
        timing: null,
        medical: null,
        identite: null,
        contact: null,
        lastAsked: null,
        lastAskedAt: 0,
      },
    };
  }
  return db.conversations[convId];
};

const extractInfo = (text, profile) => {
  const t = (text || "").toLowerCase();
  if (/greffe|implant|rhinoplast|lifting|botox|acide|liposuc/.test(t)) profile.intervention ??= text;
  const m = t.match(/(\d[\d\s]{1,6})\s?€|budget\s*(\d[\d\s]{1,6})/);
  if (m) profile.budget ??= (m[1] || m[2])?.trim();
  if (/urgent|asap|semaine/.test(t)) profile.timing ??= "urgent";
  if (/(1[-–]3|1 à 3)\s*mois/.test(t)) profile.timing ??= "1–3 mois";
  if (/(3[-–]12|3 à 12)\s*mois/.test(t)) profile.timing ??= "3–12 mois";
  if (/plus tard|> ?12/.test(t)) profile.timing ??= "plus tard";
  if (/grossesse|diab[eè]te|allerg|op[ée]r|tabac/.test(t)) profile.medical ??= text;
};

const nextField = (p) => {
  if (!p.intervention) return "intervention";
  if (!p.objectif) return "objectif";
  if (!p.budget) return "budget";
  if (!p.timing) return "timing";
  if (!p.medical) return "medical";
  if (!p.identite) return "identite";
  if (!p.contact) return "contact";
  return "rdv";
};

/* =========================================================
 *  CHECKOUT
 * =======================================================*/
app.post("/checkout/create", async (req, res) => {
  const startTime = Date.now();
  try {
    const { email } = req.body || {};
    if (email && !validateEmail(email)) {
      log.warn("Email invalide fourni", { email });
      return res.status(400).json({ error: "Email invalide" });
    }

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url:
        "https://app.beautyagent.ai/onboarding?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://beautyagent-ai-glow.lovable.app/#tarifs",
      customer_email: email,
      expires_at: Math.floor(Date.now() / 1000) + 24 * 60 * 60,
    });

    log.info("Session checkout créée", {
      sessionId: session.id,
      email,
      duration: Date.now() - startTime,
    });

    res.json({ url: session.url, session_id: session.id });
  } catch (error) {
    log.error("Erreur checkout", { error: error.message, stack: error.stack });
    res.status(500).json({ error: "Erreur lors de la création de la session" });
  }
});

/* =========================================================
 *  STRIPE WEBHOOK
 * =======================================================*/
app.post("/stripe-webhook", (req, res) => {
  let event;
  try {
    const sig = req.headers["stripe-signature"];
    if (!sig) {
      log.warn("Signature Stripe manquante");
      return res.status(400).json({ error: "Signature manquante" });
    }
    event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    log.debug("Webhook Stripe reçu", { type: event.type, id: event.id });
  } catch (error) {
    log.error("Erreur validation webhook Stripe", { error: error.message });
    return res.status(400).json({ error: "Signature invalide" });
  }

  try {
    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const db = readDB();

      const exists = db.clients.find((c) => c.id === session.id);
      if (exists) {
        log.warn("Client déjà existant", { sessionId: session.id });
        return res.sendStatus(200);
      }

      const newClient = {
        id: session.id,
        email: session.customer_details?.email || session.customer_email,
        status: "pending_onboarding",
        created_at: new Date().toISOString(),
        clinic: null,
        phone_number_id: null,
        wa_token: null,
        openai_key: null,
        prompt: null,
      };

      db.clients.push(newClient);
      writeDB(db);

      log.info("Nouveau client ajouté", { sessionId: session.id, email: newClient.email });
    }

    res.sendStatus(200);
  } catch (error) {
    log.error("Erreur traitement webhook", { error: error.message });
    res.sendStatus(500);
  }
});

/* =========================================================
 *  ONBOARDING
 * =======================================================*/
app.post("/onboarding/complete", async (req, res) => {
  try {
    const data = req.body || {};
    const validationError = validateSessionData(data);
    if (validationError) {
      log.warn("Données onboarding invalides", { error: validationError, data });
      return res.status(400).json({ error: validationError });
    }

    const {
      session_id,
      clinic_name,
      phone_number_id,
      wa_token,
      openai_key,
      prompt,
    } = data;

    const db = readDB();
    const client = db.clients.find((c) => c.id === session_id);
    if (!client) {
      log.warn("Session non trouvée", { session_id });
      return res.status(404).json({ error: "Session non trouvée" });
    }
    if (client.status === "active") {
      log.warn("Client déjà actif", { session_id });
      return res.status(409).json({ error: "Client déjà configuré" });
    }

    client.status = "active";
    client.clinic = clinic_name;
    client.phone_number_id = normalize(phone_number_id || DEFAULT_PHONE_NUMBER_ID);
    client.wa_token = wa_token || DEFAULT_WA_TOKEN;
    client.openai_key = openai_key || OPENAI_API_KEY;
    client.prompt = prompt || PROMPT_DEFAULT;
    client.updated_at = new Date().toISOString();

    writeDB(db);

    log.info("Onboarding complété", {
      session_id,
      clinic: clinic_name,
      hasCustomToken: !!wa_token,
      hasCustomOpenAI: !!openai_key,
    });

    res.json({ ok: true });
  } catch (error) {
    log.error("Erreur onboarding", { error: error.message, body: req.body });
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* =========================================================
 *  WEBHOOK VALIDATION
 * =======================================================*/
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = (req.query["hub.verify_token"] || "").trim();
  const challenge = req.query["hub.challenge"];

  log.debug("Validation webhook", { mode, token: token ? "***" : "absent" });

  if (mode === "subscribe" && token === expectedToken) {
    log.info("Webhook validé avec succès");
    return res.status(200).send(challenge);
  }

  log.warn("Échec validation webhook", { mode, tokenMatch: token === expectedToken });
  return res.sendStatus(403);
});

/* =========================================================
 *  WEBHOOK MESSAGES
 * =======================================================*/
app.post("/webhook", async (req, res) => {
  const startTime = Date.now();
  let conversationId = null;

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    const phoneNumberId = normalize(change?.metadata?.phone_number_id);
    const from = msg?.from;
    let text = msg?.text?.body?.trim() || "";

    conversationId = `${phoneNumberId}_${from}`;
    log.debug("Message WhatsApp reçu", {
      phoneNumberId,
      from,
      textLength: text.length,
      conversationId,
    });

    if (!from || !text || !phoneNumberId) {
      log.warn("Message incomplet", { from: !!from, text: !!text, phoneNumberId: !!phoneNumberId });
      return res.sendStatus(200);
    }

    const db = readDB();
    // Recherche client + fallback pour ne pas bloquer les tests
    let client = (db.clients ?? []).find(
      (c) => c.status === "active" && sameId(c.phone_number_id, phoneNumberId)
    );

    if (!client) {
      log.warn("Client non trouvé ou inactif", { phoneNumberId });
      client = {
        id: "fallback",
        status: "active",
        phone_number_id: phoneNumberId,
        wa_token: DEFAULT_WA_TOKEN,
        openai_key: OPENAI_API_KEY,
        prompt: PROMPT_DEFAULT,
      };
      // Pour éviter le warning à chaque message, dé-commente si tu veux persister :
      // db.clients.push(client);
      // writeDB(db);
    }

    const useToken = (client.wa_token || DEFAULT_WA_TOKEN || "").replace(/\s/g, "");
    const useOpenAI = (client.openai_key || OPENAI_API_KEY || "").trim();
    if (!useToken || !useOpenAI) {
      log.error("Tokens manquants", { hasWAToken: !!useToken, hasOpenAIKey: !!useOpenAI });
      return res.sendStatus(500);
    }

    const conv = ensureConversation(db, conversationId, client.id);
    conv.messages.push({ role: "user", content: text, timestamp: new Date().toISOString() });
    if (conv.messages.length > 20) conv.messages = conv.messages.slice(-10);

    const sysPrompt = client.prompt || PROMPT_DEFAULT;

    // Variations & profil
    extractInfo(text, conv.profile);
    let field = nextField(conv.profile);
    const now = Date.now();
    if (conv.profile.lastAsked === field && now - conv.profile.lastAskedAt < 15000) {
      const order = ["intervention", "objectif", "budget", "timing", "medical", "identite", "contact", "rdv"];
      field = order[(order.indexOf(field) + 1) % order.length];
    }
    conv.profile.lastAsked = field;
    conv.profile.lastAskedAt = now;

    const assistantHint = pick(ASK_TEMPLATES[field]);

    // Few-shot anti-répétitions
    const fewShot = [
      { role: "user", content: "Qui es tu ?" },
      { role: "assistant", content: "Je suis l’assistante IA de la clinique. Je vous aide à qualifier votre demande 😊" },
      { role: "user", content: "Je souhaite me renseigner pour une greffe de cheveux" },
      { role: "assistant", content: "Bien noté 😊 Quelles zones vous gênent le plus (golfes, tonsure, ligne frontale) ?" },
    ];

    const recent = conv.messages.slice(-6).map((m) => ({ role: m.role, content: m.content }));
    const messages = [{ role: "system", content: sysPrompt }, ...fewShot, ...recent, { role: "assistant", content: assistantHint }];

    // Anti “bonjour” vide
    const norm = text.toLowerCase();
    if (["bonjour", "salut", "hello"].includes(norm)) {
      messages.push({
        role: "assistant",
        content: "Bonjour 😊 Quelle intervention souhaitez-vous explorer en priorité ?",
      });
    }

    let reply = "Merci pour votre message, je reviens vers vous rapidement.";
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${useOpenAI}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "gpt-3.5-turbo", temperature: 0.3, max_tokens: 200, messages }),
      });
      if (!r.ok) throw new Error(`OpenAI: ${r.status} ${await r.text()}`);
      const result = await r.json();
      reply = result?.choices?.[0]?.message?.content?.slice(0, 1000) || reply;
      log.debug("Réponse OpenAI générée", { usage: result.usage, replyLength: reply.length });
    } catch (error) {
      log.error("Erreur OpenAI", { error: error.message });
      reply = "Je rencontre un petit souci technique, un conseiller va vous recontacter.";
    }

    conv.messages.push({ role: "assistant", content: reply, timestamp: new Date().toISOString() });
    conv.updated_at = new Date().toISOString();
    writeDB(db);

    const waResponse = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${useToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", to: from, type: "text", text: { body: reply } }),
    });
    if (!waResponse.ok) {
      const errorText = await waResponse.text();
      throw new Error(`WhatsApp API error: ${waResponse.status} - ${errorText}`);
    }

    log.info("Message envoyé avec succès", { conversationId, duration: Date.now() - startTime, replyLength: reply.length });
  } catch (error) {
    log.error("Erreur webhook messages", { error: error.message, conversationId, duration: Date.now() - startTime });
  }

  res.sendStatus(200);
});

/* =========================================================
 *  HEALTH & STATS
 * =======================================================*/
app.get("/health", (req, res) => {
  try {
    const db = readDB();
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      clients: db.clients.length,
      conversations: Object.keys(db.conversations || {}).length,
    });
  } catch (error) {
    log.error("Erreur health check", error);
    res.status(500).json({ status: "error", message: error.message });
  }
});

app.get("/stats", (req, res) => {
  try {
    const db = readDB();
    const stats = {
      total_clients: db.clients.length,
      active_clients: db.clients.filter((c) => c.status === "active").length,
      pending_clients: db.clients.filter((c) => c.status === "pending_onboarding").length,
      total_conversations: Object.keys(db.conversations || {}).length,
    };
    res.json(stats);
  } catch (error) {
    log.error("Erreur stats", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* =========================================================
 *  ERRORS & SHUTDOWN
 * =======================================================*/
app.use((error, req, res, next) => {
  log.error("Erreur non gérée", { error: error.message, stack: error.stack, url: req.url, method: req.method });
  res.status(500).json({ error: "Erreur serveur interne" });
});

process.on("uncaughtException", (error) => {
  log.error("Exception non capturée", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  log.error("Promise rejetée non gérée", { reason, promise });
});

const server = app.listen(port, () => {
  const db = readDB();
  log.info(`BeautyAgent démarré sur le port ${port}`, { env: NODE_ENV, clientsCount: db.clients.length });
});

process.on("SIGTERM", () => {
  log.info("Signal SIGTERM reçu, arrêt en cours...");
  server.close(() => {
    log.info("Serveur arrêté proprement");
    process.exit(0);
  });
});

export default app;


