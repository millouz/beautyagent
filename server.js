import 'dotenv/config';
import express from 'express';
import fetch from 'node-fetch';
import Stripe from 'stripe';
import fs from 'fs';
import path from 'path';

const app = express();

/* ============== LOG ============== */
const log = {
  info: (m, d = {}) => console.log(`[INFO] ${m}`, d),
  error: (m, e = {}) => console.error(`[ERROR] ${m}`, e),
  warn: (m, d = {}) => console.warn(`[WARN] ${m}`, d),
};

/* ============== MIDDLEWARE ============== */
app.use('/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

/* ============== ENV ============== */
const need = ['STRIPE_SECRET', 'STRIPE_PRICE_ID', 'STRIPE_WEBHOOK_SECRET', 'OPENAI_API_KEY', 'DEFAULT_WA_TOKEN'];
const miss = need.filter((v) => !process.env[v]);
if (miss.length) {
  log.error(`ENV manquantes: ${miss.join(', ')}`);
  process.exit(1);
}

const {
  PORT = 3000,
  STRIPE_SECRET,
  STRIPE_PRICE_ID,
  STRIPE_WEBHOOK_SECRET,
  VERIFY_TOKEN = 'beautyagent_verify',
  OPENAI_API_KEY,
  DEFAULT_WA_TOKEN,
  DEFAULT_PHONE_NUMBER_ID = '',
  NODE_ENV = 'production',
  DB_PATH: DB_PATH_ENV = '/tmp/db.json',
} = process.env;

const stripe = new Stripe(STRIPE_SECRET, { apiVersion: '2024-06-20' });
const port = Number(PORT);

/* ============== DB JSON ============== */
const DB_PATH = path.resolve(DB_PATH_ENV);
if (!fs.existsSync(DB_PATH)) {
  fs.writeFileSync(DB_PATH, JSON.stringify({ clients: [], conversations: {}, processed: {} }, null, 2));
}
function ensureDBShape(db) {
  db.clients ??= [];
  db.conversations ??= {};
  db.processed ??= {};
  return db;
}
const readDB = () => {
  try {
    return ensureDBShape(JSON.parse(fs.readFileSync(DB_PATH, 'utf8')));
  } catch (e) {
    log.error('DB read', e);
    return ensureDBShape({ clients: [], conversations: {}, processed: {} });
  }
};
const writeDB = (d) => {
  fs.writeFileSync(DB_PATH + '.tmp', JSON.stringify(d, null, 2));
  fs.renameSync(DB_PATH + '.tmp', DB_PATH);
};

/* ============== HELPERS ============== */
const norm = (v) => String(v ?? '').trim();
const sameId = (a, b) => norm(a) === norm(b);

/* processed messages (idempotence) */
function pruneProcessed(db) {
  const now = Date.now();
  const TTL = 24 * 60 * 60 * 1000;
  for (const [k, v] of Object.entries(db.processed)) if (now - v > TTL) delete db.processed[k];
}
function alreadyHandled(db, dedupeKey) {
  if (!dedupeKey) return false;
  if (db.processed[dedupeKey]) return true;
  db.processed[dedupeKey] = Date.now();
  pruneProcessed(db);
  return false;
}

/* ============== PROMPT PERSONA ============== */
const BASE_PROMPT = `
Tu es Beautyagent, l’assistante humaine d’une clinique de chirurgie et de médecine esthétique.
Rôle : accueillir le patient, rassurer, qualifier et mener vers un RDV.

Style :
- Naturel, professionnel, chaleureux. Phrases courtes. 1 question max par message.
- Zéro répétition. Pas de jargon. Émojis discrets si utiles (🙂📅).

Mémoire :
- Tiens compte de l’historique. Ne repose pas une question déjà traitée.
- “Bonjour” une seule fois par conversation.

Méthode :
1) Reconnais ce que dit le patient (reformulation brève).
2) Réponds clairement sans technique médicale.
3) Termine par UNE question qui fait avancer.

Objectif :
- intervention, zone, objectif, budget, délai, dispos, identité + contact
- puis proposition de RDV (créneaux concrets).

Parcours patient (général, non médical) :
- consultation, examens si besoin, opération (durées indicatives), hospitalisation (ambulatoire/1 nuit),
- convalescence (jours à semaines), suivi post-op. Le chirurgien valide tout.

Sécurité :
- Pas de diagnostic, pas de promesse de résultat, pas de choix techniques. Oriente vers le chirurgien si question pointue.

Relecture obligatoire avant envoi :
- Relis toute la conversation, supprime ce qui sonne robotique ou redondant,
- assure la cohérence et un ton humain naturel avant d’envoyer.
`.trim();

/* ============== MEMOIRE ============== */
const MAX_TURNS = 24;
const TTL_MS = 6 * 60 * 60 * 1000;

function getConv(db, id) {
  const now = Date.now();
  let c = db.conversations[id];
  if (!c || now - (c.updated_at || 0) > TTL_MS) {
    c = { history: [], slots: {}, greeted: false, summary: '', updated_at: now };
    db.conversations[id] = c;
  }
  return c;
}
function push(conv, role, content) {
  conv.history.push({ role, content });
  if (conv.history.length > MAX_TURNS) conv.history = conv.history.slice(-MAX_TURNS);
  conv.updated_at = Date.now();
}
function extractSlots(slots, text) {
  const t = (text || '').toLowerCase();
  const mInterv = t.match(
    /(greffe capillaire|greffe|rhinoplastie|liposuccion|bbl|lifting|implants mammaires|augmentation mammaire|botox|acide hyaluronique|filler)/,
  );
  if (mInterv && !slots.intervention) slots.intervention = mInterv[1];
  const mBudget = t.match(/(\d[\d\s]{2,})\s*€?/);
  if (mBudget && !slots.budget) slots.budget = mBudget[1].replace(/\s/g, '');
  const mDelai = t.match(/(\d+\s*(jours?|semaines?|mois?)|urgent|dès que possible|1-3 mois|3-12 mois)/);
  if (mDelai && !slots.delai) slots.delai = mDelai[1];
  const mNom = text.match(/je m'?appelle\s+([A-Za-zÀ-ÖØ-öø-ÿ' -]{2,30})/i);
  if (mNom && !slots.nom) slots.nom = mNom[1].trim();
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
    .join(' | ');

/* ============== OPENAI ============== */
async function chatCompletes(apiKey, messages, maxTokens = 350) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.3, max_tokens: maxTokens, messages }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`OpenAI HTTP ${r.status}: ${t}`);
  }
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || 'OpenAI error');
  return j.choices?.[0]?.message?.content ?? '';
}

/* ============== STRIPE ============== */
app.post('/checkout/create', async (req, res) => {
  try {
    const { email } = req.body || {};
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      success_url: 'https://app.beautyagent.ai/onboarding?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://beautyagent-ai-glow.lovable.app/#tarifs',
      customer_email: email,
    });
    res.json({ url: session.url, session_id: session.id });
  } catch (e) {
    log.error('checkout', e);
    res.status(500).json({ error: 'checkout' });
  }
});

app.post('/stripe-webhook', (req, res) => {
  try {
    const sig = req.headers['stripe-signature'];
    if (!sig) return res.status(400).json({ error: 'no signature' });
    const event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    if (event.type === 'checkout.session.completed') {
      const s = event.data.object;
      const db = readDB();
      if (!db.clients.find((c) => c.id === s.id)) {
        db.clients.push({
          id: s.id,
          email: s.customer_email || '',
          status: 'pending_onboarding',
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
    log.error('stripe-webhook', e);
    res.sendStatus(400);
  }
});

/* ============== ONBOARDING ============== */
app.post('/onboarding/complete', (req, res) => {
  try {
    const { session_id, clinic_name, phone_number_id, wa_token, openai_key, prompt } = req.body || {};
    const db = readDB();
    const c = db.clients.find((x) => x.id === session_id);
    if (!c) return res.status(404).json({ error: 'session not found' });
    c.status = 'active';
    c.clinic = clinic_name || c.clinic || '';
    c.phone_number_id = norm(phone_number_id || DEFAULT_PHONE_NUMBER_ID);
    c.wa_token = norm(wa_token || DEFAULT_WA_TOKEN);
    c.openai_key = norm(openai_key || OPENAI_API_KEY);
    c.prompt = (prompt && String(prompt).trim()) || BASE_PROMPT;
    writeDB(db);
    res.json({ ok: true });
  } catch (e) {
    log.error('onboarding', e);
    res.status(500).json({ error: 'onboarding' });
  }
});

/* ============== VERIFY (Meta) ============== */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === norm(VERIFY_TOKEN)) return res.status(200).send(challenge);
  return res.sendStatus(403);
});

/* ============== WHATSAPP WEBHOOK (Meta Graph) ============== */
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body?.entry?.[0];
    const change = entry?.changes?.[0]?.value;

    if (!change?.messages || !Array.isArray(change.messages) || change.messages.length === 0) {
      return res.sendStatus(200);
    }
    const msg = change.messages[0];
    if (msg.type !== 'text' || !msg.text?.body) return res.sendStatus(200);

    const phoneNumberId = norm(change?.metadata?.phone_number_id);
    const from = norm(msg.from);
    const text = norm(msg.text.body);
    const messageId = norm(msg.id);

    if (!from || !text || !phoneNumberId) return res.sendStatus(200);

    // Log d’entrée
    log.info('Incoming msg', { messageId, from, text });

    const dedupeKey = `${messageId}:${from}`;
    const db = readDB();
    if (alreadyHandled(db, dedupeKey)) {
      writeDB(db);
      return res.sendStatus(200);
    }

    const client =
      db.clients.find((c) => c.status === 'active' && sameId(c.phone_number_id, phoneNumberId)) || {
        id: 'fallback',
        status: 'active',
        phone_number_id: phoneNumberId,
        wa_token: DEFAULT_WA_TOKEN,
        openai_key: OPENAI_API_KEY,
        prompt: BASE_PROMPT,
      };

    const useToken = norm(client.wa_token || DEFAULT_WA_TOKEN);
    const useOpenAI = norm(client.openai_key || OPENAI_API_KEY);

    const conversationId = `${phoneNumberId}_${from}`;
    const conv = getConv(db, conversationId);

    extractSlots(conv.slots, text);
    const isGreeting = /^bon[j]?our\b/i.test(text);
    if (isGreeting && !conv.greeted) conv.greeted = true;

    const dynamicSystem = [
      client.prompt || BASE_PROMPT,
      `Slots connus: ${slotsLine(conv.slots) || 'aucun'}`,
      conv.summary ? `Résumé: ${conv.summary}` : 'Résumé: aucun',
      'Consignes finales: pas de répétitions, une seule question, Bonjour une seule fois.',
    ].join('\n');

    const historyMsgs = conv.history.map((m) => ({ role: m.role, content: m.content }));
    const effectiveUserText =
      isGreeting && conv.greeted
        ? "L'utilisateur a redit bonjour. Réponds brièvement puis poursuis naturellement sans resaluer."
        : text;

    // push du message utilisateur UNE SEULE FOIS
    push(conv, 'user', effectiveUserText);

    let reply = '';
    try {
      reply = await chatCompletes(
        useOpenAI,
        [{ role: 'system', content: dynamicSystem }, ...historyMsgs, { role: 'user', content: effectiveUserText }],
        320,
      );
    } catch (e) {
      log.error('OpenAI chat', e);
      writeDB(db);
      return res.sendStatus(200);
    }

    if (!reply) {
      writeDB(db);
      return res.sendStatus(200);
    }

    push(conv, 'assistant', reply);

    // Résumé court
    try {
      const sum = await chatCompletes(
        useOpenAI,
        [
          {
            role: 'system',
            content:
              'Résume en 2 phrases max les infos utiles déjà obtenues (slots + points clés). Réponds en français.',
          },
          { role: 'user', content: JSON.stringify({ slots: conv.slots, lastTurns: conv.history.slice(-8) }) },
        ],
        120,
      );
      if (sum) conv.summary = sum;
    } catch (_) {}

    db.conversations[conversationId] = conv;
    writeDB(db);

    // Envoi WhatsApp
    const resp = await fetch(`https://graph.facebook.com/v20.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${useToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: from,
        type: 'text',
        text: { body: reply.slice(0, 4096) },
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      log.error('WA send error', { status: resp.status, body: t });
    }

    log.info('msg OK', { conversationId, messageId, turns: conv.history.length });
    res.sendStatus(200);
  } catch (e) {
    log.error('webhook', e);
    res.sendStatus(500);
  }
});

/* ============== HEALTH ============== */
app.get('/health', (req, res) => {
  const db = readDB();
  res.json({
    status: 'ok',
    clients: db.clients.length,
    conversations: Object.keys(db.conversations || {}).length,
    processed: Object.keys(db.processed || {}).length,
    env: NODE_ENV,
    db_path: DB_PATH,
  });
});

app.listen(port, () => log.info(`BeautyAgent sur ${port}`, { env: NODE_ENV }));

export default app;
