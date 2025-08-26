import express from "express";
import fetch from "node-fetch";
import Stripe from "stripe";
import fs from "fs";

const app = express();

/* Stripe veut le body brut pour vérifier la signature */
app.use("/stripe-webhook", express.raw({ type: "application/json" }));
/* JSON normal pour le reste */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/* Mini base JSON locale */
const DB_PATH = "./db.json";
if (!fs.existsSync(DB_PATH)) {
  fs.writeFileSync(DB_PATH, JSON.stringify({ clients: [] }, null, 2));
}
const readDB = () => JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
const writeDB = (data) =>
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));

/* Variables d’environnement */
const {
  PORT,
  STRIPE_SECRET,
  STRIPE_PRICE_ID,
  STRIPE_WEBHOOK_SECRET,
  VERIFY_TOKEN,
  OPENAI_API_KEY,
  DEFAULT_WA_TOKEN,
  DEFAULT_PHONE_NUMBER_ID,
} = process.env;

// Token attendu : valeur définie dans VERIFY_TOKEN ou, à défaut, "beautyagent_verify"
const expectedToken = (VERIFY_TOKEN || "beautyagent_verify").trim();

// Port d’écoute (Render fournit automatiquement PORT dans l’environnement)
const port = Number(PORT || 3000);

// Instance Stripe
const stripe = new Stripe(STRIPE_SECRET);

/* 1) Création d’une session Checkout (abonnement) */
app.post("/checkout/create", async (req, res) => {
  try {
    const { email } = req.body || {};
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url:
        "https://app.beautyagent.ai/onboarding?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://beautyagent-ai-glow.lovable.app/#tarifs",
      customer_email: email,
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error("checkout_error:", e);
    res.status(400).json({ error: "checkout_error" });
  }
});

/* 2) Webhook Stripe */
app.post("/stripe-webhook", (req, res) => {
  try {
    const sig = req.headers["stripe-signature"];
    const event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      STRIPE_WEBHOOK_SECRET
    );

    if (event.type === "checkout.session.completed") {
      const s = event.data.object;
      const db = readDB();
      db.clients ??= [];
      db.clients.push({
        id: s.id,
        email: s.customer_details?.email || s.customer_email,
        status: "pending_onboarding",
        clinic: null,
        phone_number_id: null,
        wa_token: null,
        openai_key: null,
        prompt: null,
      });
      writeDB(db);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("stripe_webhook_error:", err?.message);
    res.sendStatus(400);
  }
});

/* 3) Fin d’onboarding pour un client */
app.post("/onboarding/complete", async (req, res) => {
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
    const c = (db.clients ??= []).find((x) => x.id === session_id);
    if (!c) return res.status(404).json({ error: "session_not_found" });

    c.status = "active";
    c.clinic = clinic_name;
    c.phone_number_id = phone_number_id || DEFAULT_PHONE_NUMBER_ID;
    c.wa_token = wa_token || DEFAULT_WA_TOKEN;
    c.openai_key = openai_key || OPENAI_API_KEY;
    c.prompt =
      prompt ||
      `Tu es Sarah de la clinique ${clinic_name}. Tu es un agent conversationnel IA haut de gamme spécialisé en chirurgie esthétique.  
Ta mission est de qualifier chaque prospect de manière fluide, naturelle et professionnelle, afin d’offrir au chirurgien et à son assistante un dossier clair et priorisé.  

Objectifs principaux :  
1. Répondre avec précision, pédagogie et tact aux questions fréquentes sur la chirurgie esthétique (procédures, déroulement, délais, récupération, prix indicatifs, etc.) sans jamais donner de conseil médical définitif.  
2. Obtenir les informations clés suivantes pour chaque prospect :  
   - Type de chirurgie ou traitement souhaité (ex. rhinoplastie, lifting, implants mammaires, liposuccion, botox, etc.).  
   - Objectif recherché (esthétique, correctif, fonctionnel).  
   - Budget disponible (fourchette ou montant maximal).  
   - Délai ou timing souhaité (urgent, 1-3 mois, plus de 6 mois).  
   - Antécédents médicaux pertinents ou contre-indications connues (grossesse, maladies chroniques, opérations récentes, allergies, tabac…).  
   - Coordonnées complètes (nom, prénom, âge, email, téléphone).  
   - Préférence de contact (appel, WhatsApp, email).  
3. Classer automatiquement le prospect dans une des catégories suivantes :  
   - **Lead chaud** : budget clair et suffisant + projet dans les 3 mois + décision quasi prise.  
   - **Lead tiède** : budget flou ou insuffisant mais projet réel / timing plus long (3-12 mois).  
   - **Lead froid** : simple curiosité, pas de budget, pas de timing précis.  

Contraintes :  
- Adopte un ton rassurant, professionnel et haut de gamme, comme le ferait un coordinateur de clinique de chirurgie esthétique.  
- Ne propose jamais de diagnostic médical, uniquement des explications générales.  
- Mets en avant la disponibilité du chirurgien et l’accompagnement sur mesure de la clinique.  
- Termine la conversation en proposant de fixer un rendez-vous de consultation (présentiel ou visio) avec le chirurgien ou son assistante.  

Sortie attendue :  
À la fin de chaque conversation, génère un **fiche lead structurée** sous ce format :  

Nom :  
Prénom :  
Âge :  
Contact : [email/téléphone/WhatsApp]  
Type de chirurgie demandé :  
Objectif :  
Budget :  
Timing :  
Infos médicales pertinentes :  
Préférence de contact :  
Catégorie lead : [CHAUD / TIEDE / FROID]  
Commentaires utiles pour l’assistante :  
`;
    writeDB(db);

    res.json({ ok: true });
  } catch (e) {
    console.error("onboarding_error:", e);
    res.status(400).json({ error: "onboarding_error" });
  }
});

/* 4) Webhook WhatsApp (validation et réception des messages) */
// Validation du webhook (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = (req.query["hub.verify_token"] || "").trim();
  const challenge = req.query["hub.challenge"];
  if (
    mode === "subscribe" &&
    (token === expectedToken || token === "beautyagent_verify")
  ) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Réception des messages WhatsApp (POST)
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    const phoneNumberId = change?.metadata?.phone_number_id;
    const from = msg?.from;
    const text = msg?.text?.body || "";

    if (from && text && phoneNumberId) {
      // Cherche un client actif correspondant au numéro
      const db = readDB();
      const client = (db.clients ?? []).find(
        (x) => x.phone_number_id === phoneNumberId && x.status === "active"
      );

      // Nettoie le token pour éviter les caractères invalides
      const useToken = (
        client?.wa_token ||
        DEFAULT_WA_TOKEN ||
        ""
      ).replace(/\s/g, "");
      const useOpenAI = (client?.openai_key || OPENAI_API_KEY || "").trim();
      const sysPrompt =
        client?.prompt ||
        "Tu es BeautyAgent. Qualifie le prospect et propose un rendez-vous.";

      // Génère une réponse avec OpenAI (modèle gpt-3.5-turbo)
      let reply = "Merci pour votre message.";
      try {
        const completion = await fetch(
          "https://api.openai.com/v1/chat/completions",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${useOpenAI}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              model: "gpt-3.5-turbo",
              max_tokens: 200,
              temperature: 0.4,
              messages: [
                { role: "system", content: sysPrompt },
                { role: "user", content: text },
              ],
            }),
          }
        ).then((r) => r.json());
        reply =
          completion?.choices?.[0]?.message?.content?.slice(0, 1000) || reply;
      } catch (e) {
        console.error("openai_error:", e);
      }

      // Envoi de la réponse via l’API WhatsApp
      await fetch(
        `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${useToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: `+${from}`,
            type: "text",
            text: { body: reply },
          }),
        }
      );
    }
    // Répond immédiatement à WhatsApp (important)
    res.sendStatus(200);
  } catch (e) {
    console.error("whatsapp_webhook_error:", e);
    res.sendStatus(200);
  }
});

/* 5) Route de health check */
app.get("/", (_req, res) => res.send("BeautyAgent OK"));

/* Démarrage du serveur */
app.listen(port, () => {
  console.log(`BeautyAgent running on port ${port}`);
});

