// server.js — BeautyAgent (version simplifiée 100% ChatGPT)

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

const normalizeS = (v) => String(v ?? "").trim();
const sameId = (a, b) => normalizeS(a) === normalizeS(b);

/* =========================================================
 *  PROMPT PAR DÉFAUT (corrigé)
 * =======================================================*/
const PROMPT_DEFAULT = `Tu es Pamela, assistante humaine de la clinique (jamais IA).
Objectif : conseiller d’abord, qualifier ensuite. Jamais de fiche/récap interne vers le prospect.

Style:
- Messages courts (1–2 phrases), ton premium, rassurant. Émojis discrets (✨, 😊, 📅).
- Pas de jargon, pas de diagnostic, pas de promesse. Pas de vocabulaire administratif (“dossier”).

Règles:
- Ne JAMAIS inventer l’intervention ou une info non donnée. Si rien n’est précisé, demander: “Quel projet esthétique aviez-vous en tête ?”.
- Anamnèse AVANT la qualification: proposer d’expliquer le process (durée, convalescence, suivi) et répondre précisément en langage simple.
- Poser UNE question à la fois. Ne jamais reposer une info déjà fournie.
- Ne pas proposer de RDV tant que (intervention + timing) ne sont pas renseignés.
- La fiche lead est INTERNE. Ne JAMAIS l’envoyer ni produire un tableau/puces “Nom:, Prénom:, Budget:” côté prospect.

Flux:
1) Accueil + projet.
2) Anamnèse ouverte (“Souhaitez-vous que je vous explique le déroulé (durée, convalescence, suivi) ?” + réponses claires).
3) Qualification douce: objectif → timing → budget → antécédents pertinents → prénom/nom/âge → contact préféré.
4) Proposition RDV quand prêt.

Sortie attendue côté prospect: uniquement des messages conversationnels naturels.
Sortie interne (stockée par le système, jamais affichée): {nom, prénom, âge, contact, intervention, objectif, budget, timing, infos_médicales, préférence_contact, catégorie: [CHAUD|TIEDE|FROID], commentaires}.
`;

/* =========================================================
 *  EXTRACTION + CATEGORISATION
 * =======================================================*/
const normalize = (s) => (s || "").toLowerCase().normalize("NFKD").replace(/[’']/g,"'");
const euroToNumber = (s) => {
  if (!s) return null;
  let x = s.replace(/\s/g,"").toLowerCase();
  const k = x.match(/^(\d+(?:[.,]\d+)?)k$/);
  if (k) return Math.round(parseFloat(k[1].replace(",",".")) * 1000);
  x = x.replace(/[€]|euros?/g,"").replace(/,/g,".");
  const n = parseFloat(x);
  return isNaN(n) ? null : Math.round(n);
};

const extractInfo = (text, profile) => {
  const raw = text || "";
  const t = normalize(raw);

  // Intervention
  if (/(greffe|implant|fue|rhinoplast|septoplast|lifting|bl[eé]pharo|abdominoplast|liposuc|liposuccion|lipofilling|otoplast|botox|toxine|acide hyal|hyaluronique|peeling|laser|augmentation mammaire|mastopexie|reduction mammaire|réduction mammaire|gynecomastie|gyn[eé]comastie|proth[eè]se mammaire)/.test(t)) {
    profile.intervention ??= raw;
  }

  // Anamnèse détectée si le patient pose des questions de process
  if (/(dur[eé]e|convalescence|r[ée]cup[ée]ration|douleur|cicat|arr[êe]t de travail|suivi|processus|op[ée]ration)/.test(t)) {
    profile.anamneseDone = true;
  }

  // Objectif
  if (/(esthetique|esthétique|harmonie|volume|rides|cicatrices|correction|deviation|fonctionnel|respirer|asym[eé]trie)/.test(t)) {
    profile.objectif ??= raw;
  }

  // Budget
  let b = null;
  const brange = t.match(/(?:entre|de)\s+(\d[\d\s.,k]+)\s+(?:a|et)\s+(\d[\d\s.,k]+)/);
  const b1 = t.match(/(?:budget|max|jusqu'?a)\s*(\d[\d\s.,k]+)/);
  const b2 = t.match(/(\d[\d\s.,k]+)\s*(?:€|euros?)/);
  if (brange) {
    const n1 = euroToNumber(brange[1]);
    const n2 = euroToNumber(brange[2]);
    if (n1 && n2) b = { min: Math.min(n1,n2), max: Math.max(n1,n2) };
  } else if (b1) {
    const n = euroToNumber(b1[1]);
    if (n) b = { max: n };
  } else if (b2) {
    const n = euroToNumber(b2[1]);
    if (n) b = { approx: n };
  }
  if (b && !profile.budget) profile.budget = b;

  // Timing
  if (/urgent|asap|semaine|ce mois|prochain mois|au plus vite/.test(t)) profile.timing ??= "urgent";
  if (/(1\s*[–-]\s*3|1 a 3|1 à 3)\s*mois/.test(t)) profile.timing ??= "1–3 mois";
  if (/(3\s*[–-]\*?12|3 a 12|3 à 12)\s*mois/.test(t)) profile.timing ??= "3–12 mois";
  if (/plus tard|apres|après|> ?12|l'an prochain|l an prochain|annee prochaine|année prochaine/.test(t)) profile.timing ??= "plus tard";

  // Médical
  if (/(grossesse|enceinte|allerg|diab[eè]te|cardiaque|thyro[iî]de|asthme|anticoagulant|immuno|operation|op[ée]r|chirurgie|cicatrice|tabac|fumeur|traitement|hormon)/.test(t)) {
    profile.medical ??= raw;
  }

  // Identité
  const age = t.match(/(\d{2})\s*ans/);
  const email = t.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/);
  const phone = t.match(/(\+?\d[\d\s.-]{7,}\d)/);
  if (!profile.identite) {
    const name1 = t.match(/je m'appelle\s+([a-zà-öø-ÿ'-]+\s+[a-zà-öø-ÿ'-]+)/);
    const name2 = t.match(/moi c'?est\s+([a-zà-öø-ÿ'-]+\s+[a-zà-öø-ÿ'-]+)/);
    const full = (name1?.[1] || name2?.[1] || "").trim();
    if (full || age) {
      const parts = full.split(/\s+/);
      profile.identite = {
        nom: parts.length > 1 ? parts[parts.length-1] : null,
        prenom: parts.length > 1 ? parts.slice(0,-1).join(" ") : (full || null),
        age: age ? parseInt(age[1],10) : null
      };
    }
  } else if (age && !profile.identite.age) {
    profile.identite.age = parseInt(age[1],10);
  }

  // Contact préféré
  if (email && !profile.contact) profile.contact = { mode: "email", valeur: email[0] };
  if (phone && !profile.contact) profile.contact = { mode: "téléphone", valeur: phone[1].replace(/\s+/g," ") };
  if (/whatsapp/.test(t) && !profile.contact) profile.contact = { mode: "WhatsApp", valeur: null };
};

const leadCategory = (p) => {
  const bud = p.budget && (p.budget.max || p.budget.approx || p.budget.min);
  if (bud && (p.timing === "urgent" || p.timing === "1–3 mois")) return "CHAUD";
  if (!bud || p.timing === "3–12 mois") return "TIEDE";
  return "FROID";
};

/* ===== SANITIZE RÉPONSE POUR BLOQUER LA FICHE LEAD ===== */
const sanitizeReply = (s = "") => {
  const marker =
    /(📋|^)\s*fiche\s*lead|^nom\s*:|^pr[ée]nom\s*:|^budget\s*:|^timing\s*:|^infos?\s*m[ée]dicales?\s*:|^contact\s*:/im;
  if (!marker.test(s)) return s;
  s = s.replace(/(?:📋[\s\S]*$)/i, "");
  s = s.replace(/^.*?(nom\s*:|pr[ée]nom\s*:|budget\s*:|timing\s*:|infos?\s*m[ée]dicales?\s*:|contact\s*:)[\s\S]*$/im, "");
  return "Merci, je garde vos informations en interne. Préférez-vous que je réponde d’abord à vos questions, ou que je regarde des disponibilités 📅 ?";
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
    client.phone_number_id = normalizeS(phone_number_id || DEFAULT_PHONE_NUMBER_ID);
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
 *  WEBHOOK MESSAGES — 100% CHATGPT
 * =======================================================*/
app.post("/webhook", async (req, res) => {
  const startTime = Date.now();
  let conversationId = null;

  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    const phoneNumberId = normalizeS(change?.metadata?.phone_number_id);
    const from = msg?.from;
    const text = (msg?.text?.body || "").trim();

    conversationId = `${phoneNumberId}_${from}`;
    log.debug("Message WhatsApp reçu", { phoneNumberId, from, textLength: text.length, conversationId });

    if (!from || !text || !phoneNumberId) {
      log.warn("Message incomplet", { from: !!from, text: !!text, phoneNumberId: !!phoneNumberId });
      return res.sendStatus(200);
    }

    const db = readDB();
    // client actif sinon fallback
    let client = (db.clients ?? []).find(
      (c) => c.status === "active" && sameId(c.phone_number_id, phoneNumberId)
    ) || {
      id: "fallback",
      status: "active",
      phone_number_id: phoneNumberId,
      wa_token: DEFAULT_WA_TOKEN,
      openai_key: OPENAI_API_KEY,
      prompt: PROMPT_DEFAULT,
    };

    const useToken = (client.wa_token || DEFAULT_WA_TOKEN || "").replace(/\s/g, "");
    const useOpenAI = (client.openai_key || OPENAI_API_KEY || "").trim();
    if (!useToken || !useOpenAI) {
      log.error("Tokens manquants", { hasWAToken: !!useToken, hasOpenAIKey: !!useOpenAI });
      return res.sendStatus(500);
    }

    const conv = ensureConversation(db, conversationId, client.id);
    conv.messages.push({ role: "user", content: text, timestamp: new Date().toISOString() });
    if (conv.messages.length > 40) conv.messages = conv.messages.slice(-20);

    // MAJ fiche interne
    conv.profile ??= { anamneseDone: false };
    extractInfo(text, conv.profile);

    const recent = conv.messages.slice(-12).map(m => ({ role: m.role, content: m.content }));
    const dynamicGuard = [
      "Ne pas avancer si le prospect n’a pas précisé son projet.",
      conv.profile.intervention
        ? `Intervention actuelle: ${conv.profile.intervention}. Rester strictement sur ce sujet.`
        : "Aucune intervention encore. Demander le projet sans le deviner."
    ].join("\n");

    const messages = [
      { role: "system", content: (client.prompt || PROMPT_DEFAULT) + "\n\n" + dynamicGuard },
      ...recent
    ];

    let reply = "Merci pour votre message, je reviens vers vous rapidement.";
    try {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${useOpenAI}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.3,
          max_tokens: 220,
          messages
        }),
      });
      if (!r.ok) throw new Error(`OpenAI: ${r.status} ${await r.text()}`);
      const result = await r.json();
      reply = result?.choices?.[0]?.message?.content?.slice(0, 1000) || reply;
      reply = sanitizeReply(reply);
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
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: { body: reply }
      }),
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
 *  API LEADS
 * =======================================================*/
app.get("/leads", (req, res) => {
  try {
    const db = readDB();
    const leads = Object.entries(db.conversations || {}).map(([convId, conv]) => {
      const p = conv.profile || {};
      return {
        conversation_id: convId,
        created_at: conv.created_at,
        updated_at: conv.updated_at,
        nom: p.identite?.nom || null,
        prenom: p.identite?.prenom || null,
        age: p.identite?.age || null,
        intervention: p.intervention || null,
        objectif: p.objectif || null,
        budget: p.budget || null,
        timing: p.timing || null,
        infos_medicales: p.medical || null,
        contact: p.contact || null,
        categorie: leadCategory(p),
        commentaires: (conv.messages || []).slice(-3).map(m => m.content).join(" | ")
      };
    });
    res.json(leads);
  } catch (error) {
    log.error("Erreur récupération leads", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
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
