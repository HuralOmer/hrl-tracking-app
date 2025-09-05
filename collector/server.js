// collector/server.js
require('dotenv').config();

const express = require('express');
const http = require('http');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const statsRoutes = require('./stats-routes');
const crypto = require('crypto');
const { Server: IOServer } = require('socket.io');
let UpstashRedis = null;
try { UpstashRedis = require('@upstash/redis').Redis; } catch (_e) { /* optional */ }
let Redis = null;
try { Redis = require('ioredis'); } catch (_e) { /* optional */ }

const app = express();
const server = http.createServer(app);
const io = new IOServer(server, { cors: { origin: '*'} });

// --- Dedup: Redis tercih; yoksa in-memory ---
const DEDUP_TTL_MS = 1500; // 1.5 saniye
const DEDUP_TTL_SEC = Math.ceil(DEDUP_TTL_MS / 1000);
let redis = null;
let upstash = null;
// ioredis'i yalnızca GEÇERLİ bir yapılandırma varsa aç
if (Redis) {
  const url = (process.env.REDIS_URL || '').trim();
  const hasValidUrl = /^rediss?:\/\//i.test(url);
  const hasHost = Boolean((process.env.REDIS_HOST || '').trim());
  if (hasValidUrl || hasHost) {
    try {
      redis = new Redis(hasValidUrl ? url : {
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT || 6379),
        password: process.env.REDIS_PASSWORD || undefined,
        tls: process.env.REDIS_TLS === '1' ? {} : undefined,
        lazyConnect: true,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null
      });
      redis.on('error', (e) => {
        console.warn('Redis error:', e && e.message);
      });
      // Bağlantıyı dene; başarısızsa tamamen devre dışı bırak
      redis.connect().catch((e) => {
        console.warn('Redis connect failed, disabling:', e && e.message);
        try { redis.disconnect(); } catch(_) {}
        redis = null;
      });
    } catch (e) {
      console.warn('Redis init failed, fallback to memory:', e && e.message);
      redis = null;
    }
  }
}
if (UpstashRedis && (
  (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) ||
  (process.env.REDIS_URL && process.env.REDIS_TOKEN)
)) {
  try {
    const restUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL;
    const restToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_TOKEN;
    upstash = new UpstashRedis({ url: restUrl, token: restToken });
  } catch (e) {
    console.warn('Upstash init failed:', e && e.message);
    upstash = null;
  }
}

const dedupCache = new Map();
function dedupKey({ shopId, event, productHandle, buttonId }, ip) {
  return [shopId, event, productHandle || '', buttonId || '', ip || ''].join('|');
}
async function dedupCheckAndMark(key) {
  // Redis varsa SET NX EX ile atomik kontrol
  if (redis) {
    try {
      const ok = await redis.set(`dedup:${key}`, '1', 'EX', DEDUP_TTL_SEC, 'NX');
      return ok === null ? true : false; // NX başarısızsa null döner => daha önce var => dedup
    } catch (_e) {
      // sessizce memory'e düş
    }
  }
  const now = Date.now();
  for (const [k, t] of dedupCache) {
    if (now - t > DEDUP_TTL_MS) dedupCache.delete(k);
  }
  const last = dedupCache.get(key);
  dedupCache.set(key, now);
  return Boolean(last) && (now - last < DEDUP_TTL_MS);
}

// --- Presence (aktif kullanıcılar) ---
const PRESENCE_TTL_MS = 15_000; // aktif sayımı için 15 saniye penceresi
function presenceKey(shopId){ return `presence:${shopId}`; }

async function presenceTrimAndCount(shopId, now) {
  const key = presenceKey(shopId);
  const cutoff = now - PRESENCE_TTL_MS;
  // Trim and count
  try {
    if (upstash) {
      await upstash.zremrangebyscore(key, 0, cutoff);
      const cnt = await upstash.zcount(key, cutoff, '+inf');
      return typeof cnt === 'number' ? cnt : (cnt?.result ?? 0);
    }
    if (redis) {
      await redis.zremrangebyscore(key, 0, cutoff);
      const cnt = await redis.zcount(key, cutoff, '+inf');
      return Number(cnt || 0);
    }
  } catch (_e) {}
  // Memory fallback (kaba)
  const mem = presenceMemory.get(key) || new Map();
  for (const [m, t] of mem) { if (t < cutoff) mem.delete(m); }
  presenceMemory.set(key, mem);
  return mem.size;
}

async function presenceUpsert(shopId, member, score) {
  const key = presenceKey(shopId);
  try {
    if (upstash) { await upstash.zadd(key, { score, member }); return; }
    if (redis) { await redis.zadd(key, score, member); return; }
  } catch (_e) {}
  // memory fallback
  const mem = presenceMemory.get(key) || new Map();
  mem.set(member, score);
  presenceMemory.set(key, mem);
}

async function presenceRemove(shopId, member) {
  const key = presenceKey(shopId);
  try {
    if (upstash) { await upstash.zrem(key, member); return; }
    if (redis) { await redis.zrem(key, member); return; }
  } catch (_e) {}
  const mem = presenceMemory.get(key) || new Map();
  mem.delete(member);
  presenceMemory.set(key, mem);
}

const presenceMemory = new Map(); // key -> Map(member -> ts)

// --- Active yayınını coalesce + histerezis ile sınırlama ---
const emitStateByShop = new Map(); // shopId -> { lastCount, lastEmit, pending, timer, lastDecreaseProbe }
const EMIT_MIN_INTERVAL_MS = 1000; // en fazla saniyede 1 yayın
const DECREASE_DELAY_MS = 1500; // azalışları geciktir (histerezis)

function scheduleActiveEmit(shopId, nextCount) {
  const now = Date.now();
  const state = emitStateByShop.get(shopId) || { lastCount: 0, lastEmit: 0, pending: null, timer: null, lastDecreaseProbe: 0 };
  // Histerezis: azalış varsa önce probela, ikinci ölçümde de düşükse yayınla
  if (nextCount < state.lastCount) {
    if (!state.lastDecreaseProbe || (now - state.lastDecreaseProbe) > DECREASE_DELAY_MS) {
      state.lastDecreaseProbe = now;
      // ilk probede hemen yayınlama; bir sonrakini bekle
      emitStateByShop.set(shopId, state);
      return;
    }
  } else {
    // artışta probe sıfırla
    state.lastDecreaseProbe = 0;
  }

  const emitNow = now - state.lastEmit >= EMIT_MIN_INTERVAL_MS;
  const doEmit = () => {
    state.lastEmit = Date.now();
    state.pending = null;
    state.timer && clearTimeout(state.timer);
    state.timer = null;
    state.lastCount = nextCount;
    io.to(`shop:${shopId}`).emit('active', { shopId, active: nextCount });
  };

  if (emitNow) {
    doEmit();
  } else {
    state.pending = nextCount;
    const wait = EMIT_MIN_INTERVAL_MS - (now - state.lastEmit);
    state.timer && clearTimeout(state.timer);
    state.timer = setTimeout(() => {
      const latest = state.pending != null ? state.pending : state.lastCount;
      state.pending = null;
      doEmit(latest);
    }, Math.max(0, wait));
  }
  emitStateByShop.set(shopId, state);
}

io.on('connection', (socket) => {
  let shopId = null;
  let sessionId = null;
  let watchShop = null;

  socket.on('hello', async (payload = {}) => {
    try {
      shopId = (payload.shopId || '').trim();
      sessionId = (payload.sessionId || '').trim() || socket.id;
      if (!shopId) return;
      const member = `${sessionId}`;
      const now = Date.now();
      await presenceUpsert(shopId, member, now);
      socket.join(`shop:${shopId}`);
      const count = await presenceTrimAndCount(shopId, now);
      scheduleActiveEmit(shopId, count);
    } catch (_e) {}
  });

  // Dashboard izleme: sadece sayı dinlemek için
  socket.on('watch', async (payload = {}) => {
    try {
      const s = (payload.shopId || '').trim();
      if (!s) return;
      if (watchShop) socket.leave(`shop:${watchShop}`);
      watchShop = s;
      socket.join(`shop:${s}`);
      const count = await presenceTrimAndCount(s, Date.now());
      socket.emit('active', { shopId: s, active: count });
    } catch (_e) {}
  });

  socket.on('ping', async () => {
    if (!shopId || !sessionId) return;
    const now = Date.now();
    await presenceUpsert(shopId, `${sessionId}`, now);
    const count = await presenceTrimAndCount(shopId, now);
    scheduleActiveEmit(shopId, count);
  });

  socket.on('disconnect', async () => {
    if (!shopId || !sessionId) return;
    try {
      await presenceRemove(shopId, `${sessionId}`);
      const count = await presenceTrimAndCount(shopId, Date.now());
      scheduleActiveEmit(shopId, count);
    } catch (_e) {}
  });
});

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
      // host -> shop domain çözümlemesi (base64url decode + "admin.shopify.com/store/<shop>/apps")
      try {
        if (host) {
          var h = host.replace(/-/g,'+').replace(/_/g,'/');
          while (h.length % 4) h += '=';
          var decoded = atob(h);
          var m = decoded.indexOf('store/');
          var shopPart = m !== -1 ? decoded.substring(m + 6) : null;
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
      // İlk durumda Loading göster; iframe load olduğunda temizlenecek
      (function(){
        var f = document.getElementById('dash');
        f.addEventListener('load', function(){
          var el = document.getElementById('app');
          if (el) el.textContent = '';
        });
      })();
      document.getElementById('app').innerHTML = 'Loading...';
      // Dashboard'tan 'hrl:loaded' mesajı gelirse header'ı temizle
      window.addEventListener('message', function(ev){
        try {
          if (ev && ev.data && ev.data.type === 'hrl:loaded') {
            var el = document.getElementById('app');
            if (el) el.textContent = '';
          }
        } catch(e){}
      });
    })();
  </script>
</body>
</html>`;
  res.type('html').send(html);
});

// --- Yönetim: ScriptTag liste/kur ---
app.get('/admin/script-tags', async (req, res) => {
  try {
    const shop = (req.query.shop || '').trim();
    if (!shop) return res.status(400).json({ ok: false, error: 'shop required' });
    if (!pool) return res.status(500).json({ ok: false, error: 'db_unavailable' });
    const r = await pool.query('select access_token from shop_tokens where shop_domain=$1', [shop]);
    const token = r.rows[0]?.access_token;
    if (!token) return res.status(404).json({ ok: false, error: 'token_not_found' });
    const resp = await fetch(`https://${shop}/admin/api/2024-07/script_tags.json`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    const data = await resp.json();
    return res.json({ ok: true, data });
  } catch (e) {
    console.error('script-tags list error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

app.post('/admin/script-tags/install', async (req, res) => {
  try {
    const shop = (req.query.shop || '').trim();
    if (!shop) return res.status(400).json({ ok: false, error: 'shop required' });
    if (!pool) return res.status(500).json({ ok: false, error: 'db_unavailable' });
    const r = await pool.query('select access_token from shop_tokens where shop_domain=$1', [shop]);
    const token = r.rows[0]?.access_token;
    if (!token) return res.status(404).json({ ok: false, error: 'token_not_found' });
    const src = `${process.env.APP_URL}/tracking-script.js`;
    const resp = await fetch(`https://${shop}/admin/api/2024-07/script_tags.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ script_tag: { event: 'onload', src } })
    });
    const data = await resp.json();
    return res.json({ ok: true, data });
  } catch (e) {
    console.error('script-tags install error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Convenience: allow GET as well for quick manual trigger
app.get('/admin/script-tags/install', async (req, res) => {
  try {
    const shop = (req.query.shop || '').trim();
    if (!shop) return res.status(400).json({ ok: false, error: 'shop required' });
    if (!pool) return res.status(500).json({ ok: false, error: 'db_unavailable' });
    const r = await pool.query('select access_token from shop_tokens where shop_domain=$1', [shop]);
    const token = r.rows[0]?.access_token;
    if (!token) return res.status(404).json({ ok: false, error: 'token_not_found' });
    const src = `${process.env.APP_URL}/tracking-script.js`;
    const resp = await fetch(`https://${shop}/admin/api/2024-07/script_tags.json`, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ script_tag: { event: 'onload', src } })
    });
    const data = await resp.json();
    return res.json({ ok: true, data });
  } catch (e) {
    console.error('script-tags install (GET) error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Temizlik: tüm ScriptTag'ları listeler, en yeni dışındakileri siler
app.post('/admin/script-tags/cleanup', async (req, res) => {
  try {
    const shop = (req.query.shop || '').trim();
    if (!shop) return res.status(400).json({ ok: false, error: 'shop required' });
    if (!pool) return res.status(500).json({ ok: false, error: 'db_unavailable' });
    const r = await pool.query('select access_token from shop_tokens where shop_domain=$1', [shop]);
    const token = r.rows[0]?.access_token;
    if (!token) return res.status(404).json({ ok: false, error: 'token_not_found' });

    // listele
    const listResp = await fetch(`https://${shop}/admin/api/2024-07/script_tags.json`, {
      headers: { 'X-Shopify-Access-Token': token }
    });
    const listData = await listResp.json();
    const tags = Array.isArray(listData?.script_tags) ? listData.script_tags : [];
    if (tags.length <= 1) return res.json({ ok: true, deleted: 0, kept: tags[0]?.id || null });

    // en yeni hariç hepsini sil
    const sorted = tags.slice().sort((a,b)=> new Date(b.created_at) - new Date(a.created_at));
    const keep = sorted[0];
    let deleted = 0;
    for (let i=1;i<sorted.length;i++) {
      const id = sorted[i].id;
      try {
        await fetch(`https://${shop}/admin/api/2024-07/script_tags/${id}.json`, {
          method: 'DELETE',
          headers: { 'X-Shopify-Access-Token': token }
        });
        deleted++;
      } catch(_) {}
    }
    return res.json({ ok: true, deleted, kept: keep?.id || null });
  } catch (e) {
    console.error('script-tags cleanup error', e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
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

    // ScriptTag: tracking-script.js otomatik yüklensin
    try {
      await fetch(`https://${shop}/admin/api/2024-07/script_tags.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': accessToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          script_tag: {
            event: 'onload',
            src: `${process.env.APP_URL}/tracking-script.js`
          }
        })
      });
    } catch (e) {
      console.warn('ScriptTag register failed:', e && e.message);
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
    if (await dedupCheckAndMark(key)) {
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

      // active_sessions: boolean + last_seen ile upsert
      const sid = (record.extra && record.extra.session_id) || null;
      if (sid && (record.event === 'visit_start' || record.event === 'visit_heartbeat')) {
        // Presence: ZADD (Upstash/Redis)
        try {
          const member = String(sid);
          const score = Date.now();
          if (upstash) { await upstash.zadd(presenceKey(record.shopId), { score, member }); }
          else if (redis) { await redis.zadd(presenceKey(record.shopId), score, member); }
          else {
            const mem = presenceMemory.get(presenceKey(record.shopId)) || new Map();
            mem.set(member, score);
            presenceMemory.set(presenceKey(record.shopId), mem);
          }
        } catch(_e){}
        await pool.query(
          `insert into active_sessions (shop_id, session_id, active, last_seen)
           values ($1,$2,true,now())
           on conflict (shop_id, session_id)
           do update set active=true, last_seen=excluded.last_seen`,
          [record.shopId, sid]
        );
      }
      if (sid && record.event === 'visit_end') {
        // Presence: ZREM
        try {
          const member = String(sid);
          if (upstash) { await upstash.zrem(presenceKey(record.shopId), member); }
          else if (redis) { await redis.zrem(presenceKey(record.shopId), member); }
          else {
            const mem = presenceMemory.get(presenceKey(record.shopId)) || new Map();
            mem.delete(member);
            presenceMemory.set(presenceKey(record.shopId), mem);
          }
        } catch(_e){}
        await pool.query(
          `insert into active_sessions (shop_id, session_id, active, last_seen)
           values ($1,$2,false,now())
           on conflict (shop_id, session_id)
           do update set active=false, last_seen=excluded.last_seen`,
          [record.shopId, sid]
        ).catch(()=>{});
      }
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
server.listen(PORT, () => {
  console.log(`Collector listening on http://localhost:${PORT}`);
});
