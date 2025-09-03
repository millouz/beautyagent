import express from "express";
import fetch from "node-fetch";
import Stripe from "stripe";
import fs from "fs";
import path from "path";

const app = express();

/* ============== LOG ============== */
const log = {
  info: (m, d={})=>console.log(`[INFO] ${m}`, d),
  error:(m,e={})=>console.error(`[ERROR] ${m}`, e),
  warn:(m,d={})=>console.warn(`[WARN] ${m}`, d),
};

/* ============== MIDDLEWARE ============== */
app.use("/stripe-webhook", express.raw({ type: "application/json" }));
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

/* ============== ENV ============== */
const need = ["STRIPE_SECRET","STRIPE_PRICE_ID","STRIPE_WEBHOOK_SECRET"];
const miss = need.filter(v=>!process.env[v]);
if(miss.length){ log.error(`ENV manquantes: ${miss.join(", ")}`); process.exit(1); }

const {
  PORT=3000,
  STRIPE_SECRET,
  STRIPE_PRICE_ID,
  STRIPE_WEBHOOK_SECRET,
  VERIFY_TOKEN="beautyagent_verify",
  OPENAI_API_KEY,
  DEFAULT_WA_TOKEN,
  DEFAULT_PHONE_NUMBER_ID,
  NODE_ENV="production",
} = process.env;

const stripe = new Stripe(STRIPE_SECRET);
const port = Number(PORT);

/* ============== DB JSON ============== */
const DB_PATH = path.resolve("./db.json");
if(!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({clients:[],conversations:{}},null,2));

const readDB = ()=> {
  try{
    const d = JSON.parse(fs.readFileSync(DB_PATH,"utf8"));
    d.clients ??= []; d.conversations ??= {};
    return d;
  }catch(e){ log.error("DB read", e); return {clients:[],conversations:{}}; }
};
const writeDB = (d)=>{ fs.writeFileSync(DB_PATH+".tmp", JSON.stringify(d,null,2)); fs.renameSync(DB_PATH+".tmp", DB_PATH); };

/* ============== HELPERS ============== */
const norm = v=>String(v??"").trim();
const sameId = (a,b)=>norm(a)===norm(b);

/* ============== PROMPTS ============== */
const BASE_PROMPT = [
"Tu es l’assistante IA d’une clinique esthétique.",
"Style concis, premium, rassurant. Une seule question à la fois. Jamais de diagnostic.",
"Ne répète pas les salutations si elles ont déjà été faites.",
"Conserve le contexte de la conversation **même si le sujet change** et réutilise les infos connues.",
"Objectif: qualifier Intervention, Objectif, Budget, Délai, Identité, Contact puis proposer un RDV.",
"Si l’utilisateur demande tarifs/processus et que l’Intervention est connue, réponds directement pour cette intervention."
].join("\n");

/* ============== MEMOIRE ============== */
const MAX_TURNS = 24;                 // 12 allers-retours
const TTL_MS    = 6*60*60*1000;       // 6h

function getConv(db, id){
  const now = Date.now();
  let c = db.conversations[id];
  if(!c || now-(c.updated_at||0)>TTL_MS){
    c = { history:[], slots:{}, greeted:false, summary:"", updated_at:now };
    db.conversations[id] = c;
  }
  return c;
}
function push(conv, role, content){
  conv.history.push({role, content});
  if(conv.history.length>MAX_TURNS) conv.history = conv.history.slice(-MAX_TURNS);
  conv.updated_at = Date.now();
}
function extractSlots(slots, text){
  const t=(text||"").toLowerCase();
  const mInterv = t.match(/(greffe capillaire|greffe|rhinoplastie|liposuccion|bbl|lifting|implants mammaires|botox|acide hyaluronique|filler)/);
  if(mInterv && !slots.intervention) slots.intervention = mInterv[1];
  const mBudget = t.match(/(\d[\d\s]{2,})\s*€?/);
  if(mBudget && !slots.budget) slots.budget = mBudget[1].replace(/\s/g,"");
  const mDelai = t.match(/(\d+\s*(jours?|semaines?|mois?)|urgent|dès que possible|1-3 mois|3-12 mois)/);
  if(mDelai && !slots.delai) slots.delai = mDelai[1];
  const mNom = text.match(/je m'?appelle\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i);
  if(mNom && !slots.nom) slots.nom = mNom[1].trim();
  return slots;
}
const slotsLine = (s)=>[
  s.intervention?`Intervention=${s.intervention}`:null,
  s.budget?`Budget=${s.budget}€`:null,
  s.delai?`Délai=${s.delai}`:null,
  s.nom?`Nom=${s.nom}`:null
].filter(Boolean).join(" | ");

/* ============== OPENAI CALL ============== */
async function chatCompletes(apiKey, messages, maxTokens=350){
  const r = await fetch("https://api.openai.com/v1/chat/completions",{
    method:"POST",
    headers:{ Authorization:`Bearer ${apiKey}`, "Content-Type":"application/json" },
    body:JSON.stringify({ model:"gpt-4o-mini", temperature:0.3, max_tokens:maxTokens, messages })
  });
  const j = await r.json();
  if(j.error) throw j.error;
  return j.choices?.[0]?.message?.content || "Merci pour votre message.";
}

/* ============== STRIPE ============== */
app.post("/checkout/create", async (req,res)=>{
  try{
    const { email } = req.body||{};
    const session = await stripe.checkout.sessions.create({
      mode:"subscription",
      line_items:[{ price:STRIPE_PRICE_ID, quantity:1 }],
      success_url:"https://app.beautyagent.ai/onboarding?session_id={CHECKOUT_SESSION_ID}",
      cancel_url:"https://beautyagent-ai-glow.lovable.app/#tarifs",
      customer_email:email,
      expires_at: Math.floor(Date.now()/1000)+86400
    });
    res.json({ url:session.url, session_id:session.id });
  }catch(e){ log.error("checkout", e); res.status(500).json({error:"checkout"}); }
});

app.post("/stripe-webhook",(req,res)=>{
  try{
    const sig = req.headers["stripe-signature"];
    if(!sig) return res.status(400).json({error:"no signature"});
    const event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    if(event.type==="checkout.session.completed"){
      const s = event.data.object;
      const db = readDB();
      if(!db.clients.find(c=>c.id===s.id)){
        db.clients.push({ id:s.id, email:s.customer_email, status:"pending_onboarding",
          clinic:null, phone_number_id:null, wa_token:null, openai_key:null, prompt:null });
        writeDB(db);
      }
    }
    res.sendStatus(200);
  }catch(e){ log.error("stripe-webhook", e); res.sendStatus(400); }
});

/* ============== ONBOARDING ============== */
app.post("/onboarding/complete",(req,res)=>{
  try{
    const { session_id, clinic_name, phone_number_id, wa_token, openai_key, prompt } = req.body||{};
    const db = readDB();
    const c = db.clients.find(x=>x.id===session_id);
    if(!c) return res.status(404).json({error:"session not found"});
    c.status="active";
    c.clinic = clinic_name;
    c.phone_number_id = norm(phone_number_id || DEFAULT_PHONE_NUMBER_ID);
    c.wa_token = wa_token || DEFAULT_WA_TOKEN;
    c.openai_key = openai_key || OPENAI_API_KEY;
    c.prompt = prompt || BASE_PROMPT;
    writeDB(db);
    res.json({ok:true});
  }catch(e){ log.error("onboarding", e); res.status(500).json({error:"onboarding"}); }
});

/* ============== VERIFY WEBHOOK ============== */
app.get("/webhook",(req,res)=>{
  const mode=req.query["hub.mode"], token=req.query["hub.verify_token"], challenge=req.query["hub.challenge"];
  if(mode==="subscribe" && token===norm(VERIFY_TOKEN)) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* ============== WHATSAPP WEBHOOK ============== */
app.post("/webhook", async (req,res)=>{
  try{
    const entry = req.body.entry?.[0];
    const val = entry?.changes?.[0]?.value;
    const msg = val?.messages?.[0];
    const phoneNumberId = norm(val?.metadata?.phone_number_id);
    const from = msg?.from;
    const text = msg?.text?.body || "";

    if(!from || !text){ log.warn("message incomplet"); return res.sendStatus(200); }

    const db = readDB();
    let client = db.clients.find(c=>c.status==="active" && sameId(c.phone_number_id, phoneNumberId))
      || { id:"fallback", status:"active", phone_number_id:phoneNumberId,
           wa_token:DEFAULT_WA_TOKEN, openai_key:OPENAI_API_KEY, prompt:BASE_PROMPT };

    const useToken = norm(client.wa_token||DEFAULT_WA_TOKEN);
    const useOpenAI = norm(client.openai_key||OPENAI_API_KEY);

    const conversationId = `${phoneNumberId}_${from}`;
    const conv = getConv(db, conversationId);

    // mémoire
    extractSlots(conv.slots, text);
    if(/bonjour/i.test(text)) conv.greeted = true;

    // 1) Construire un **nouveau prompt** à CHAQUE message
    const dynamicSystem = [
      client.prompt || BASE_PROMPT,
      "",
      `Mémoire structurée: ${slotsLine(conv.slots) || "aucune"}`,
      conv.summary ? `Résumé conversation: ${conv.summary}` : "Résumé conversation: aucun",
      "Rappels: ne répète pas les salutations si déjà faites. Conserve le contexte même si le sujet change."
    ].join("\n");

    // 2) Historique complet utile (jusqu’à MAX_TURNS)
    const historyMsgs = conv.history.map(m=>({ role:m.role, content:m.content }));

    // 3) Empêcher le “re-bonjour” inutile
    const isJustGreeting = /^bon[j]?our[\s!,.]*$/i.test(text.trim());
    const effectiveUserText = (isJustGreeting && conv.greeted)
      ? "L'utilisateur a salué encore. Reprends la qualification ou réponds sur l'intervention connue sans resaluer."
      : text;

    // 4) Appel modèle avec nouveau prompt + historique
    const messages = [{ role:"system", content: dynamicSystem }, ...historyMsgs, { role:"user", content: effectiveUserText }];
    push(conv, "user", text);
    let reply = "Merci pour votre message.";

    try{
      reply = await chatCompletes(useOpenAI, messages, 350);
    }catch(e){ log.error("OpenAI chat", e); }

    push(conv, "assistant", reply);

    // 5) Mettre à jour un **résumé mémoire** court pour les prompts suivants
    try{
      const sum = await chatCompletes(useOpenAI, [
        { role:"system", content:"Résume en 2 phrases maximum les informations utiles déjà obtenues pour la suite de la qualification. Français. Pas de salutations." },
        { role:"user", content: JSON.stringify(conv.history.slice(-10)) }
      ], 120);
      conv.summary = sum;
    }catch(e){ /* soft-fail */ }

    db.conversations[conversationId] = conv;
    writeDB(db);

    await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,{
      method:"POST",
      headers:{ Authorization:`Bearer ${useToken}`, "Content-Type":"application/json" },
      body: JSON.stringify({ messaging_product:"whatsapp", to:from, type:"text", text:{ body: reply } })
    });

    log.info("msg OK", { conversationId, turns: conv.history.length });
    res.sendStatus(200);
  }catch(e){
    log.error("webhook", e);
    res.sendStatus(500);
  }
});

/* ============== HEALTH ============== */
app.get("/health",(req,res)=>{
  const db = readDB();
  res.json({ status:"ok", clients: db.clients.length, conversations: Object.keys(db.conversations||{}).length });
});

app.listen(port, ()=> log.info(`BeautyAgent sur ${port}`, { env:NODE_ENV }));

export default app;
