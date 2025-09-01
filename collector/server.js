// collector/server.js
require('dotenv').config();

const path = require('path');
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');

const app = express();

/* ------------ DB ------------- */
const connectionString =
  process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.SUPABASE_DB_URL;

const isLocal =
  !connectionString || /localhost|127\.0\.0\.1/i.test(connectionString);

const pool = new Pool({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

/* ---------- Middlewares ---------- */
// Railway / proxy arkasında gerçek IP için
app.set('trust proxy', 1);

// Basit istek logu (teşhis için çok faydalı)
app.use((req, _res, next) => {
  console.log(`[REQ] ${req.method} ${req.url}`);
  next();
});

// CORS (gerekirse daha kısıtlı ayarlayabilirsiniz)
app.use(cors());

// JSON ve form body
app.use(express.json({ limit: '512kb' }));
app.use(express.urlencoded({ extended: true }));

// sendBeacon için: content-type genelde text/plain oluyor
app.use('/e', express.text({ type: ['text/plain'] }));

// Statik dosyalar (test-send.html, dashboard.html vb.)
app.use(express.static(__dirname));

/* ---------- Health & Root ---------- */
app.get('/healthz', (_req, res) => res.status(200).send('OK'));
app.get('/', (_req, res) =>
  res.send('HRL Tracking Collector is running. Try /healthz, /test-send.html or /stats/summary')
);

/* ---------- Event Ingest (/e) ---------- */
/**
 * test-send.html hem fetch JSON, hem de sendBeacon ile gönderiyor.
 * Beacon -> text/plain string gelir; burada JSON.parse ediyoruz.
 */
app.post('/e', async (req, res) => {
  try {
    const payload = req.is('text/plain') ? JSON.parse(req.body || '{}') : req.body || {};

    const {
      event,
      shopId,
      product_handle = null,
      button_id = null,
      dwell_ms = null,
      extra = null,
    } = payload;

    if (!event || !shopId) {
      return res.status(400).json({ ok: false, error: 'event ve shopId zorunlu' });
    }

    const userAgent = req.headers['user-agent'] || null;
    const ip =
      (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
      req.ip ||
      null;

    // events tablosu: shop_id, event, product_handle, button_id, dwell_ms, user_agent, ip, extra, ts(default now)
    const sql = `
      INSERT INTO events
        (shop_id, event, product_handle, button_id, dwell_ms, user_agent, ip, extra)
      VALUES
        ($1,      $2,    $3,             $4,        $5,        $6,        $7, $8::jsonb)
      RETURNING id
    `;
    const params = [
      shopId,
      event,
      product_handle,
      button_id,
      dwell_ms,
      userAgent,
      ip,
      extra ? JSON.stringify(extra) : null,
    ];

    await pool.query(sql, params);

    // Collector uçları için 204 ideal
    return res.status(204).end();
  } catch (err) {
    console.error('Error in /e:', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

/* ---------- Stats Routes ---------- */
// stats-routes.js bir Router export ediyorsa:
try {
  const statsRoutes = require('./stats-routes');
  // Eğer stats-routes bir fonksiyon döndürüyorsa havuzu geçelim, değilse direkt kullanılır
  const router = typeof statsRoutes === 'function' ? statsRoutes(pool) : statsRoutes;
  app.use('/stats', router);
} catch (e) {
  console.warn('stats-routes yüklenemedi:', e?.message || e);
}

/* ---------- Hata Yakalama ---------- */
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found' });
});

/* ---------- Start ---------- */
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Collector listening on http://localhost:${PORT}`);
});
