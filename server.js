/* ENV */
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

// Le token attendu est soit la variable d’environnement, soit la valeur par défaut
const expectedToken = (VERIFY_TOKEN || "beautyagent_verify").trim();

/* … autres routes … */

/* 4) Webhook WhatsApp */
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = (req.query["hub.verify_token"] || "").trim();
  const challenge = req.query["hub.challenge"];
  // on valide le challenge si le mode est subscribe et que le token correspond soit
  // à expectedToken, soit à la valeur par défaut
  if (mode === "subscribe" && (token === expectedToken || token === "beautyagent_verify")) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});
