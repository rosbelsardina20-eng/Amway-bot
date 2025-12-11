/**
 * Asistente Amway - index.js
 * Multicanal: Telegram (Telegraf), WhatsApp (Twilio), Webchat endpoints
 * DB: MongoDB (MONGODB_URI) fallback to SQLite (local file)
 * Payments: Stripe Checkout
 * PWA: serves files from /public
 */

require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || ('http://localhost:' + PORT);

// Catalog
const catalogPath = path.join(__dirname, 'catalog.json');
let catalog = [];
try { catalog = JSON.parse(fs.readFileSync(catalogPath,'utf8')); } catch(e){ console.warn('catalog.json missing or invalid'); catalog = []; }

// --- Database setup: prefer MongoDB (MONGODB_URI) else use SQLite ---
let DB = { type: 'memory', saveLead: async (l)=>{ console.log('Lead:', l); } };
if (process.env.MONGODB_URI) {
  const mongoose = require('mongoose');
  mongoose.connect(process.env.MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(()=> console.log('Connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));
  const leadSchema = new mongoose.Schema({
    name: String, phone: String, email: String, message: String, createdAt: { type: Date, default: Date.now }
  });
  const Lead = mongoose.models.Lead || mongoose.model('Lead', leadSchema);
  DB = {
    type: 'mongo',
    saveLead: async (l) => new Lead(l).save()
  };
} else {
  // sqlite fallback
  const sqlite3 = require('sqlite3').verbose();
  const dbFile = path.join(__dirname, 'data.db');
  const db = new sqlite3.Database(dbFile);
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS leads (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, phone TEXT, email TEXT, message TEXT, createdAt TEXT)`);
  });
  DB = {
    type: 'sqlite',
    saveLead: async (l) => new Promise((resolve, reject) => {
      const stmt = db.prepare('INSERT INTO leads (name, phone, email, message, createdAt) VALUES (?,?,?,?,DATETIME("now"))');
      stmt.run(l.name, l.phone, l.email||'', l.message||'', function(err){ if(err) reject(err); else resolve({ id: this.lastID }); });
    })
  };
}

// --- Telegram bot (if BOT_TOKEN) ---
if (process.env.BOT_TOKEN) {
  try {
    const { Telegraf } = require('telegraf');
    const bot = new Telegraf(process.env.BOT_TOKEN);
    bot.start(ctx => ctx.reply('¡Hola! Soy Asistente Amway. ¿Quieres ver productos o una recomendación?'));
    bot.hears(/catalog|catálogo|ver/i, ctx => {
      const cats = [...new Set(catalog.map(p=>p.category))];
      ctx.reply('Categorías:\n' + cats.map((c,i)=>`${i+1}) ${c}`).join('\n'));
    });
    bot.hears(/recom|recomend/i, ctx => {
      ctx.reply('Dime qué te interesa mejorar (ej: cuidado facial, energía, hogar)');
      bot.on('text', msg => {
        const q = msg.message.text.toLowerCase();
        const results = catalog.filter(p => (p.name+' '+p.category+' '+(p.tags||[]).join(' ')).toLowerCase().includes(q)).slice(0,3);
        if (results.length===0) return msg.reply('No encontré coincidencias. ¿Quieres dejar tu email para que te envíe opciones?');
        results.forEach(p => {
          try { msg.replyWithPhoto(p.image_url, { caption: `${p.name}\n${p.short_desc}\nPrecio: ${p.price} ${p.currency}\nComprar: ${p.buy_link}` }); }
          catch(e){ msg.reply(`${p.name} - ${p.short_desc}\nComprar: ${p.buy_link}`); }
        });
      });
    });
    bot.launch().then(()=>console.log('Telegram bot launched')).catch(e=>console.error('Telegram launch error',e));
  } catch(e){ console.warn('Telegraf not available:', e.message); }
}

// --- Twilio WhatsApp webhook (if TWILIO env set) ---
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_WHATSAPP_NUMBER) {
  const Twilio = require('twilio');
  const twClient = Twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  const MessagingResponse = require('twilio').twiml.MessagingResponse;

  app.post('/twilio-webhook', (req, res) => {
    // Twilio sends x-www-form-urlencoded by default; bodyParser.urlencoded is enabled
    const incoming = req.body.Body || req.body.Body || '';
    const from = req.body.From || '';
    console.log('WhatsApp message from', from, incoming);
    const q = (incoming || '').toLowerCase();

    // Simple rule response
    let reply = 'Hola! Soy Asistente Amway. Responde: 1) Ver catálogo  2) Recomiéndame';
    if (q.includes('1') || q.includes('cat')) {
      const cats = [...new Set(catalog.map(p=>p.category))];
      reply = 'Categorías: ' + cats.join(' | ');
    } else if (q.includes('recom') || q.includes('2')) {
      reply = 'Dime qué te interesa mejorar (ej: cuidado facial, energía, hogar)';
    } else if (catalog.length>0 && q.length>2) {
      const results = catalog.filter(p => (p.name+' '+p.category+' '+(p.tags||[]).join(' ')).toLowerCase().includes(q)).slice(0,3);
      if (results.length>0) reply = results.map(p=>`${p.name} - ${p.short_desc} - ${p.buy_link}`).join('\n\n');
      else reply = 'No encontré coincidencias. ¿Quieres dejar tu email para que te envíe opciones?';
    }

    const twiml = new MessagingResponse();
    twiml.message(reply);
    res.writeHead(200, {'Content-Type': 'text/xml'});
    res.end(twiml.toString());
  });
}

// --- Endpoints: catalog, recommend, lead, cart, checkout (Stripe) ---
app.get('/catalog', (req, res) => res.json({ ok: true, count: catalog.length, products: catalog }));

app.post('/recommend', (req, res) => {
  const q = (req.body.query || '').toLowerCase();
  if (!q) return res.status(400).json({ ok: false, error: 'Falta query' });
  const results = catalog.filter(p => (p.name+' '+p.category+' '+(p.tags||[]).join(' ')).toLowerCase().includes(q)).slice(0,6);
  res.json({ ok:true, query: q, results });
});

app.post('/lead', async (req, res) => {
  const { name, phone, email, message } = req.body || {};
  if (!name || !phone) return res.status(400).json({ ok:false, error: 'Faltan name o phone' });
  try {
    const saved = await DB.saveLead({ name, phone, email, message });
    res.json({ ok:true, saved: true, db: DB.type, id: saved && saved.id ? saved.id : null });
  } catch (err) {
    console.error('Error saving lead', err);
    res.status(500).json({ ok:false, error: 'no se pudo guardar lead' });
  }
});

// Simple cart stored in memory for demo (replace with DB in production)
let carts = {};

app.post('/cart/add', (req, res) => {
  const { sessionId, productId, qty } = req.body || {};
  if (!sessionId || !productId) return res.status(400).json({ ok:false, error:'faltan sessionId o productId' });
  carts[sessionId] = carts[sessionId] || {};
  carts[sessionId][productId] = (carts[sessionId][productId] || 0) + (parseInt(qty)||1);
  res.json({ ok:true, cart: carts[sessionId] });
});

app.get('/cart/:sessionId', (req, res) => {
  const s = req.params.sessionId;
  res.json({ ok:true, cart: carts[s]||{} });
});

// Stripe checkout session
if (process.env.STRIPE_SECRET_KEY) {
  const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  app.post('/create-checkout-session', async (req, res) => {
    const { items, successUrl, cancelUrl } = req.body || {};
    if (!items || !Array.isArray(items)) return res.status(400).json({ error: 'items required' });
    try {
      const line_items = items.map(it => {
        const product = catalog.find(p=>p.id === it.productId);
        const unit_amount = Math.round((product ? product.price : (it.price||0)) * 100);
        return { price_data: { currency: (product?product.currency:'usd').toLowerCase(), product_data: { name: product?product.name:it.name }, unit_amount }, quantity: it.quantity || 1 };
      });
      const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        line_items,
        mode: 'payment',
        success_url: successUrl || (BASE_URL + '/success.html'),
        cancel_url: cancelUrl || (BASE_URL + '/cancel.html'),
      });
      res.json({ id: session.id, url: session.url });
    } catch (err) {
      console.error('Stripe error', err);
      res.status(500).json({ error: 'stripe error' });
    }
  });
}

// --- PWA: simple index and assets served from /public ---
// public/index.html, manifest.json, service-worker.js created in files below

// Start server
app.listen(PORT, () => console.log(`Servidor escuchando en ${PORT} - BASE_URL=${BASE_URL}`));
