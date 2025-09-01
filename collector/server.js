// collector/server.js
require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();

// ---- Config ----
const PORT = process.env.PORT || 8080;
const LOG_REQUESTS = process.env.LOG_REQUESTS === '1';
const DEBUG_ERRORS = process.env.DEBUG_ERRORS === '1';

// Railway/Supabase gibi yönetilen PG için SSL güvenli ayar
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.PGSSLMODE === 'disable'
      ? false
      : { rejectUnauthorized: false },
});

// Reverse proxy arkasında gerçek IP'yi görebilmek için
app.set('trust proxy', 1);

// ---- Middleware ----
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));

// Basit CORS (gerekirse ALLOWED_ORIGINS ile kısıtlayabilirsin)
const allowed = (process.env.ALLOWED_ORIGINS || '*')
  .split(',')
  .map(s => s.trim());
app.use((req, res, next) => {
  const origin = req.headers.origin || '*';
  const allowOrigin =
    allowed.includes('*') || allowed.includes(origin) ? origin : allowed[0] || '*';
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// İstek logu
app.use((req, _res, next) => {
  if (LOG_REQUESTS) {
    console.log(
      `[REQ] ${req.method} ${req.originalUrl} ua="${req.headers['user-agent']}" body=${JSON.stringify(
        req.body || {}
      )}`
    );
  }
  next();
});

// Statik dosyalar (test-send.html vb.)
app.use(express.static(path.join(__dirname)));

// ---- Helpers ----
function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf && typeof xf === 'string') {
    // "ip1, ip2, ip3" => ilkini al
    return xf.split(',')[0].trim().replace(/^::ffff:/, '');
  }
  const ra = req.socket?.remoteAddress || '';
  return (ra || '').replace(/^::ffff:/, '') || null;
}

function safeJson(input) {
  if (input == null) return null;
  if (typeof input === 'object') return input;
  if (typeof input === 'string' && input.trim() === '') return null;
  try {
    return typeof input === 'string' ? JSON.parse(input) : input;
  } catch {
    return { _raw: String(input) };
  }
}

// ---- Health ----
app.get('/healthz', (_req, res) => res.json({ ok: true }));

// ---- Event Ingest (/e) ----
//
// Örnek çağrı:
// POST /e?shopId=dev-shop.myshopify.com&product=black-mug&button_id=buy-now
// body: { "event": "page_view_start", "extra": { "route": "product" } }
app.post('/e', async (req, res) => {
  const { event, extra } = req.body || {};
  const { shopId, product, product_handle, button_id } = req.query;

  if (!shopId || !event) {
    return res.status(400).json({
      ok: false,
      error: 'missing_params',
      required: ['shopId', 'event'],
    });
  }

  const ip = getClientIp(req);
  const ua = req.headers['user-agent'] || null;
  const prod =
    product ??
    product_handle ??
    req.body?.product ??
    null;

  try {
    await pool.query(
      `INSERT INTO events (shop_id, product, button_id, event, extra, user_agent, ip, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
      [shopId, prod, button_id ?? null, event, safeJson(extra), ua, ip]
    );

    if (LOG_REQUESTS) {
      console.log(`[RES] 200 OK event=${event} shop=${shopId} product=${prod || '-'}`);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('INSERT_FAIL', err.code, err.message, err.detail);
    if (DEBUG_ERRORS) {
      return res.status(500).json({
        ok: false,
        error: 'internal_error',
        code: err.code,
        message: err.message,
        detail: err.detail,
      });
    }
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// ---- Basit raporlar (/stats) ----

// Özet: toplam ve bugünün adetleri
app.get('/stats/summary', async (req, res) => {
  const { shopId } = req.query;
  if (!shopId) return res.status(400).json({ ok: false, error: 'missing shopId' });

  try {
    const total = await pool.query(
      `SELECT event, COUNT(*)::int AS count
       FROM events WHERE shop_id = $1
       GROUP BY event`,
      [shopId]
    );
    const today = await pool.query(
      `SELECT event, COUNT(*)::int AS count
       FROM events
       WHERE shop_id = $1 AND created_at >= NOW() - INTERVAL '24 hours'
       GROUP BY event`,
      [shopId]
    );

    res.json({
      ok: true,
      total_by_event: total.rows,
      last24h_by_event: today.rows,
    });
  } catch (err) {
    console.error('STATS_SUMMARY_FAIL', err);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// En çok etkileşim alan ürünler
app.get('/stats/top-products', async (req, res) => {
  const { shopId } = req.query;
  const limit = Math.min(parseInt(req.query.limit || '10', 10) || 10, 100);
  if (!shopId) return res.status(400).json({ ok: false, error: 'missing shopId' });

  try {
    const q = await pool.query(
      `SELECT
         COALESCE(product, '(unknown)') AS product,
         COUNT(*)::int AS total,
         SUM(CASE WHEN event = 'click' THEN 1 ELSE 0 END)::int AS clicks,
         SUM(CASE WHEN event = 'page_view_start' THEN 1 ELSE 0 END)::int AS views
       FROM events
       WHERE shop_id = $1
       GROUP BY product
       ORDER BY total DESC
       LIMIT $2`,
      [shopId, limit]
    );
    res.json({ ok: true, rows: q.rows });
  } catch (err) {
    console.error('TOP_PRODUCTS_FAIL', err);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// ---- Global error handler (fallback) ----
app.use((err, _req, res, _next) => {
  console.error('UNHANDLED', err);
  res.status(500).json({ ok: false, error: 'internal_error' });
});

// ---- Start ----
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Collector listening on http://localhost:${PORT}`);
});
