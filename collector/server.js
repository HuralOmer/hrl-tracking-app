// collector/server.js
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const { Pool } = require('pg');

const app = express();

// --- Middleware'ler ---
app.use(cors({
  origin: '*',
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Origin','X-Requested-With','Content-Type','Accept'],
  credentials: true
}));

// istek logları (LOG_REQUESTS=1 ise ayrıntılı)
app.use(morgan(process.env.LOG_REQUESTS ? 'combined' : 'tiny'));

// sendBeacon çoğunlukla text/plain ile gelir; JSON parser'dan ÖNCE yakala
app.use((req, res, next) => {
  const ct = (req.headers['content-type'] || '').toLowerCase();
  if (req.method === 'POST' && ct.startsWith('text/plain')) {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      try { req.body = data ? JSON.parse(data) : {}; }
      catch { req.body = {}; }
      next();
    });
  } else {
    next();
  }
});

// fetch POST'ları için JSON parser
app.use(express.json({ limit: '200kb' }));

// test-send.html vb. statik dosyalar (collector klasörünün kendisi)
app.use(express.static(path.join(__dirname)));

// --- Sağlık kontrolü ---
app.get(['/health', '/healthz'], (_req, res) => {
  res.json({ ok: true });
});

// Kök path'e basit bir bilgi (Cannot GET / görmeyelim)
app.get('/', (_req, res) => {
  res.type('text/plain').send('HRL collector up. Use POST /collect (or /collector/collect).');
});

// --- DB (varsa) ---
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
}

// --- TOPLAMA ENDPOINT'İ ---
// >>> Burada /collector/collect de eklendi <<<
app.post(['/collect', '/api/collect', '/collector/collect'], async (req, res) => {
  const { shopId, event, productHandle, buttonId, extra } = req.body || {};

  if (!shopId || !event) {
    return res
      .status(400)
      .json({ ok: false, error: 'missing_params', required: ['shopId', 'event'] });
  }

  try {
    if (pool) {
      await pool.query(
        `insert into hrl_events
         (shop_id, event, product_handle, button_id, extra_json, created_at)
         values ($1,$2,$3,$4,$5, now())`,
        [
          shopId,
          event,
          productHandle || null,
          buttonId || null,
          extra ? JSON.stringify(extra) : null,
        ]
      );
    } else {
      console.log('EVENT (no-db):', { shopId, event, productHandle, buttonId, extra });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('DB error:', err);
    if (process.env.DEBUG_ERRORS) {
      return res.status(500).json({ ok: false, error: 'internal_error', details: String(err) });
    }
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// Yakalanmayan istekler hep JSON 404 dönsün
app.use((req, res) => {
  res
    .status(404)
    .json({ ok: false, error: 'not_found', method: req.method, path: req.path });
});

// --- Sunucu ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Collector listening on http://localhost:${PORT}`);
});
