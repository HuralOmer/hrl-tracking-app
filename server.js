// collector/server.js
const express = require('express');
const cors = require('cors');
const path = require('path');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 8080;

// CORS + body parsers
app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Test sayfasını ve diğer statik dosyaları servis et (test-send.html vb.)
app.use(express.static(__dirname));

// Sağlık kontrolü
app.get(['/health', '/'], (req, res) => res.json({ ok: true, service: 'collector' }));

// Ortak payload toplayıcı
function parsePayload(req) {
  const isGet = req.method === 'GET';
  const src = isGet ? req.query : (req.body || {});

  const shopId =
    src.shopId || src.shopid || src.shop || src.shop_id || src['shop-id'];
  const event = src.event || src.evt || src.type;
  const productHandle =
    src.productHandle || src.product || src.handle || src.product_handle;
  const buttonId = src.buttonId || src.button || src.btn || src.button_id;

  let extra = src.extra;
  if (typeof extra === 'string') {
    try { extra = JSON.parse(extra); } catch { /* string kalsın */ }
  }

  const ip =
    req.headers['cf-connecting-ip'] ||
    req.headers['x-forwarded-for'] ||
    req.socket?.remoteAddress ||
    null;

  return {
    shopId,
    event,
    productHandle: productHandle || null,
    buttonId: buttonId || null,
    extra: extra ?? null,
    ip,
    ua: req.headers['user-agent'] || null,
  };
}

async function handleCollect(req, res) {
  const p = parsePayload(req);

  if (!p.shopId || !p.event) {
    return res
      .status(400)
      .json({ ok: false, error: 'missing_params', required: ['shopId', 'event'] });
  }

  try {
    await db.query(
      `INSERT INTO events
       (shop_id, event, product_handle, button_id, extra, ip, ua, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())`,
      [
        p.shopId,
        p.event,
        p.productHandle,
        p.buttonId,
        p.extra ? JSON.stringify(p.extra) : null,
        p.ip,
        p.ua,
      ]
    );

    return res.json({ ok: true });
  } catch (err) {
    console.error('DB insert failed:', err);
    return res.status(500).json({ ok: false, error: 'internal_error' });
  }
}

// Esas toplama endpoint’leri (GET/POST hepsi)
app.all(['/collect', '/api/collect', '/e'], handleCollect);

// Son çare 404 (JSON döner, debug için path gösterir)
app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'not_found', path: req.path });
});

app.listen(PORT, () => {
  console.log(`Collector listening on http://localhost:${PORT}`);
});
