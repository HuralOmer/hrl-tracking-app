// collector/server.js
const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const { Pool } = require('pg');

const app = express();

// --- Middleware'ler ---
app.use(cors());
// Log
app.use(morgan('tiny'));

// sendBeacon genelde content-type: text/plain ile gelir; önce raw'ı yakalayalım
app.use((req, res, next) => {
  const ct = req.headers['content-type'] || '';
  if (req.method === 'POST' && ct.startsWith('text/plain')) {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', chunk => (data += chunk));
    req.on('end', () => {
      try {
        req.body = data ? JSON.parse(data) : {};
      } catch {
        req.body = {};
      }
      next();
    });
  } else {
    next();
  }
});

// fetch için JSON parser
app.use(express.json({ limit: '200kb' }));

// test-send.html'i ve diğer statik dosyaları servis et
app.use(express.static(path.join(__dirname)));

// --- Sağlık kontrolü ---
app.get('/health', (_req, res) => {
  res.json({ ok: true });
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
// Hem /collect hem de /api/collect kabul edilsin
app.post(['/collect', '/api/collect'], async (req, res) => {
  const { shopId, event, productHandle, buttonId, extra } = req.body || {};

  if (!shopId || !event) {
    return res
      .status(400)
      .json({ ok: false, error: 'missing_params', required: ['shopId', 'event'] });
  }

  // Kayıt (DB varsa)
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
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
});

// Yakalanmayan istekler
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
