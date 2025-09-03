// collector/server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const statsRoutes = require('./stats-routes');

const app = express();

// --- Basit in-memory dedup (kısa TTL) ---
const DEDUP_TTL_MS = 1500; // 1.5 saniye
const dedupCache = new Map();
function dedupKey({ shopId, event, productHandle, buttonId }, ip) {
  return [shopId, event, productHandle || '', buttonId || '', ip || ''].join('|');
}
function dedupCheckAndMark(key) {
  const now = Date.now();
  for (const [k, t] of dedupCache) {
    if (now - t > DEDUP_TTL_MS) dedupCache.delete(k);
  }
  const last = dedupCache.get(key);
  dedupCache.set(key, now);
  return Boolean(last) && (now - last < DEDUP_TTL_MS);
}

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

// Embedded admin için temel CSP (Shopify admin iframe'i)
app.use((req, res, next) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/auth')) {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self' https:; frame-ancestors https://admin.shopify.com https://*.myshopify.com; script-src 'self' https: 'unsafe-inline'; style-src 'self' https: 'unsafe-inline'"
    );
  }
  next();
});

// Basit embedded admin shell (App Bridge başlatır)
app.get('/admin', (req, res) => {
  const apiKey = process.env.SHOPIFY_API_KEY || '';
  const { host } = req.query;
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Hrl Store Tracker — Admin</title>
  <script src="https://unpkg.com/@shopify/app-bridge@3"></script>
  <style>body{font-family:system-ui,Arial;padding:24px}</style>
</head>
<body>
  <h1>Hrl Store Tracker — Admin</h1>
  <div id="app">Loading...</div>
  <script>
    (function(){
      var apiKey = ${JSON.stringify(apiKey)};
      var host = new URLSearchParams(window.location.search).get('host') || ${JSON.stringify(host || '')};
      if (!apiKey) {
        document.getElementById('app').innerText = 'Missing SHOPIFY_API_KEY on server.';
        return;
      }
      if (!host) {
        console.warn('Missing host param');
      }
      var AppBridge = window['app-bridge'] && window['app-bridge'].default;
      if (AppBridge) {
        window.appBridge = AppBridge({ apiKey: apiKey, host: host, forceRedirect: true });
      }
      document.getElementById('app').innerHTML = '<p>Embedded dashboard yakında burada. Geçici olarak <a href="/dashboard.html" target="_blank">harici dashboard</a>.</p>';
    })();
  </script>
</body>
</html>`;
  res.type('html').send(html);
});

// OAuth başlangıç (iskelet)
app.get('/auth', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).send('missing shop');
  const apiKey = process.env.SHOPIFY_API_KEY;
  const redirectUri = `${process.env.APP_URL || ''}/auth/callback`;
  const scopes = (process.env.SHOPIFY_SCOPES || '').trim();
  const authUrl = `https://${shop}/admin/oauth/authorize?client_id=${encodeURIComponent(apiKey)}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}&grant_options[]=per-user`;
  res.redirect(authUrl);
});

// OAuth callback (yalın doğrulama alanı için iskelet)
app.get('/auth/callback', (req, res) => {
  // Not: Üretimde HMAC doğrulaması ve access token değişimi yapılmalı
  // Şimdilik sadece admin shell'e yönlendiriyoruz
  const { host } = req.query;
  return res.redirect(`/admin?host=${encodeURIComponent(host || '')}`);
});

// Stats API routes
app.use('/stats', statsRoutes);

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

  // Dedup koruması: aynı anahtardan kısa sürede tekrar gelirse atla
  try {
    const key = dedupKey({ shopId, event, productHandle, buttonId }, req.ip);
    if (dedupCheckAndMark(key)) {
      return res.json({ ok: true, dedup: true });
    }
  } catch (_e) {
    // sessiz geç; dedup hatası olsa bile ana akışa devam edelim
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
