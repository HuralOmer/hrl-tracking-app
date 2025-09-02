// collector/server.js
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const { Pool } = require('pg');

const app = express();
app.set('trust proxy', 1);

// --- Ayarlar / Log ---
const LOG_REQUESTS = String(process.env.LOG_REQUESTS || '0') === '1';
app.use(cors());
app.use(morgan('tiny'));
app.use((req, _res, next) => {
  if (LOG_REQUESTS) console.log(`[REQ] ${req.method} ${req.originalUrl}`);
  next();
});

// sendBeacon genelde text/plain → önce onu yakala
app.use((req, res, next) => {
  const ct = req.headers['content-type'] || '';
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

// JSON / form parser
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: false }));

// --- Sağlık & kök ---
app.get('/health', (_req, res) => res.json({ ok: true }));
app.get('/', (_req, res) =>
  res.json({
    ok: true,
    service: 'collector',
    routes: ['POST /collect', 'POST /collector/collect', 'GET /stats/*', 'GET /test-send.html']
  })
);

// --- DB ---
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
  pool.on('error', (err) => console.error('PG pool error:', err));
}

async function saveEvent({ shopId, event, productHandle, buttonId, extra }) {
  if (!pool) return;
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
}

// --- Toplama endpoint'i (çoklu path) ---
const collectHandler = async (req, res, next) => {
  try {
    const { shopId, event, productHandle, buttonId, extra } = req.body || {};
    if (!shopId || !event) {
      return res.status(400).json({ ok: false, error: 'missing_params', required: ['shopId', 'event'] });
    }
    await saveEvent({ shopId, event, productHandle, buttonId, extra });
    return res.json({ ok: true });
  } catch (err) {
    console.error('collect error:', err);
    next(err);
  }
};

// Geriye dönük uyumluluk için tüm yollar:
app.post(['/collect', '/api/collect', '/collector/collect'], collectHandler);

// --- Stats (varsa) ---
try {
  const statsRoutes = require('./stats-routes');
  app.use('/stats', statsRoutes);
} catch (e) {
  console.log('Stats routes not loaded:', e.message);
}

// --- Statik test sayfası ---
app.use(express.static(path.join(__dirname)));

// 404 JSON
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found', method: req.method, path: req.originalUrl });
});

// 500 JSON
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, error: 'internal_error' });
});

// --- Sunucu ---
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Collector listening on http://localhost:${PORT}`);
});
