import express from "express";
import fetch from "node-fetch";
import Stripe from "stripe";
import fs from "fs";
import path from "path";

const app = express();

// Configuration du logging
const log = {
  info: (msg, data = {}) => console.log(`[INFO] ${msg}`, data),
  error: (msg, error = {}) => console.error(`[ERROR] ${msg}`, error),
  debug: (msg, data = {}) => process.env.NODE_ENV === 'development' && console.log(`[DEBUG] ${msg}`, data),
  warn: (msg, data = {}) => console.warn(`[WARN] ${msg}`, data)
};

// Middleware avec logging
app.use("/stripe-webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Validation des variables d'environnement
const requiredEnvVars = ['STRIPE_SECRET', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET'];
const missingVars = requiredEnvVars.filter(varName => !process.env[varName]);

if (missingVars.length > 0) {
  log.error(`Variables d'environnement manquantes: ${missingVars.join(', ')}`);
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
  NODE_ENV = 'production'
} = process.env;

const expectedToken = VERIFY_TOKEN.trim();
const port = Number(PORT);
const stripe = new Stripe(STRIPE_SECRET);

// Gestion de la base de données avec validation
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
    // Validation de la structure
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
    // Sauvegarde atomique
    const tempPath = `${DB_PATH}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
    fs.renameSync(tempPath, DB_PATH);
    log.debug("DB sauvegardée");
  } catch (error) {
    log.error("Erreur écriture DB", error);
    throw error;
  }
};

// Validation des entrées
const validateEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

const validateSessionData = (data) => {
  const required = ['session_id'];
  const missing = required.filter(field => !data[field]);
  return missing.length === 0 ? null : `Champs manquants: ${missing.join(', ')}`;
};

initDB();

/* ---------- CHECKOUT ---------- */
app.post("/checkout/create", async (req, res) => {
  const startTime = Date.now();
  try {
    const { email } = req.body || {};
    
    // Validation
    if (email && !validateEmail(email)) {
      log.warn("Email invalide fourni", { email });
      return res.status(400).json({ error: "Email invalide" });
    }

    log.debug("Création session checkout", { email });

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: "https://app.beautyagent.ai/onboarding?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://beautyagent-ai-glow.lovable.app/#tarifs",
      customer_email: email,
      expires_at: Math.floor(Date.now() / 1000) + (24 * 60 * 60), // Expire dans 24h
    });

    log.info("Session checkout créée", { 
      sessionId: session.id, 
      email, 
      duration: Date.now() - startTime 
    });

    res.json({ url: session.url, session_id: session.id });
  } catch (error) {
    log.error("Erreur checkout", { error: error.message, stack: error.stack });
    res.status(500).json({ error: "Erreur lors de la création de la session" });
  }
});

/* ---------- STRIPE WEBHOOK ---------- */
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
      
      // Vérifier si le client existe déjà
      const existingClient = db.clients.find(c => c.id === session.id);
      if (existingClient) {
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

      log.info("Nouveau client ajouté", { 
        sessionId: session.id, 
        email: newClient.email 
      });
    }

    res.sendStatus(200);
  } catch (error) {
    log.error("Erreur traitement webhook", { error: error.message });
    res.sendStatus(500);
  }
});

/* ---------- ONBOARDING ---------- */
app.post("/onboarding/complete", async (req, res) => {
  try {
    const data = req.body || {};
    
    // Validation des données
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
    const client = db.clients.find(c => c.id === session_id);
    
    if (!client) {
      log.warn("Session non trouvée", { session_id });
      return res.status(404).json({ error: "Session non trouvée" });
    }

    if (client.status === "active") {
      log.warn("Client déjà actif", { session_id });
      return res.status(409).json({ error: "Client déjà configuré" });
    }

    // Mise à jour du client
    client.status = "active";
    client.clinic = clinic_name;
    client.phone_number_id = phone_number_id || DEFAULT_PHONE_NUMBER_ID;
    client.wa_token = wa_token || DEFAULT_WA_TOKEN;
    client.openai_key = openai_key || OPENAI_API_KEY;
    client.prompt = prompt || PROMPT_DEFAULT;
    client.updated_at = new Date().toISOString();

    writeDB(db);

    log.info("Onboarding complété", { 
      session_id, 
      clinic: clinic_name,
      hasCustomToken: !!wa_token,
      hasCustomOpenAI: !!openai_key 
    });

    res.json({ ok: true });
  } catch (error) {
    log.error("Erreur onboarding", { error: error.message, body: req.body });
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ---------- PROMPT PAR DÉFAUT ---------- */
const PROMPT_DEFAULT = `Tu es Pamela, l’assistante personnelle de la clinique de chirurgie esthétique.
Ton rôle : échanger sur WhatsApp comme une assistante humaine expérimentée et chaleureuse, jamais comme une IA.

🎯 Style de communication

Messages courts, naturels, toujours en 1–2 phrases.

Ton empathique, professionnel, haut de gamme, avec un petit sourire ou un emoji subtil pour créer de la proximité (✨, 😊, 📅).

Évite tout langage robotique (pas de formulations mécaniques ni de répétitions inutiles).

Tu adaptes ton vocabulaire au prospect, comme une vraie assistante qui comprend et s’intéresse sincèrement.

Pas de jargon médical, pas de diagnostic, pas de promesse de résultat.

🗂 Qualification progressive

Tu obtiens les informations essentielles comme dans une vraie conversation humaine, en douceur, question par question :

Type d’intervention souhaitée.

Objectif recherché (esthétique, correctif, autre).

Budget (fourchette ou maximum).

Délai souhaité (urgent, 1–3 mois, 3–12 mois, plus tard).

Antécédents pertinents (grossesse, tabac, maladies chroniques, opérations récentes, allergies).

Identité : nom, prénom, âge.

Meilleur moyen de contact (WhatsApp, appel, email).

🔥 Logique de lead

CHAUD : budget clair + projet < 3 mois.

TIEDE : budget flou ou projet moyen terme.

FROID : curiosité, pas de budget ni de timing.

📌 Étape finale

Quand tu as assez d’infos, propose naturellement un RDV avec le chirurgien ou son assistante (présentiel ou visio).

⚡ Gestion de cas fréquents

"Qui es-tu ?" → "Je suis Pamela, l’assistante de la clinique. Je suis là pour vous guider et comprendre votre demande 😊"

Greffe de cheveux → demander zones concernées (golfes, tonsure, ligne frontale), niveau de perte, âge, budget, timing, antécédents (traitements, tabac).

📝 Sortie interne (jamais envoyée au prospect)

En fin d’échange, remplis cette fiche :

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

/* ---------- WEBHOOK VALIDATION ---------- */
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

/* ---------- WEBHOOK MESSAGES ---------- */
app.post("/webhook", async (req, res) => {
  const startTime = Date.now();
  let conversationId = null;
  
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    const phoneNumberId = change?.metadata?.phone_number_id;
    const from = msg?.from;
    const text = msg?.text?.body?.trim() || "";

    conversationId = `${phoneNumberId}_${from}`;
    
    log.debug("Message WhatsApp reçu", { 
      phoneNumberId, 
      from, 
      textLength: text.length,
      conversationId 
    });

    if (!from || !text || !phoneNumberId) {
      log.warn("Message incomplet", { from: !!from, text: !!text, phoneNumberId: !!phoneNumberId });
      return res.sendStatus(200);
    }

    const db = readDB();
    const client = db.clients.find(
      c => c.phone_number_id === phoneNumberId && c.status === "active"
    );

    if (!client) {
      log.warn("Client non trouvé ou inactif", { phoneNumberId });
      return res.sendStatus(200);
    }

    const useToken = (client.wa_token || DEFAULT_WA_TOKEN || "").replace(/\s/g, "");
    const useOpenAI = (client.openai_key || OPENAI_API_KEY || "").trim();

    if (!useToken || !useOpenAI) {
      log.error("Tokens manquants", { 
        hasWAToken: !!useToken, 
        hasOpenAIKey: !!useOpenAI 
      });
      return res.sendStatus(500);
    }

    // Gestion de l'historique des conversations
    if (!db.conversations[conversationId]) {
      db.conversations[conversationId] = {
        messages: [],
        created_at: new Date().toISOString(),
        client_id: client.id
      };
    }

    const conversation = db.conversations[conversationId];
    conversation.messages.push({
      role: "user",
      content: text,
      timestamp: new Date().toISOString()
    });

    // Limiter l'historique (garder les 10 derniers messages)
    if (conversation.messages.length > 20) {
      conversation.messages = conversation.messages.slice(-10);
    }

    const sysPrompt = client.prompt || PROMPT_DEFAULT;
    
    // Few-shot examples
    const fewShot = [
      { role: "user", content: "Qui es tu ?" },
      { role: "assistant", content: "Je suis l'assistante IA de la clinique. Je vous aide à qualifier votre demande 😊" },
      { role: "user", content: "Je souhaite me renseigner pour une greffe de cheveux" },
      { role: "assistant", content: "Bien noté 😊 Quelles zones vous gênent le plus (golfes, tonsure, ligne frontale) ?" },
    ];

    // Construction du contexte avec historique récent
    const recentMessages = conversation.messages.slice(-6); // 6 derniers messages
    const messages = [
      { role: "system", content: sysPrompt },
      ...fewShot,
      ...recentMessages
    ];

    let reply = "Merci pour votre message, je reviens vers vous rapidement.";
    
    try {
      log.debug("Appel OpenAI", { messagesCount: messages.length });
      
      const completion = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${useOpenAI}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-3.5-turbo",
          temperature: 0.3,
          max_tokens: 200,
          messages,
        }),
      });

      if (!completion.ok) {
        const errorText = await completion.text();
        throw new Error(`OpenAI API error: ${completion.status} - ${errorText}`);
      }

      const result = await completion.json();
      reply = result?.choices?.[0]?.message?.content?.slice(0, 1000) || reply;
      
      log.debug("Réponse OpenAI générée", { 
        replyLength: reply.length,
        usage: result.usage 
      });

    } catch (error) {
      log.error("Erreur OpenAI", { error: error.message });
      reply = "Je rencontre un problème technique, un conseiller va vous recontacter.";
    }

    // Enregistrer la réponse dans l'historique
    conversation.messages.push({
      role: "assistant",
      content: reply,
      timestamp: new Date().toISOString()
    });

    conversation.updated_at = new Date().toISOString();
    writeDB(db);

    // Envoi du message WhatsApp
    const waResponse = await fetch(
      `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${useToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: from,
          type: "text",
          text: { body: reply },
        }),
      }
    );

    if (!waResponse.ok) {
      const errorText = await waResponse.text();
      throw new Error(`WhatsApp API error: ${waResponse.status} - ${errorText}`);
    }

    log.info("Message envoyé avec succès", {
      conversationId,
      duration: Date.now() - startTime,
      replyLength: reply.length
    });

  } catch (error) {
    log.error("Erreur webhook messages", { 
      error: error.message, 
      conversationId,
      duration: Date.now() - startTime 
    });
  }

  res.sendStatus(200);
});

/* ---------- API ENDPOINTS POUR MONITORING ---------- */
app.get("/health", (req, res) => {
  try {
    const db = readDB();
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      clients: db.clients.length,
      conversations: Object.keys(db.conversations || {}).length
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
      active_clients: db.clients.filter(c => c.status === 'active').length,
      pending_clients: db.clients.filter(c => c.status === 'pending_onboarding').length,
      total_conversations: Object.keys(db.conversations || {}).length,
    };
    res.json(stats);
  } catch (error) {
    log.error("Erreur stats", error);
    res.status(500).json({ error: "Erreur serveur" });
  }
});

/* ---------- GESTION DES ERREURS ---------- */
app.use((error, req, res, next) => {
  log.error("Erreur non gérée", { 
    error: error.message, 
    stack: error.stack,
    url: req.url,
    method: req.method 
  });
  res.status(500).json({ error: "Erreur serveur interne" });
});

// Gestion des erreurs non capturées
process.on('uncaughtException', (error) => {
  log.error("Exception non capturée", error);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  log.error("Promise rejetée non gérée", { reason, promise });
});

/* ---------- DÉMARRAGE DU SERVEUR ---------- */
const server = app.listen(port, () => {
  log.info(`BeautyAgent démarré sur le port ${port}`, {
    env: NODE_ENV,
    clientsCount: readDB().clients.length
  });
});

// Arrêt propre
process.on('SIGTERM', () => {
  log.info('Signal SIGTERM reçu, arrêt en cours...');
  server.close(() => {
    log.info('Serveur arrêté proprement');
    process.exit(0);
  });
});

export default app;
