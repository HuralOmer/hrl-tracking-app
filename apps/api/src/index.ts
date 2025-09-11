import Fastify from 'fastify';
import cors from '@fastify/cors';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import Redis from 'ioredis';
import { Redis as UpstashRedis } from '@upstash/redis';
import crypto from 'node:crypto';

async function bootstrap(): Promise<void> {
  const fastify = Fastify({ logger: true });
  await fastify.register(cors, {
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['*'],
  });

  // DB bağlantısı opsiyonel: DEV ortamında DATABASE_URL yoksa graceful degrade
  const hasDb = !!process.env.DATABASE_URL;
  const pool = hasDb ? new Pool({ connectionString: process.env.DATABASE_URL }) : null as unknown as Pool;
  const db = hasDb ? drizzle(pool) : (null as any);
  
  const redisUrl = process.env.REDIS_URL || '';
  const useRest = !!process.env.UPSTASH_REDIS_REST_URL && !!process.env.UPSTASH_REDIS_REST_TOKEN;
  const redis = useRest
    ? new UpstashRedis({
        url: process.env.UPSTASH_REDIS_REST_URL as string,
        token: process.env.UPSTASH_REDIS_REST_TOKEN as string,
      })
    : redisUrl
      ? redisUrl.startsWith('rediss://')
        ? new (Redis as any)(redisUrl, { tls: {} })
        : new (Redis as any)(redisUrl)
      : null;
      
  if ((redis as any)?.on) {
    (redis as any).on('error', (err: any) => fastify.log.error({ err }, 'redis error'));
  }

  const ACTIVE_WINDOW_SEC = 60;

  // Health check
  fastify.get('/health', async () => ({ ok: true }));

  // Presence beat endpoint
  fastify.post('/presence/beat', async (req: any, reply: any) => {
    const body = z
      .object({ shop: z.string(), session_id: z.string(), ts: z.number() })
      .parse(req.body);
    
    if (!redis) {
      return reply.send({ ok: true, note: 'no_redis_dev' });
    }
    
    const key = `presence:${body.shop}`;
    if (useRest) {
      await (redis as UpstashRedis).zadd(key, { score: body.ts / 1000, member: body.session_id });
      await (redis as UpstashRedis).expire(key, 300);
    } else {
      await (redis as any).zadd(key, body.ts / 1000, body.session_id);
      await (redis as any).expire(key, 300);
    }
    reply.send({ ok: true });
  });

  // Presence stream endpoint
  fastify.get('/presence/stream', async (req: any, reply: any) => {
    const q = (req.query as any) as Record<string, string>;
    const shop = q.shop as string;

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('Access-Control-Allow-Origin', '*');
    reply.raw.write(`:\n\n`);
    
    const interval = setInterval(async () => {
      const now = Math.floor(Date.now() / 1000);
      const key = `presence:${shop}`;
      
      if (redis) {
        if (useRest) {
          await (redis as UpstashRedis).zremrangebyscore(key, 0, now - ACTIVE_WINDOW_SEC);
        } else {
          await (redis as any).zremrangebyscore(key, 0, now - ACTIVE_WINDOW_SEC);
        }
        
        const current = useRest
          ? Number(await (redis as UpstashRedis).zcount(key, now - ACTIVE_WINDOW_SEC, '+inf'))
          : await (redis as any).zcount(key, now - ACTIVE_WINDOW_SEC, '+inf');

        reply.raw.write(`data: ${JSON.stringify({ current, display: current, strategy: 'raw' })}\n\n`);
      } else {
        reply.raw.write(`data: ${JSON.stringify({ current: 0, display: 0, strategy: 'raw' })}\n\n`);
      }
    }, 2000);

    (req.raw as any).on('close', () => clearInterval(interval));
  });

  // Collect endpoint
  fastify.post('/collect', async (req: any, reply: any) => {
    const body = z.object({
      event: z.string(),
      ts: z.number().optional(),
      session_id: z.string(),
      shop_domain: z.string(),
      page: z
        .object({ path: z.string().optional(), title: z.string().optional(), ref: z.string().optional() })
        .optional(),
      duration_ms: z.number().optional(),
      payload: z.any().optional(),
      event_id: z.string().optional(),
    }).parse(req.body);

    if (!hasDb) {
      return reply.send({ ok: true, note: 'no_db_dev' });
    }

    // Upsert shop by domain
    const shopRes = await pool.query(
      'insert into shops(domain) values ($1) on conflict(domain) do update set domain=excluded.domain returning id',
      [body.shop_domain]
    );
    const shopId: string = shopRes.rows[0].id;

    // Upsert session
    const ipHeader = (req.headers['x-forwarded-for'] as string) || '';
    const ip = (ipHeader.split(',')[0] || req.ip || null) as any;
    const ua = (req.headers['user-agent'] as string) || null;
    const ref = body.page?.ref || null;
    await pool.query(
      'insert into sessions(id, shop_id, first_seen, last_seen, ip, ua, referrer) values ($1,$2,now(),now(),$3,$4,$5) on conflict(id) do update set last_seen=now(), ip=coalesce(excluded.ip, sessions.ip), ua=coalesce(excluded.ua, sessions.ua), referrer=coalesce(excluded.referrer, sessions.referrer)',
      [body.session_id, shopId, ip, ua, ref]
    );

    // Insert event
    const tsMs = body.ts ?? Date.now();
    await pool.query(
      'insert into events(shop_id, session_id, name, ts, page_path, payload, event_id) values ($1,$2,$3, to_timestamp($4/1000.0), $5, $6, $7) on conflict(event_id) do nothing',
      [shopId, body.session_id, body.event, tsMs, body.page?.path || null, body.payload ?? null, body.event_id || null]
    );

    reply.send({ ok: true });
  });

  // App Proxy endpoints
  function verifyAppProxySignature(req: any): boolean {
    const url = req.raw.url as string;
    const parsed = req.query as Record<string, any>;
    if (parsed?.dev === '1') return true; // dev bypass
    const provided = parsed?.signature as string | undefined;
    const secret = process.env.APP_PROXY_SECRET;
    if (!secret || !provided) return false;
    const canonical = Object.entries(parsed)
      .filter(([k]) => k !== 'signature')
      .map(([k, v]) => [k, Array.isArray(v) ? v.join(',') : String(v)])
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([k, v]) => `${k}=${v}`)
      .join('&');
    const h = crypto.createHmac('sha256', secret).update(canonical).digest('hex');
    return h.toLowerCase() === String(provided).toLowerCase();
  }

  // App Proxy presence endpoint
  fastify.get('/app-proxy/presence', async (req: any, reply: any) => {
    try {
      if (!verifyAppProxySignature(req)) {
        return reply.code(401).send({ ok: false, error: 'invalid_signature' });
      }

      const q = (req.query as any) as Record<string, string>;
      const shop = q.shop as string;
      if (!shop) return reply.code(400).send({ ok: false, error: 'shop_required' });

      const now = Math.floor(Date.now() / 1000);
      const key = `presence:${shop}`;

      let current = 0;
      if (redis) {
        if (useRest) {
          await (redis as UpstashRedis).zremrangebyscore(key, 0, now - ACTIVE_WINDOW_SEC);
        } else {
          await (redis as any).zremrangebyscore(key, 0, now - ACTIVE_WINDOW_SEC);
        }
        current = useRest
          ? Number(await (redis as UpstashRedis).zcount(key, now - ACTIVE_WINDOW_SEC, '+inf'))
          : await (redis as any).zcount(key, now - ACTIVE_WINDOW_SEC, '+inf');
      }

      const payload = { current, display: current, ts: Date.now() };
      const etag = 'W/"' + crypto.createHash('sha1').update(JSON.stringify(payload)).digest('hex') + '"';
      const inm = (req.headers['if-none-match'] as string) || '';
      if (inm && inm === etag) {
        return reply.code(304).send();
      }

      reply.header('Cache-Control', 'no-store');
      reply.header('ETag', etag);
      return reply.send(payload);
    } catch (err) {
      (req as any).log?.error?.({ err }, 'app-proxy/presence failed');
      return reply.code(500).send({ ok: false, error: 'internal_error' });
    }
  });

  // App Proxy collect endpoint
  fastify.post('/app-proxy/collect', async (req: any, reply: any) => {
    try {
      if (!verifyAppProxySignature(req)) {
        return reply.code(401).send({ ok: false, error: 'invalid_signature' });
      }

      const body = z.object({
        event: z.string(),
        ts: z.number().optional(),
        session_id: z.string(),
        shop_domain: z.string(),
        page: z.object({ path: z.string().optional(), title: z.string().optional(), ref: z.string().optional() }).optional(),
        duration_ms: z.number().optional(),
        payload: z.any().optional(),
        event_id: z.string().optional(),
      }).parse(req.body);

      if (!hasDb) {
        return reply.send({ ok: true, note: 'no_db_dev' });
      }

      // shops upsert
      const shopRes = await pool.query(
        'insert into shops(domain) values ($1) on conflict(domain) do update set domain=excluded.domain returning id',
        [body.shop_domain]
      );
      const shopId: string = shopRes.rows[0].id;

      // sessions upsert
      const ipHeader = (req.headers['x-forwarded-for'] as string) || '';
      const ip = (ipHeader.split(',')[0] || req.ip || null) as any;
      const ua = (req.headers['user-agent'] as string) || null;
      const ref = body.page?.ref || null;
      await pool.query(
        'insert into sessions(id, shop_id, first_seen, last_seen, ip, ua, referrer) values ($1,$2,now(),now(),$3,$4,$5) on conflict(id) do update set last_seen=now(), ip=coalesce(excluded.ip, sessions.ip), ua=coalesce(excluded.ua, sessions.ua), referrer=coalesce(excluded.referrer, sessions.referrer)',
        [body.session_id, shopId, ip, ua, ref]
      );

      // events insert
      const tsMs = body.ts ?? Date.now();
      await pool.query(
        'insert into events(shop_id, session_id, name, ts, page_path, payload, event_id) values ($1,$2,$3, to_timestamp($4/1000.0), $5, $6, $7) on conflict(event_id) do nothing',
        [shopId, body.session_id, body.event, tsMs, body.page?.path || null, body.payload ?? null, body.event_id || null]
      );

      return reply.send({ ok: true });
    } catch (err) {
      (req as any).log?.error?.({ err }, 'app-proxy/collect failed');
      return reply.code(400).send({ ok: false, error: 'bad_request' });
    }
  });

  await fastify.listen({ port: Number(process.env.PORT || 8082), host: '0.0.0.0' });
  console.log('API listening on', process.env.PORT || 8082);
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
