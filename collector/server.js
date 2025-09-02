// collector/server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();

// Proxy arkasında gerçek IP
app.set('trust proxy', true);

// Basit CORS
app.use(cors());

// sendBeacon -> content-type: text/plain gelebilir; önce onu yakalayalım
app.use((req, res, next) => {
  const ct = req.headers['content-type'] || '';
  if (req.method === 'POST' && ct.startsWith('text/plain')) {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try { req.body = data ? JSON.parse(data) : {}; }
      catch { req.body = {}; }
      next();
    });
  } else {
    next();
  }
});

// JSON body
app.use(express.json({ limit: '200kb' }));

// İsteğe bağlı basit log (morgan yoksa crash etmesin)
if (process.env.LOG_REQUESTS === '1') {
  app.use((req, _res, next) => {
    console.log(`[req] ${req.method} ${req.path}`);
    next();
  });
}

// test-send.html ve statikleri servis et (collector klasörü)
app.use(express.static(path.join(__dirname)));

// Sağlık uçları
app.get(['/', '/health', '/healthz', '/ready'], (_req, res) => {
  res.json({ ok: true, message: 'collector alive', time: new Date().toISOString() });
});

// --- DB havuzu (opsiyonel) ---
let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
}

// --- Veri toplama uçları ---
// Geriye dönük uyumluluk için 3 yol da açık:
const COLLECT_PATHS = ['/collect', '/api/collect', '/collector/collect'];

app.post(COLLECT_PATHS, async (req, res) => {
  const { shopId, event, productHandle, buttonId, extra } = req.body || {};

  if (!shopId || !event) {
    return res.status(400).json({
      ok: false,
      error: 'missing_params',
      required: ['shopId', 'event']
    });
  }

  const record = {
    shopId,
    event,
    productHandle: productHandle || null,
    buttonId: buttonId || null,
    extra: extra || null,
    ip: req.ip
  };

  try {
    if (pool) {
      await pool.query(
        `insert into events (shop_id, event_name, product_handle, payload, ts)
         values ($1,$2,$3,$4, now())`,
        [record.shopId, record.event, record.productHandle, record.extra ? JSON.stringify(record.extra) : null]
      );
    } else {
      // DB yoksa en azından loglayalım
      console.log('EVENT (no-db):', record);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('DB error:', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// 404'leri JSON döndür
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found', method: req.method, path: req.path });
});

// Hata yakalayıcı
app.use((err, _req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ ok: false, error: 'unhandled' });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Collector listening on http://localhost:${PORT}`);
});
