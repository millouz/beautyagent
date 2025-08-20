import express from "express";
import fetch from "node-fetch";
import Stripe from "stripe";
import fs from "fs";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Simple JSON file DB
const DB_PATH = "./db.json";
const readDB = () => JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
const writeDB = (data) => fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));

// ENV
const {
  PORT = 3000,
  STRIPE_SECRET,
  STRIPE_PRICE_ID,
  STRIPE_WEBHOOK_SECRET,
  VERIFY_TOKEN = "beautyagent_verify",
  OPENAI_API_KEY,
  DEFAULT_WA_TOKEN,
  DEFAULT_PHONE_NUMBER_ID,
} = process.env;

const stripe = new Stripe(STRIPE_SECRET);

// ================== STRIPE CHECKOUT ==================
app.post("/checkout/create", async (req, res) => {
  try {
    const { email } = req.body;
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: "https://app.beautyagent.ai/onboarding?session_id={CHECKOUT_SESSION_ID}",
      cancel_url: "https://beautyagent-ai-glow.lovable.app/#tarifs",
      customer_email: email
    });
    res.json({ url: session.url });
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: "checkout_error" });
  }
});

// Stripe Webhook
app.post("/stripe-webhook", express.raw({ type: "application/json" }), (req, res) => {
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers["stripe-signature"], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature failed.", err.message);
    return res.sendStatus(400);
  }
  if (event.type === "checkout.session.completed") {
    const s = event.data.object;
    const db = readDB();
    db.clients.push({
      id: s.id,
      email: s.customer_details?.email || s.customer_email,
      status: "pending_onboarding",
      clinic: null,
      phone_number_id: null,
      wa_token: null,
      openai_key: null,
      prompt: null
    });
    writeDB(db);
  }
  res.sendStatus(200);
});

// Onboarding route
app.post("/onboarding/complete", async (req, res) => {
  const { session_id, clinic_name, phone_number_id, wa_token, openai_key, prompt } = req.body;
  const db = readDB();
  const c = db.clients.find(x => x.id === session_id);
  if (!c) return res.status(404).json({ error: "session_not_found" });
  c.status = "active";
  c.clinic = clinic_name;
  c.phone_number_id = phone_number_id || DEFAULT_PHONE_NUMBER_ID;
  c.wa_token = wa_token || DEFAULT_WA_TOKEN;
  c.openai_key = openai_key || OPENAI_API_KEY;
  c.prompt = prompt || `Tu es BeautyAgent de la clinique ${clinic_name}. Qualifie les leads en chirurgie esthétique.`;
  writeDB(db);
  res.json({ ok: true });
});

// ================== WHATSAPP WEBHOOK ==================
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0]?.value;
    const message = change?.messages?.[0];
    const phoneNumberId = change?.metadata?.phone_number_id;
    const from = message?.from;
    const text = message?.text?.body || "";

    if (from && text && phoneNumberId) {
      const db = readDB();
      const client = db.clients.find(x => x.phone_number_id === phoneNumberId && x.status === "active");
      const useToken = client?.wa_token || DEFAULT_WA_TOKEN;
      const useOpenAI = client?.openai_key || OPENAI_API_KEY;
      const sysPrompt = client?.prompt || "Tu es BeautyAgent. Qualifie et propose un RDV.";

      const completion = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${useOpenAI}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          temperature: 0.4,
          messages: [
            { role: "system", content: sysPrompt },
            { role: "user", content: text }
          ]
        })
      }).then(r => r.json()).catch(() => ({}));
      const reply = completion?.choices?.[0]?.message?.content?.slice(0, 1000) || "Merci pour votre message.";

      await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${useToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: `+${from}`,
          type: "text",
          text: { body: reply }
        })
      });
    }
    res.sendStatus(200);
  } catch (e) {
    console.error(e);
    res.sendStatus(200);
  }
});

// Health check
app.get("/", (_req, res) => res.send("BeautyAgent OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Running on :" + PORT));
