// collector/server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 8080;

// --- DB -------------------------------------------------
const DATABASE_URL = process.env.DATABASE_URL;
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

// --- App setup -----------------------------------------
app.disable('x-powered-by');
app.use(cors());
app.options('*', (_req, res) => res.sendStatus(204)); // preflight

// Body parsers
app.use(express.json({ limit: '200kb' }));
app.use(express.urlencoded({ extended: true }));

// Invalid JSON guard
app.use((err, _req, res, next) => {
  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({ ok: false, error: 'invalid_json' });
  }
  next(err);
});

// Request logging (toggle with LOG_REQUESTS=1)
const LOG = process.env.LOG_REQUESTS === '1';
app.use((req, _res, next) => {
  if (LOG) console.log('REQ', req.method, req.path);
  next();
});

// --- Helpers -------------------------------------------
function badRequest(res, required = []) {
  return res.status(400).json({ ok: false, error: 'missing_params', required });
}

async function saveEvent({ shopId, event, productHandle, buttonId, extra }) {
  if (!pool) return; // DB yoksa atla (ör: local)
  await pool.query(
    `INSERT INTO events (shop_id, event, product_handle, button_id, extra, created_at)
     VALUES ($1,$2,$3,$4,$5, NOW())`,
    [shopId, event, productHandle || null, buttonId || null, extra ? JSON.stringify(extra) : null]
  );
}

// --- Routes --------------------------------------------

// Sağlık kontrolü
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// Test sayfası
app.get('/test-send.html', (_req, res) =>
  res.sendFile(path.join(__dirname, 'test-send.html'))
);

// Hem /collect hem /api/collect aynı handler
const collectPaths = ['/collect', '/api/collect'];

app.post(collectPaths, async (req, res) => {
  try {
    // Gövde boşsa query ile dene (diagnostic amaçlı)
    const src = req.body && Object.keys(req.body).length ? req.body : req.query;

    const shopId = (src.shopId || src.shop_id || '').toString().trim();
    const event = (src.event || '').toString().trim();
    const productHandle = src.productHandle || src.product_handle || null;
    const buttonId = src.buttonId || src.button_id || null;

    // extra JSON string gelebilir
    let extra = src.extra ?? null;
    if (typeof extra === 'string') {
      try { extra = JSON.parse(extra); } catch { /* string kalsın */ }
    }

    if (!shopId || !event) {
      return badRequest(res, ['shopId', 'event']);
    }

    await saveEvent({ shopId, event, productHandle, buttonId, extra });
    return res.json({ ok: true });
  } catch (err) {
    const msg = process.env.DEBUG_ERRORS === '1'
      ? String(err.stack || err.message)
      : 'internal_error';
    console.error('collect error:', err);
    return res.status(500).json({ ok: false, error: msg });
  }
});

// Son çare 404 – neyin ıskaladığını göster
app.use((req, res) => {
  return res
    .status(404)
    .json({ ok: false, error: 'not_found', path: req.path, method: req.method });
});

// --- Start ---------------------------------------------
app.listen(PORT, () => {
  console.log(`Collector listening on http://localhost:${PORT}`);
});
