import express from "express";
import fetch from "node-fetch";
import Stripe from "stripe";
import fs from "fs";

const app = express();

app.use("/stripe-webhook", express.raw({ type: "application/json" }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const DB_PATH = "./db.json";
if (!fs.existsSync(DB_PATH)) {
  fs.writeFileSync(DB_PATH, JSON.stringify({ clients: [] }, null, 2));
}
const readDB = () => JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
const writeDB = (data) =>
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));

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

const expectedToken = (VERIFY_TOKEN || "beautyagent_verify").trim();
const port = Number(PORT || 3000);
const stripe = new Stripe(STRIPE_SECRET);

/* ---------- CHECKOUT ---------- */
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

/* ---------- STRIPE WEBHOOK ---------- */
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

/* ---------- ONBOARDING ---------- */
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
      PROMPT_DEFAULT; // 👉 voir constante PROMPT_DEFAULT ci-dessous
    writeDB(db);

    res.json({ ok: true });
  } catch (e) {
    console.error("onboarding_error:", e);
    res.status(400).json({ error: "onboarding_error" });
  }
});

/* ---------- PROMPT PAR DÉFAUT ---------- */
const PROMPT_DEFAULT = `Tu es un agent conversationnel IA haut de gamme représentant une clinique de chirurgie esthétique.
Ton rôle : dialoguer sur WhatsApp avec des prospects et qualifier leur demande de manière fluide et naturelle, sans paraître mécanique.

Règles de style :
- Messages courts (1–2 phrases max).
- Ton chaleureux, haut de gamme, rassurant. Émojis légers (✨, 😊, 📅) mais jamais excessifs.
- Pas de jargon médical. Pas de diagnostic ni de promesse de résultat.
- Ne répète pas “Bonjour” à chaque message. Ne te représente pas si l’utilisateur t’a déjà identifié.
- Une seule question à la fois. Pas de questions génériques ; pose des questions ciblées liées à la dernière réponse.

Objectifs de qualification (les obtenir progressivement) :
- Type d’intervention souhaitée
- Objectif recherché (esthétique, correctif, autre)
- Budget (fourchette ou maximum)
- Timing (urgent, 1–3 mois, 3–12 mois, plus tard)
- Antécédents pertinents (grossesse, tabac, maladies chroniques, opérations récentes, allergies)
- Nom, prénom, âge
- Meilleur moyen de contact (WhatsApp, appel, email)

Logique de priorisation :
- CHAUD : budget clair + projet < 3 mois
- TIEDE : budget flou/limité ou projet à moyen terme
- FROID : curiosité, pas de budget ni de timing

Prochaine étape :
- Toujours proposer un RDV (présentiel/visio) avec le chirurgien ou son assistante dès que les infos clés sont suffisantes.

Cas fréquents :
- “Qui es-tu ?” → “Je suis l’assistante IA de la clinique. Je vous aide à qualifier votre demande 😊”
- Greffe de cheveux → demande les zones concernées (golfes, tonsure, ligne frontale), niveau de perte, âge, budget, timing, antécédents (traitements, tabac).

Sortie interne (à transmettre à l’assistante, ne pas l’envoyer au prospect) en fin d’échange :
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
  if (
    mode === "subscribe" &&
    (token === expectedToken || token === "beautyagent_verify")
  ) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/* ---------- WEBHOOK MESSAGES ---------- */
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const msg = change?.messages?.[0];
    const phoneNumberId = change?.metadata?.phone_number_id;
    const from = msg?.from;
    let text = msg?.text?.body || "";

    if (from && text && phoneNumberId) {
      const db = readDB();
      const client = (db.clients ?? []).find(
        (x) => x.phone_number_id === phoneNumberId && x.status === "active"
      );

      const useToken = (
        client?.wa_token ||
        DEFAULT_WA_TOKEN ||
        ""
      ).replace(/\s/g, "");
      const useOpenAI = (client?.openai_key || OPENAI_API_KEY || "").trim();

      const sysPrompt = client?.prompt || PROMPT_DEFAULT;

      // Few-shot pour guider l’IA
      const fewShot = [
        { role: "user", content: "Qui es tu ?" },
        {
          role: "assistant",
          content:
            "Je suis l’assistante IA de la clinique. Je vous aide à qualifier votre demande 😊",
        },
        { role: "user", content: "Je souhaite me renseigner pour une greffe de cheveux" },
        {
          role: "assistant",
          content:
            "Bien noté 😊 Quelles zones vous gênent le plus (golfes, tonsure, ligne frontale) ?",
        },
      ];

      const messages = [
        { role: "system", content: sysPrompt },
        ...fewShot,
        { role: "user", content: text },
      ];

      // Garde-fou anti-salutations vides
      const normalized = text.toLowerCase().trim();
      if (["bonjour", "salut", "hello"].includes(normalized)) {
        messages.push({
          role: "assistant",
          content:
            "Bonjour 😊 Je suis l’assistante IA de la clinique. Quelle intervention souhaitez-vous explorer en priorité ?",
        });
      }

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
              temperature: 0.3,
              max_tokens: 200,
              messages,
            }),
          }
        ).then((r) => r.json());

        reply =
          completion?.choices?.[0]?.message?.content?.slice(0, 1000) || reply;
      } catch (e) {
        console.error("openai_error:", e);
      }

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
    res.sendStatus(200);
  } catch (e) {
    console.error("whatsapp_webhook_error:", e);
    res.sendStatus(200);
  }
});

/* ---------- HEALTH CHECK ---------- */
app.get("/", (_req, res) => res.send("BeautyAgent OK"));

app.listen(port, () => {
  console.log(`BeautyAgent running on port ${port}`);
});
