// collector/server.js
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const statsRoutes = require('./stats-routes');
const crypto = require('crypto');

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

// CSP ve X-Frame-Options: statik dosyalardan ÖNCE uygulansın (admin iframe + dashboard.html)
app.use((req, res, next) => {
  if (req.path.startsWith('/admin') || req.path.startsWith('/auth') || req.path === '/dashboard.html') {
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self' https:; frame-ancestors 'self' https://admin.shopify.com https://*.myshopify.com; script-src 'self' https: 'unsafe-inline'; style-src 'self' https: 'unsafe-inline'"
    );
    // XFO: Shopify (cross-origin) ve kendi iç iframe için engelleme olmasın
    res.setHeader('X-Frame-Options', 'ALLOWALL');
  }
  next();
});

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

// Webhook'lar için ham body (HMAC doğrulama) - JSON parser'dan ÖNCE
app.use('/webhooks', express.raw({ type: 'application/json' }));

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
  if (req.path.startsWith('/admin') || req.path.startsWith('/auth') || req.path === '/dashboard.html') {
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
  // Shopify dışında (host yoksa) doğrudan dashboard'a yönlendir
  if (!host) {
    return res.redirect('/dashboard.html');
  }
  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Hrl Store Tracker — Admin</title>
  <script src="https://unpkg.com/@shopify/app-bridge@3"></script>
  <style>
    body{font-family:system-ui,Arial;margin:0;padding:0;background:#fff}
    header{padding:20px 24px;border-bottom:1px solid #eee}
    .frame{position:fixed;top:64px;left:0;right:0;bottom:0;border:0;width:100%;height:calc(100vh - 64px)}
    .hint{color:#666;font-size:14px}
  </style>
</head>
<body>
  <header>
    <h1 style="margin:0">Hrl Store Tracker — Admin</h1>
    <div class="hint" id="app">Loading...</div>
  </header>
  <iframe class="frame" id="dash" src="/dashboard.html" title="Dashboard"></iframe>
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
      // host -> shop domain çözümlemesi (base64 decode + "admin.shopify.com/store/<shop>/apps")
      try {
        if (host) {
          var decoded = atob(host);
          var m = decoded.match(/store\/([^/?#]+)/);
          var shopPart = m && m[1];
          if (shopPart) {
            var shopDomain = shopPart + '.myshopify.com';
            // iframe yüklenince shop alanını otomatik doldur
            var f = document.getElementById('dash');
            f.addEventListener('load', function(){
              try {
                var w = f.contentWindow;
                var input = w.document && w.document.getElementById('shop');
                if (input) {
                  input.value = shopDomain;
                  try { w.localStorage.setItem('hrl.shop', shopDomain); } catch(e){}
                }
              } catch(e){}
            });
          }
        }
      } catch(e) {}
      document.getElementById('app').innerHTML = 'Embedded dashboard yüklendi.';
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

  // Debug modu: yalnıza AUTH_DEBUG=1 iken ve ?debug=1 verildiğinde JSON göster
  if (process.env.AUTH_DEBUG === '1' && req.query.debug === '1') {
    return res.json({ shop, scopes, redirectUri, authUrl });
  }

  res.redirect(authUrl);
});

// OAuth callback (yalın doğrulama alanı için iskelet)
app.get('/auth/callback', async (req, res) => {
  try {
    const { shop, code, hmac, host } = req.query;
    if (!shop || !code || !hmac) {
      return res.status(400).send('missing params');
    }

    // HMAC doğrulama
    const params = { ...req.query };
    delete params.signature;
    delete params.hmac;
    const message = Object.keys(params)
      .sort()
      .map((k) => `${k}=${params[k]}`)
      .join('&');
    const generated = crypto
      .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
      .update(message)
      .digest('hex');
    if (generated !== hmac) {
      return res.status(400).send('invalid hmac');
    }

    // Access token al
    const tokenResp = await fetch(`https://${shop}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: process.env.SHOPIFY_API_KEY,
        client_secret: process.env.SHOPIFY_API_SECRET,
        code
      })
    });
    const tokenJson = await tokenResp.json();
    const accessToken = tokenJson.access_token;
    const scopeStr = tokenJson.scope;
    if (!accessToken) {
      return res.status(500).send('token exchange failed');
    }

    // DB'ye kaydet (varsa güncelle)
    if (pool) {
      await pool.query(
        `insert into shop_tokens (shop_domain, access_token, scopes, created_at)
         values ($1,$2,$3, now())
         on conflict (shop_domain) do update set access_token = excluded.access_token, scopes = excluded.scopes`,
        [shop, accessToken, scopeStr]
      );
    }

    // Uninstall webhook kaydı (idempotent)
    try {
      await fetch(`https://${shop}/admin/api/2024-07/webhooks.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          webhook: {
            topic: 'app/uninstalled',
            address: `${process.env.APP_URL}/webhooks/app_uninstalled`,
            format: 'json'
          }
        })
      });
    } catch (e) {
      console.warn('Webhook register failed:', e && e.message);
    }

    return res.redirect(`/admin?host=${encodeURIComponent(host || '')}`);
  } catch (err) {
    console.error('OAuth callback error:', err);
    return res.status(500).send('oauth_error');
  }
});

// Stats API routes
app.use('/stats', statsRoutes);

// Sağlık uçları
app.get(['/', '/health', '/healthz', '/ready'], (_req, res) => {
  res.json({ ok: true, message: 'collector alive', time: new Date().toISOString() });
});

// Webhook alıcısı: app/uninstalled
app.post('/webhooks/app_uninstalled', (req, res) => {
  try {
    const hmacHeader = req.get('X-Shopify-Hmac-Sha256');
    const topic = req.get('X-Shopify-Topic');
    const shop = req.get('X-Shopify-Shop-Domain');
    const bodyBuffer = Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(typeof req.body === 'string' ? req.body : JSON.stringify(req.body));

    if (topic !== 'app/uninstalled') {
      return res.status(400).send('invalid topic');
    }

    const digest = crypto
      .createHmac('sha256', process.env.SHOPIFY_API_SECRET)
      .update(bodyBuffer)
      .digest('base64');
    if (digest !== hmacHeader) {
      return res.status(401).send('invalid hmac');
    }

    // Token kaydını temizle
    (async () => {
      try {
        if (pool && shop) {
          await pool.query('delete from shop_tokens where shop_domain=$1', [shop]);
        }
      } catch (e) {
        console.warn('webhook cleanup error:', e && e.message);
      }
    })();

    res.status(200).send('ok');
  } catch (err) {
    console.error('webhook error:', err);
    res.status(500).send('error');
  }
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
