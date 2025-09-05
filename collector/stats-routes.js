// stats-routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('./db');
let UpstashRedis = null;
try { UpstashRedis = require('@upstash/redis').Redis; } catch (_e) { /* optional */ }
let Redis = null;
try { Redis = require('ioredis'); } catch (_e) { /* optional */ }

let upstash = null;
let redis = null;
if (UpstashRedis && ((process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) || (process.env.REDIS_URL && process.env.REDIS_TOKEN))) {
  try {
    upstash = new UpstashRedis({
      url: process.env.UPSTASH_REDIS_REST_URL || process.env.REDIS_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN || process.env.REDIS_TOKEN
    });
  } catch (_e) { upstash = null; }
}
if (Redis && (process.env.REDIS_URL || process.env.REDIS_HOST)) {
  try {
    redis = new Redis(process.env.REDIS_URL || {
      host: process.env.REDIS_HOST || '127.0.0.1',
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD || undefined,
      tls: process.env.REDIS_TLS === '1' ? {} : undefined
    });
  } catch (_e) { redis = null; }
}

function presenceKey(shopId){ return `presence:${shopId}`; }

// from/to query param'larını güvenli biçimde aralığa çevirir.
// HTML date input'ları günü 00:00 gönderdiği için "to" değerini
// ertesi gün 00:00'a çekip ÜST SINIRI DIŞLAYACAĞIZ (>= from AND < to).
function parseRange(q) {
  const dayMs = 24 * 60 * 60 * 1000;

  // from: yoksa son 7 günün başlangıcı
  const from = q.from
    ? new Date(`${q.from}T00:00:00`)
    : new Date(Date.now() - 7 * dayMs);

  // toExclusive: "to" verilmişse ertesi gün 00:00, verilmemişse şu an (bugün dahil)
  let toExclusive;
  if (q.to) {
    toExclusive = new Date(`${q.to}T00:00:00`);
    toExclusive.setDate(toExclusive.getDate() + 1);
  } else {
    toExclusive = new Date(); // now -> bugün dahil
  }

  return { from, to: toExclusive };
}

router.get('/ping', (_req, res) => res.json({ ok: true }));

// Debug endpoint - database'deki event'leri göster
router.get('/debug', async (req, res) => {
  try {
    const shopId = req.query.shopId;
    if (!shopId) return res.status(400).json({ error: 'shopId required' });

    const { rows } = await pool.query(
      `
      select event_name, count(*) as count, 
             array_agg(ts order by ts desc) as timestamps
      from events 
      where shop_id = $1 
      group by event_name 
      order by event_name
      `,
      [shopId]
    );

    res.json({ shopId, events: rows });
  } catch (e) {
    console.error('debug error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// Upstash/Redis tabanlı aktif kullanıcı sayımı (env TTL penceresinde)
router.get('/active-redis', async (req, res) => {
  try {
    const shopId = req.query.shopId;
    if (!shopId) return res.status(400).json({ error: 'shopId required' });
    const winSec = Number(req.query.window || 0);
    const ttlMs = Number(process.env.PRESENCE_TTL_MS || 20000);
    const windowMs = winSec > 0 ? (winSec * 1000) : ttlMs;
    const now = Date.now();
    const cutoff = now - windowMs;
    const key = presenceKey(shopId);
    if (upstash) {
      try {
        await upstash.zremrangebyscore(key, 0, cutoff);
        const cnt = await upstash.zcount(key, cutoff, '+inf');
        const n = typeof cnt === 'number' ? cnt : (cnt?.result ?? 0);
        return res.json({ active_users: n, source: 'upstash' });
      } catch(_e) {}
    }
    if (redis) {
      try {
        await redis.zremrangebyscore(key, 0, cutoff);
        const cnt = await redis.zcount(key, cutoff, '+inf');
        return res.json({ active_users: Number(cnt||0), source: 'redis' });
      } catch(_e) {}
    }
    return res.json({ active_users: 0, source: 'memory' });
  } catch (e) {
    console.error('active-redis error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// Cleanup endpoint - eski product_view event'lerini sil
router.post('/cleanup', async (req, res) => {
  try {
    const shopId = req.body.shopId;
    if (!shopId) return res.status(400).json({ error: 'shopId required' });

    const result = await pool.query(
      `DELETE FROM events WHERE shop_id = $1 AND event_name = 'product_view'`,
      [shopId]
    );

    res.json({ 
      message: 'Product view events cleaned up',
      deletedCount: result.rowCount,
      shopId 
    });
  } catch (e) {
    console.error('cleanup error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// Özet metrikler
router.get('/summary', async (req, res) => {
  try {
    const shopId = req.query.shopId;
    if (!shopId) return res.status(400).json({ error: 'shopId required' });

    const { from, to } = parseRange(req.query);

    const { rows } = await pool.query(
      `
      with
      views as (
        select count(*)::int as c
        from events
        where shop_id = $1
          and event_name = 'page_view_start'
          and ts >= $2 and ts < $3
      ),
      dwell as (
        select avg((payload->>'dwell_ms')::numeric)::int as ms
        from events
        where shop_id = $1
          and event_name = 'page_view_end'
          and ts >= $2 and ts < $3
      ),
      clicks as (
        select count(*)::int as c
        from events
        where shop_id = $1
          and event_name = 'click'
          and ts >= $2 and ts < $3
      )
      select (select c from views)  as views,
             (select ms from dwell) as avg_dwell_ms,
             (select c from clicks) as clicks
      `,
      [shopId, from, to]
    );

    res.json(rows[0] || { views: 0, avg_dwell_ms: 0, clicks: 0 });
  } catch (e) {
    console.error('summary error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// En çok tıklanan butonlar
router.get('/top-buttons', async (req, res) => {
  try {
    const shopId = req.query.shopId;
    if (!shopId) return res.status(400).json({ error: 'shopId required' });

    const { from, to } = parseRange(req.query);

    const { rows } = await pool.query(
      `
      select coalesce(payload->>'button_id','(unknown)') as button_id,
             count(*)::int as clicks
      from events
      where shop_id = $1
        and event_name = 'click'
        and ts >= $2 and ts < $3
      group by 1
      order by clicks desc
      limit 20
      `,
      [shopId, from, to]
    );

    res.json(rows);
  } catch (e) {
    console.error('top-buttons error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// En çok görüntülenen ürünler
router.get('/top-products', async (req, res) => {
  try {
    const shopId = req.query.shopId;
    if (!shopId) return res.status(400).json({ error: 'shopId required' });

    const { from, to } = parseRange(req.query);

    const { rows } = await pool.query(
      `
      select
        coalesce(product_handle,'(NA)') as product_handle,
        count(*) filter (where event_name = 'page_view_start')::int as views,
        (
          (avg((payload->>'dwell_ms')::numeric)
             filter (where event_name = 'page_view_end')
          )::int
        ) as avg_dwell_ms
      from events
      where shop_id = $1
        and ts >= $2 and ts < $3
      group by 1
      order by views desc
      limit 20
      `,
      [shopId, from, to]
    );

    res.json(rows);
  } catch (e) {
    console.error('top-products error', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// Canlı aktif kullanıcı sayısı - presence tablosundan stabil okuma
router.get('/active', async (req, res) => {
  try {
    const shopId = req.query.shopId;
    if (!shopId) return res.status(400).json({ error: 'shopId required' });

    const winSecParam = Number(req.query.window || 0);
    const ttlSecDefault = Number(process.env.PRESENCE_TTL_MS || 20000) / 1000;
    const ttlSec = winSecParam > 0 ? winSecParam : ttlSecDefault;
    const { rows } = await pool.query(
      `select count(*)::int as active_users
         from active_sessions
         where shop_id=$1 and active=true and last_seen > now() - interval '${ttlSec} seconds'`,
      [shopId]
    );
    return res.json({ active_users: rows[0]?.active_users || 0 });
  } catch (e) {
    console.error('active error', e);
    res.status(500).json({ error: 'server_error' });
  }
});
// Mevcut mağazaları listele (analytics için seçim kolaylığı)
router.get('/shops', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `select distinct shop_id from events order by shop_id`
    );
    res.json(rows.map(r => r.shop_id));
  } catch (e) {
    console.error('shops error', e);
    res.status(500).json({error:'server_error'});
  }
});

module.exports = router;
