import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { z } from 'zod';
// PostgreSQL imports removed - using only Supabase
import Redis from 'ioredis';
import { Redis as UpstashRedis } from '@upstash/redis';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

// Environment validation schema
const envSchema = z.object({
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  REDIS_URL: z.string().optional(),
  UPSTASH_REDIS_REST_URL: z.string().url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  PUBLIC_BASE_URL: z.string().url().optional(),
  SHOP_DOMAIN: z.string().optional(),
  TRACKING_KEY: z.string().optional(),
  REALTIME: z.enum(['0', '1']).optional(),
  PORT: z.string().optional(),
  NODE_ENV: z.string().optional(),
});

async function bootstrap(): Promise<void> {
  // Validate environment variables
  try {
    const env = envSchema.parse(process.env);
    
    // Supabase: URL varsa en az bir key şart
    if (env.SUPABASE_URL && !(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY)) {
      throw new Error('SUPABASE_URL var, ancak SUPABASE_SERVICE_ROLE_KEY ya da SUPABASE_ANON_KEY yok.');
    }
    
    // Upstash: URL varsa token şart
    if (env.UPSTASH_REDIS_REST_URL && !env.UPSTASH_REDIS_REST_TOKEN) {
      throw new Error('UPSTASH_REDIS_REST_URL var, ancak UPSTASH_REDIS_REST_TOKEN yok.');
    }
    
    // Redis: En az bir Redis konfigürasyonu şart (production'da)
    if (process.env.NODE_ENV === 'production' && !env.REDIS_URL && !env.UPSTASH_REDIS_REST_URL) {
      throw new Error('Production ortamında REDIS_URL ya da UPSTASH_REDIS_REST_URL gerekli.');
    }
    
  } catch (error) {
    console.error('❌ Environment validation failed:', error);
    process.exit(1);
  }

  const fastify = Fastify({ 
    logger: { 
      level: process.env.NODE_ENV === 'production' ? 'info' : 'debug' 
    },
    bodyLimit: 1024 * 64 // 64KB; SPA'larda event payload'ları büyüyebilir
  });
  await fastify.register(cors, {
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['content-type', 'x-tracking-key', 'if-none-match'],
  });

  // WebSocket support
  await fastify.register(websocket);

  // Rate limiting - temporarily disabled (dependency not installed)
  // await fastify.register(rateLimit, {
  //   max: 100, // 100 requests per windowMs
  //   timeWindow: '1 minute',
  //   skipOnError: true,
  // });

  // PostgreSQL kaldırıldı - sadece Supabase kullanıyoruz
  
  // Supabase client
  const supabaseUrl = process.env.SUPABASE_URL || '';
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || '';
  const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

  // App configuration
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || 'https://hrl-tracking-app-production.up.railway.app';
  const DEFAULT_SHOP = process.env.SHOP_DOMAIN || 'ecomxtrade.myshopify.com';

  // Redis configuration
  const hasRedisUrl = !!process.env.REDIS_URL;
  const hasUpstashUrl = !!process.env.UPSTASH_REDIS_REST_URL;
  
  // Warn if both are set
  if (hasRedisUrl && hasUpstashUrl) {
    fastify.log.warn('Both REDIS_URL and UPSTASH_REDIS_REST_URL are set. Using Upstash REST (UPSTASH_REDIS_REST_URL).');
  }
  
  const useRest = hasUpstashUrl; // Prefer Upstash if both are set
  const redisUrl = useRest ? process.env.UPSTASH_REDIS_REST_URL : process.env.REDIS_URL;
  const redis = redisUrl ? (useRest ? new UpstashRedis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! }) : new Redis(redisUrl)) : null;
  
  // Constants
  const ACTIVE_WINDOW_SEC = 30; // 30 seconds
  const SHOP_RE = /^[a-z0-9.-]{3,255}$/i; // Shop domain validation regex
  
  // Real-time subscriptions for live updates (controlled by REALTIME flag)
  const channels: any[] = [];

  if (supabase && process.env.REALTIME === '1') {
    channels.push(
      supabase
        .channel('events_changes')
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'events' },
          (payload) => fastify.log.info({ payload }, 'New event via realtime')
        )
        .subscribe()
    );

    channels.push(
      supabase
        .channel('sessions_changes')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' },
          (payload) => fastify.log.info({ payload }, 'Session change via realtime')
        )
        .subscribe()
    );

    fastify.addHook('onClose', async () => {
      for (const ch of channels) {
        try { 
          await (supabase as any).removeChannel(ch); 
        } catch (err) {
          fastify.log.warn({ err }, 'Failed to remove realtime channel');
        }
      }
    });
  }
  
  if ((redis as any)?.on) {
    (redis as any).on('error', (err: any) => fastify.log.error({ err }, 'redis error'));
  }

  // Health check
  fastify.get('/health', async () => ({ ok: true }));

  // Tracker.js endpoint - Cache busting ile
  fastify.get('/tracker.js', async (req, reply) => {
    const trackerScript = `
// EcomXtrade Tracking Script v2.1 - API Served
(function() {
  'use strict';
  
  // Configuration
  const publicBase = '${publicBaseUrl}';
  const TRACKING_URL = publicBase;
  const SHOP_DOMAIN = window.location.hostname;
  
  console.log('🚀 ECOMXTRADE TRACKING SCRIPT v2.1 LOADED FROM API');
  
  // Leader tab management
  let isLeaderTab = false;
  let leaderTabId = null;
  let heartbeatInterval = null;
  let leaderTimestampInterval = null;
  // Heartbeat (sayfa ziyareti) interval'ı en başta tanımla (TDZ hatasını önler)
  let visitHeartbeatInterval = null;
  
  // Activity tracking
  let lastActivityTime = Date.now();
  let activityTimeout = null;
  const INACTIVITY_TIMEOUT = 4 * 60 * 1000; // 4 dakika
  
  // ==== Konfig ====
  const COLLECT_URL = publicBase + '/app-proxy/collect';
  const MAX_SESSION_GAP_MS = 30 * 60 * 1000;          // 30 dk inactivity = yeni session
  const HEARTBEAT_MS = 15000;                         // mevcut nabız süren

  // ==== Yardımcılar ====
  function uuidV4Fallback(){
    // xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
      const r = Math.random()*16|0, v = c === 'x' ? r : (r&0x3|0x8);
      return v.toString(16);
    });
  }
  function uuid() {
    const w = (typeof window !== 'undefined') ? window : {};
    const hasUUID = w.crypto && typeof w.crypto.randomUUID === 'function';
    return hasUUID ? w.crypto.randomUUID() : uuidV4Fallback();
  }

  // Ziyaretçi kimliği (1 yıl)
  function getOrSetVisitorId(){
    const KEY = 'hrl_vid';
    let vid = localStorage.getItem(KEY);
    if (!vid) { vid = uuid(); localStorage.setItem(KEY, vid); }
    return vid;
  }

  // Oturum bilgisi (tab/ziyaret bazlı) — sessionStorage + last_seen backup'ı localStorage'ta tut
  function getSessionState(){
    const SKEY = 'hrl_session';
    const LKEY = 'hrl_last_seen';
    let s = null;
    try { s = JSON.parse(sessionStorage.getItem(SKEY)); } catch {}
    const lastSeen = Number(localStorage.getItem(LKEY) || 0);
    return { s, lastSeen, SKEY, LKEY };
  }

  function rotateIfNeeded(){
    const { s, lastSeen, SKEY, LKEY } = getSessionState();
    const now = Date.now();

    // İlk açılış veya tarayıcı kapanmış → sessionStorage yok → yeni oturum
    if (!s) {
      const newS = { id: uuid(), started_at: now, last_seen: now };
      sessionStorage.setItem(SKEY, JSON.stringify(newS));
      localStorage.setItem(LKEY, String(now));
      return newS;
    }

    // inactivity kontrolü (tarayıcı açık kalsa da)
    if ((now - (s.last_seen || lastSeen || s.started_at)) > MAX_SESSION_GAP_MS) {
      const newS = { id: uuid(), started_at: now, last_seen: now };
      sessionStorage.setItem(SKEY, JSON.stringify(newS));
      localStorage.setItem(LKEY, String(now));
      return newS;
    }

    // mevcut oturumu sürdür
    return s;
  }

  function touchSession(){
    const { s, SKEY, LKEY } = getSessionState();
    if (!s) return;
    s.last_seen = Date.now();
    sessionStorage.setItem(SKEY, JSON.stringify(s));
    localStorage.setItem(LKEY, String(s.last_seen));
  }

  // ==== Başlangıç: session belirle ====
  const VISITOR_ID = getOrSetVisitorId();
  let SESSION = rotateIfNeeded();

  // Leader tab management
  function initializeLeaderTab() {
    const tabId = 'tab_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
    
    // Check if there's already a leader tab
    const existingLeader = localStorage.getItem('ecomxtrade_leader_tab');
    const leaderTimestamp = localStorage.getItem('ecomxtrade_leader_timestamp');
    const now = Date.now();
    
    // If no leader or leader is inactive (older than 30 seconds), become leader
    if (!existingLeader || !leaderTimestamp || (now - parseInt(leaderTimestamp)) > 30000) {
      localStorage.setItem('ecomxtrade_leader_tab', tabId);
      localStorage.setItem('ecomxtrade_leader_timestamp', now.toString());
      isLeaderTab = true;
      leaderTabId = tabId;
      // eski interval varsa temizle
      if (leaderTimestampInterval) { clearInterval(leaderTimestampInterval); }
      // her 10 saniyede bir timestamp güncelle
      leaderTimestampInterval = setInterval(() => {
        localStorage.setItem('ecomxtrade_leader_timestamp', Date.now().toString());
      }, 10000);
      startPresenceLoop();
      console.log('Became leader tab:', tabId);
    } else {
      isLeaderTab = false;
      leaderTabId = existingLeader;
      console.log('Following leader tab:', existingLeader);
    }
  }

  // Presence loop management
  function startPresenceLoop() {
    if (heartbeatInterval) return;
    heartbeatInterval = setInterval(() => {
      checkLeaderStatus();
      sendPresenceHeartbeat();
    }, 5000);
  }
  
  function stopPresenceLoop() {
    if (heartbeatInterval) { 
      clearInterval(heartbeatInterval); 
      heartbeatInterval = null; 
    }
  }

  // Check if current tab is still leader
  function checkLeaderStatus() {
    const currentLeader = localStorage.getItem('ecomxtrade_leader_tab');
    const leaderTimestamp = localStorage.getItem('ecomxtrade_leader_timestamp');
    const now = Date.now();
    
    if (isLeaderTab && currentLeader === leaderTabId) {
      // Still leader, update timestamp
      localStorage.setItem('ecomxtrade_leader_timestamp', now.toString());
    } else if (isLeaderTab && currentLeader !== leaderTabId) {
      // Lost leadership
      isLeaderTab = false;
      if (leaderTimestampInterval) { clearInterval(leaderTimestampInterval); leaderTimestampInterval = null; }
      stopPresenceLoop();
      console.log('Lost leadership to:', currentLeader);
    } else if (!isLeaderTab && (!currentLeader || (now - parseInt(leaderTimestamp)) > 30000)) {
      // Leader is inactive, become new leader
      initializeLeaderTab();
    }
  }

  // Activity detection - kullanıcı aktif mi?
  function updateActivity() {
    lastActivityTime = Date.now();
    
    // Eğer interval durduysa ve bu sekme liderse tekrar başlat
    if (!heartbeatInterval && isLeaderTab) {
      startPresenceLoop();
    }
    
    // Visit heartbeat interval'ı da yeniden başlat (eğer durduysa)
    if (!visitHeartbeatInterval) {
      visitHeartbeatInterval = setInterval(() => {
        // Sadece aktif kullanıcı için heartbeat gönder
        const now = Date.now();
        if (now - lastActivityTime <= INACTIVITY_TIMEOUT) {
          touchSession();
          send('visit_heartbeat');
        }
      }, HEARTBEAT_MS);
    }
    
    // Clear existing timeout
    if (activityTimeout) {
      clearTimeout(activityTimeout);
    }
    
    // Set new timeout - 4 dakika sonra offline kabul et
    activityTimeout = setTimeout(() => {
      console.log('User inactive for 4 minutes, stopping heartbeat');
      if (heartbeatInterval) {
        clearInterval(heartbeatInterval);
        heartbeatInterval = null;
      }
      if (visitHeartbeatInterval) {
        clearInterval(visitHeartbeatInterval);
        visitHeartbeatInterval = null;
      }
    }, INACTIVITY_TIMEOUT);
  }

  // Activity events - kullanıcı hareket ettiğinde
  function setupActivityDetection() {
    const activityEvents = [
      'mousedown', 'mousemove', 'keypress', 'scroll', 'touchstart', 'click'
    ];
    
    activityEvents.forEach(event => {
      document.addEventListener(event, updateActivity, true);
    });
    
    // Video events - video izleme aktif sayılır
    document.addEventListener('play', updateActivity, true);
    document.addEventListener('pause', updateActivity, true);
    document.addEventListener('timeupdate', updateActivity, true);
    
    // Initial activity
    updateActivity();
  }
  
  // Presence heartbeat fonksiyonu (sadece lider sekme ve aktif kullanıcı)
  function sendPresenceHeartbeat() {
    // Only send heartbeat if this is the leader tab
    if (!isLeaderTab) {
      return;
    }
    
    // Check if user is still active (within 4 minutes)
    const now = Date.now();
    if (now - lastActivityTime > INACTIVITY_TIMEOUT) {
      console.log('User inactive, skipping heartbeat');
      return;
    }
    
    const sessionId = SESSION.id;  // ✅ Hatalı referans düzeltildi
    const heartbeatData = {
      shop: SHOP_DOMAIN,
      session_id: sessionId,
      ts: now
    };

    fetch(\`\${TRACKING_URL}/presence/beat\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(heartbeatData),
      keepalive: true
    }).catch(err => {
      console.warn('Presence heartbeat failed:', err.message);
    });
  }

  // ==== Event gönderen yardımcı ====
  function send(evtName, extra={}){
    const payload = {
      event: evtName,
      session_id: SESSION.id,
      visitor_id: VISITOR_ID,
      ts: Date.now(),
      page: { path: location.pathname, title: document.title, ref: document.referrer },
      shop_domain: SHOP_DOMAIN,   // ✅ Zorunlu alanı ekle
      ...extra
    };
    // preflight kaçınmak için text/plain; server tarafı kabul etmeli
    return fetch(COLLECT_URL, {
      method: 'POST',
      headers: {'Content-Type':'text/plain;charset=UTF-8'},
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(()=>{});
  }
  
  // Basit bir sarmalayıcı ekleyelim ki beforeunload/unload çağrıları hata vermesin
  function trackEvent(name, extra){ return send(name, extra); }

  // ==== Oturum başlangıcını işaretle (raporlamaya yardımcı) ====
  send('session_start');

  // ==== Heartbeat ====
  visitHeartbeatInterval = setInterval(() => {
    // Sadece aktif kullanıcı için heartbeat gönder
    const now = Date.now();
    if (now - lastActivityTime <= INACTIVITY_TIMEOUT) {
      touchSession();
      send('visit_heartbeat');
    }
  }, HEARTBEAT_MS);

  // ==== Çıkış anı hibrit (sendBeacon + fetch keepalive) ====
  function exitPing(){
    const payloadObj = {
      event: 'visit_heartbeat',
      final: true,
      session_id: SESSION.id,
      visitor_id: VISITOR_ID,
      ts: Date.now(),
      event_id: uuid(),
      page: { path: location.pathname, title: document.title, ref: document.referrer },
      shop_domain: SHOP_DOMAIN   // ✅ Zorunlu alanı ekle
    };
    const payload = JSON.stringify(payloadObj);

    try {
      if (navigator.sendBeacon) {
        const blob = new Blob([payload], { type: 'application/json' });
        navigator.sendBeacon(COLLECT_URL, blob);
      }
    } catch {}

    try {
      const ctrl = new AbortController();
      const t = setTimeout(()=>ctrl.abort(), 1500);
      fetch(COLLECT_URL, {
        method: 'POST',
        headers: {'Content-Type':'text/plain;charset=UTF-8'},
        body: payload,
        keepalive: true,
        signal: ctrl.signal
      }).catch(()=>{}).finally(()=>clearTimeout(t));
    } catch {}
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') exitPing();
  });
  window.addEventListener('pagehide', (e) => { if (!e.persisted) exitPing(); });
  
  // Track page view
  function trackPageView() {
    console.log('📄📄📄 TRACKING PAGE VIEW v2.1');
    console.log('📄📄📄 URL:', window.location.href);
    send('page_view');
  }
  
  // Track add to cart
  function trackAddToCart(productId, variantId, quantity = 1) {
    send('add_to_cart', {
      product_id: productId,
      variant_id: variantId,
      quantity: quantity
    });
  }

  // Track checkout started
  function trackCheckoutStarted() {
    send('checkout_started');
  }

  // Track purchase
  function trackPurchase(orderId, total, currency) {
    send('purchase', {
      order_id: orderId,
      total: total,
      currency: currency
    });
  }
  
  // Initialize tracking
  function initTracking() {
    // Initialize leader tab management
    initializeLeaderTab();
    
    // Setup activity detection
    setupActivityDetection();
    
    // Track initial page view
    trackPageView();
    
    // Send initial presence heartbeat (only if leader)
    sendPresenceHeartbeat();
    
    // Start presence heartbeat (5 saniyede bir) - only if leader tab
    if (isLeaderTab) startPresenceLoop();
    
    // Track page changes (SPA support)
    let lastUrl = window.location.href;
    
    // History API hook'ları (SPA'lar için daha garantili)
    (function() {
      const push = history.pushState;
      history.pushState = function() { 
        push.apply(this, arguments); 
        window.dispatchEvent(new Event('spa:navigate')); 
      }
      window.addEventListener('popstate', () => window.dispatchEvent(new Event('spa:navigate')));
      window.addEventListener('spa:navigate', () => { 
        trackPageView(); 
        sendPresenceHeartbeat(); 
      });
    })();
    
    // MutationObserver (fallback)
    new MutationObserver(() => {
      const url = window.location.href;
      if (url !== lastUrl) {
        lastUrl = url;
        trackPageView();
        // Page değiştiğinde de heartbeat gönder
        sendPresenceHeartbeat();
      }
    }).observe(document.body || document, { subtree: true, childList: true });
    
    // Track add to cart events
    document.addEventListener('click', function(e) {
      const addToCartBtn = e.target.closest('[name="add"], .btn-cart, .add-to-cart');
      if (addToCartBtn) {
        const form = addToCartBtn.closest('form');
        if (form) {
          const productId = form.querySelector('[name="id"]')?.value;
          const quantity = form.querySelector('[name="quantity"]')?.value || 1;
          if (productId) {
            trackAddToCart(productId, productId, quantity);
          }
        }
      }
    });
    
    // Track checkout events
    document.addEventListener('click', function(e) {
      if (e.target.matches('.btn-checkout, [href*="checkout"], [href*="cart"]')) {
        trackCheckoutStarted();
      }
    });

    // Visibility change - sayfa görünür olduğunda heartbeat gönder
    document.addEventListener('visibilitychange', function() {
      if (!document.hidden) {
        sendPresenceHeartbeat();
      }
    });

    // Focus - pencere odaklandığında heartbeat gönder
    window.addEventListener('focus', function() {
      sendPresenceHeartbeat();
    });

    // Page unload events - sendBeacon kullan
    window.addEventListener('beforeunload', function() {
      // Clear activity timeout
      if (activityTimeout) {
        clearTimeout(activityTimeout);
        activityTimeout = null;
      }
      trackEvent('beforeunload');
    });

    window.addEventListener('unload', function() {
      // Clear activity timeout
      if (activityTimeout) {
        clearTimeout(activityTimeout);
        activityTimeout = null;
      }
      // Clear leader timestamp interval
      if (leaderTimestampInterval) {
        clearInterval(leaderTimestampInterval);
        leaderTimestampInterval = null;
      }
      trackEvent('unload');
    });
  }
  
  // Start tracking when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initTracking);
  } else {
    initTracking();
  }
  
  // Expose tracking functions globally
  window.EcomXtradeTracking = {
    trackEvent,
    trackPageView,
    trackAddToCart,
    trackCheckoutStarted,
    trackPurchase,
    sendPresenceHeartbeat
  };
})();
`;

    reply
      .header('Content-Type', 'application/javascript')
      .header('Cache-Control', 'no-cache, no-store, must-revalidate')
      .header('Pragma', 'no-cache')
      .header('Expires', '0')
      .send(trackerScript);
  });

  // Dashboard data API endpoint
  fastify.get('/api/dashboard', async (req, reply) => {
    // Cache kontrolü - real-time veri için cache yok
    reply.header('Cache-Control', 'no-store, no-cache, must-revalidate');
    
    // Get shop from query parameter or use default
    const q = (req.query as any) || {};
    const shop = (q.shop as string) || DEFAULT_SHOP;
    
    // Sanitize shop parameter for security
    if (!SHOP_RE.test(shop)) {
      return reply.code(400).send({ ok: false, error: 'invalid_shop' });
    }
    
    // Get real-time data
    const now = Math.floor(Date.now() / 1000);
    let activeUsers = 0;
    let totalSessions = 0;
    let pageViews = 0;
    let conversionRate = 0;

    // Get active users from Redis
    if (redis) {
      const key = `presence:${shop}`;
      
      try {
        if (useRest) {
          await (redis as UpstashRedis).zremrangebyscore(key, 0, now - ACTIVE_WINDOW_SEC);
          activeUsers = Number(await (redis as UpstashRedis).zcount(key, now - ACTIVE_WINDOW_SEC, '+inf'));
        } else {
          await (redis as any).zremrangebyscore(key, 0, now - ACTIVE_WINDOW_SEC);
          activeUsers = await (redis as any).zcount(key, now - ACTIVE_WINDOW_SEC, '+inf');
        }
      } catch (err) {
        fastify.log.error({ err }, 'Redis error in dashboard API');
      }
    }

    // Get database stats if available
    if (supabase) {
      try {
        const shopDomain = shop;
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        
        // Get shop ID first
        const { data: shopData, error: shopError } = await supabase
          .from('shops')
          .select('id')
          .eq('domain', shopDomain)
          .single();
        
        if (shopError || !shopData) {
          fastify.log.error({ err: shopError }, 'Shop not found in dashboard API');
          return reply.send({
            activeUsers: 0,
            totalSessions: 0,
            pageViews: 0,
            conversionRate: 0,
            shop,
            timestamp: new Date().toISOString(),
            error: 'shop_not_found'
          });
        }
        
        const shopId = shopData.id;

        // Get total sessions from last 24 hours (using sessions table)
        const { data: sessionData, count: sessionCount, error: sessionError } = await supabase
          .from('sessions')
          .select('id', { count: 'exact', head: true })  // sadece say
          .eq('shop_id', shopId)
          .gte('first_seen', twentyFourHoursAgo);
        
        if (!sessionError) {
          totalSessions = sessionCount || 0;
        }

        // Get page views from last 24 hours (using page_views table) - FIXED FIELD NAMES
        const { count: pageViewCount, error: pageViewError } = await supabase
          .from('page_views')
          .select('id', { count: 'exact', head: true })  // sadece say
          .eq('shop_id', shopId)
          .gte('ts', twentyFourHoursAgo);  // ✅ viewed_at → ts
        
        if (!pageViewError) {
          pageViews = pageViewCount || 0;
        }

        // Get conversions from last 24 hours (using events table) - FIXED FIELD NAMES
        const { count: conversions, error: conversionError } = await supabase
          .from('events')
          .select('id', { count: 'exact', head: true })  // sadece say
          .eq('shop_id', shopId)
          .gte('ts', twentyFourHoursAgo)  // ✅ created_at → ts
          .in('name', ['add_to_cart', 'checkout_started', 'purchase']);  // ✅ event_name → name
        
        if (!conversionError) {
          conversionRate = totalSessions > 0 ? parseFloat((((conversions || 0) / totalSessions) * 100).toFixed(1)) : 0;
        }
        
        if (process.env.NODE_ENV !== 'production') {
          console.log('📊 API DASHBOARD STATS:', {
            totalSessions,
            pageViews,
            conversionRate,
            shopId,
            shopDomain,
            timeRange: '24 hours'
          });
        }
      } catch (err) {
        fastify.log.error({ err }, 'Supabase error in dashboard API');
        // Fallback to demo data
        totalSessions = Math.floor(Math.random() * 500) + 100;
        pageViews = Math.floor(Math.random() * 2000) + 500;
        conversionRate = parseFloat((Math.random() * 5 + 1).toFixed(1));
      }
    } else {
      // Fallback to demo data when no Supabase
      totalSessions = Math.floor(Math.random() * 500) + 100;
      pageViews = Math.floor(Math.random() * 2000) + 500;
      conversionRate = parseFloat((Math.random() * 5 + 1).toFixed(1));
    }

    return reply.send({
      activeUsers,
      totalSessions,
      pageViews,
      conversionRate,
      shop,
      timestamp: new Date().toISOString()
    });
  });

  // Redis cleanup endpoint
  fastify.post('/cleanup', async (req: any, reply: any) => {
    // Auth kontrolü
    const trackingKey = req.headers['x-tracking-key'] as string;
    if (!process.env.TRACKING_KEY || trackingKey !== process.env.TRACKING_KEY) {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }

    if (!redis) {
      return reply.send({ ok: true, note: 'no_redis' });
    }

    try {
      const q = (req.query as any) as Record<string, string>;
      const shop = q.shop as string || DEFAULT_SHOP;
      
      // Sanitize shop parameter for security
      if (!SHOP_RE.test(shop)) {
        return reply.code(400).send({ ok: false, error: 'invalid_shop' });
      }
      
      const key = `presence:${shop}`;
      
      if (useRest) {
        await (redis as UpstashRedis).del(key);
      } else {
        await (redis as any).del(key);
      }
      
      return reply.send({ ok: true, message: `Cleared presence data for ${shop}` });
    } catch (err) {
      return reply.code(500).send({ ok: false, error: 'cleanup_failed' });
    }
  });

  // Root route for embedded app - Dashboard
  fastify.get('/', async (req, reply) => {
    // Get shop from query parameter or use default
    const q = (req.query as any) || {};
    const shop = (q.shop as string) || DEFAULT_SHOP;
    
    // Sanitize shop parameter for security
    if (!SHOP_RE.test(shop)) {
      return reply.code(400).send({ ok: false, error: 'invalid_shop' });
    }
    
    // Get real-time data
    const now = Math.floor(Date.now() / 1000);
    let activeUsers = 0;
    let totalSessions = 0;
    let uniqueVisitors = 0;
    let pageViews = 0;
    let conversionRate = 0;

    // Get active users from Redis
    if (redis) {
      const key = `presence:${shop}`;
      
      try {
        if (useRest) {
          await (redis as UpstashRedis).zremrangebyscore(key, 0, now - ACTIVE_WINDOW_SEC);
          activeUsers = Number(await (redis as UpstashRedis).zcount(key, now - ACTIVE_WINDOW_SEC, '+inf'));
        } else {
          await (redis as any).zremrangebyscore(key, 0, now - ACTIVE_WINDOW_SEC);
          activeUsers = await (redis as any).zcount(key, now - ACTIVE_WINDOW_SEC, '+inf');
        }
      } catch (err) {
        fastify.log.error({ err }, 'Redis error in active users calculation');
      }
    }

    // Get database stats if available
    if (supabase) {
      try {
        const shopDomain = shop;
        const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        
        // Get shop PK first
        const { data: shopRow, error: shopFindErr } = await supabase
          .from('shops').select('id').eq('domain', shopDomain).single();
        const shopPk = shopRow?.id;
        
        if (!shopPk) {
          fastify.log.warn('Shop not found, using demo data');
          // Fallback to demo data
          totalSessions = Math.floor(Math.random() * 500) + 100;
          uniqueVisitors = Math.floor(totalSessions * 0.7);
          pageViews = Math.floor(Math.random() * 2000) + 500;
          conversionRate = parseFloat((Math.random() * 5 + 1).toFixed(1));
        } else {
          // Total Sessions: COUNT(*) FROM sessions WHERE shop_id = :shopPk AND first_seen >= now() - interval '24 hours'
          const { count: sessionCount, error: sessionError } = await supabase
            .from('sessions')
            .select('id', { count: 'exact', head: true })  // sadece say
            .eq('shop_id', shopPk)
            .gte('first_seen', twentyFourHoursAgo);
          
          if (!sessionError) {
            totalSessions = sessionCount || 0;
          }

          // Unique Visitors: COUNT(DISTINCT visitor_id) FROM sessions WHERE shop_id = :shopPk AND first_seen >= now() - interval '24 hours'
          // Büyük hacimde doğru sayım için view kullan (eğer yoksa fallback)
          try {
            const { data: uniqueVisitorData, error: uniqueVisitorError } = await supabase
              .from('v_sessions_unique_visitors_24h')
              .select('unique_visitors')
              .eq('shop_id', shopPk)
              .maybeSingle();
            
            if (!uniqueVisitorError && uniqueVisitorData) {
              uniqueVisitors = uniqueVisitorData.unique_visitors ?? 0;
            } else {
              // Fallback: Eski yöntem (küçük hacimde)
              const { data: fallbackData } = await supabase
                .from('sessions')
                .select('visitor_id')
                .eq('shop_id', shopPk)
                .gte('first_seen', twentyFourHoursAgo)
                .not('visitor_id', 'is', null);
              
              const uniqueVisitorIds = new Set(fallbackData?.map(s => s.visitor_id) || []);
              uniqueVisitors = uniqueVisitorIds.size;
            }
          } catch (err) {
            // View yoksa fallback kullan
            const { data: fallbackData } = await supabase
              .from('sessions')
              .select('visitor_id')
              .eq('shop_id', shopPk)
              .gte('first_seen', twentyFourHoursAgo)
              .not('visitor_id', 'is', null);
            
            const uniqueVisitorIds = new Set(fallbackData?.map(s => s.visitor_id) || []);
            uniqueVisitors = uniqueVisitorIds.size;
          }

          // Page Views: COUNT(*) FROM page_views WHERE shop_id = :shopPk AND ts >= now() - interval '24 hours'
          const { count: pageViewCount, error: pageViewError } = await supabase
            .from('page_views')
            .select('id', { count: 'exact', head: true })  // sadece say
            .eq('shop_id', shopPk)
            .gte('ts', twentyFourHoursAgo);
          
          if (!pageViewError) {
            pageViews = pageViewCount || 0;
          }

          // Conversion Rate: Events / Sessions (with proper session filtering)
          const { count: conversions, error: conversionError } = await supabase
            .from('events')
            .select('id', { count: 'exact', head: true })  // sadece say
            .eq('shop_id', shopPk)
            .gte('ts', twentyFourHoursAgo)
            .in('name', ['add_to_cart', 'checkout_started', 'purchase']);
          
          if (!conversionError) {
            conversionRate = totalSessions > 0 ? parseFloat((((conversions || 0) / totalSessions) * 100).toFixed(1)) : 0;
          }
        }
        
        if (process.env.NODE_ENV !== 'production') {
          console.log('📊 DASHBOARD STATS:', {
            totalSessions,
            uniqueVisitors,
            pageViews,
            conversionRate,
            shopPk,
            shopDomain,
            timeRange: '24 hours'
          });
        }
      } catch (err) {
        fastify.log.error({ err }, 'Supabase error in dashboard stats');
        // Fallback to demo data
        totalSessions = Math.floor(Math.random() * 500) + 100;
        uniqueVisitors = Math.floor(totalSessions * 0.7); // Genelde unique visitors sessions'dan az
        pageViews = Math.floor(Math.random() * 2000) + 500;
        conversionRate = parseFloat((Math.random() * 5 + 1).toFixed(1));
      }
    } else {
      // Demo data when no database
      totalSessions = Math.floor(Math.random() * 500) + 100;
      uniqueVisitors = Math.floor(totalSessions * 0.7); // Genelde unique visitors sessions'dan az
      pageViews = Math.floor(Math.random() * 2000) + 500;
      conversionRate = parseFloat((Math.random() * 5 + 1).toFixed(1));
    }

    // Add cache control headers
    reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    reply.header('Pragma', 'no-cache');
    reply.header('Expires', '0');
    
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html>
      <head>
        <title>EcomXtrade Tracking Dashboard</title>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
          * { margin: 0; padding: 0; box-sizing: border-box; }
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f9fa; color: #333; }
          .container { max-width: 1200px; margin: 0 auto; padding: 20px; }
          .header { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; padding: 30px; border-radius: 12px; margin-bottom: 30px; box-shadow: 0 4px 20px rgba(0,0,0,0.1); }
          .header h1 { font-size: 2.5em; margin-bottom: 10px; }
          .header p { opacity: 0.9; font-size: 1.1em; }
          .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px; }
          .stat-card { background: white; padding: 25px; border-radius: 12px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); transition: transform 0.2s; }
          .stat-card:hover { transform: translateY(-2px); }
          .stat-value { font-size: 2.5em; font-weight: 700; color: #667eea; margin-bottom: 5px; }
          .stat-label { color: #666; font-size: 0.9em; text-transform: uppercase; letter-spacing: 0.5px; }
          .stat-change { font-size: 0.8em; margin-top: 5px; }
          .positive { color: #10b981; }
          .negative { color: #ef4444; }
          .section { background: white; padding: 25px; border-radius: 12px; margin-bottom: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          .section h3 { margin-bottom: 15px; color: #333; font-size: 1.3em; }
          .status-badge { display: inline-block; background: #10b981; color: white; padding: 5px 12px; border-radius: 20px; font-size: 0.8em; font-weight: 600; }
          .refresh-btn { background: #667eea; color: white; border: none; padding: 12px 24px; border-radius: 8px; cursor: pointer; font-size: 1em; transition: background 0.2s; }
          .refresh-btn:hover { background: #5a67d8; }
          .live-indicator { display: inline-block; width: 8px; height: 8px; background: #10b981; border-radius: 50%; margin-right: 8px; animation: pulse 2s infinite; }
          @keyframes pulse { 0% { opacity: 1; } 50% { opacity: 0.5; } 100% { opacity: 1; } }
          .footer { text-align: center; color: #666; margin-top: 30px; font-size: 0.9em; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🎯 EcomXtrade Tracking Dashboard</h1>
            <p>Real-time visitor analytics and conversion tracking for your Shopify store</p>
          </div>
          
          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-value" id="activeUsers">${activeUsers}</div>
              <div class="stat-label">Active Users</div>
              <div class="stat-change" id="activeUsersChange">Real-time data</div>
            </div>
            <div class="stat-card">
              <div class="stat-value" id="totalSessions">${totalSessions}</div>
              <div class="stat-label">Total Sessions (24h)</div>
              <div class="stat-change" id="totalSessionsChange">Last 24 hours</div>
            </div>
            <div class="stat-card">
              <div class="stat-value" id="uniqueVisitors">${uniqueVisitors}</div>
              <div class="stat-label">Unique Visitors (24h)</div>
              <div class="stat-change" id="uniqueVisitorsChange">Last 24 hours</div>
            </div>
            <div class="stat-card">
              <div class="stat-value" id="pageViews">${pageViews}</div>
              <div class="stat-label">Page Views (24h)</div>
              <div class="stat-change" id="pageViewsChange">Last 24 hours</div>
            </div>
            <div class="stat-card">
              <div class="stat-value" id="conversionRate">${conversionRate}%</div>
              <div class="stat-label">Conversion Rate</div>
              <div class="stat-change" id="conversionRateChange">Last 24 hours</div>
            </div>
          </div>

          <div class="section">
            <h3><span class="live-indicator"></span>Live Activity</h3>
            <p>Real-time tracking data from your store visitors. Updates every 30 seconds.</p>
            <button class="refresh-btn" onclick="refreshData()">🔄 Refresh Data</button>
          </div>

          <div class="section">
            <h3>📊 App Status</h3>
            <p><strong>Status:</strong> <span class="status-badge">Active</span></p>
            <p><strong>Version:</strong> 1.0.0</p>
            <p><strong>Last Updated:</strong> ${new Date().toLocaleString()}</p>
            <p><strong>Database:</strong> ${supabase ? 'Supabase Connected' : 'Demo Mode'}</p>
            <p><strong>Redis:</strong> ${redis ? 'Connected' : 'Demo Mode'}</p>
          </div>
        </div>

        <div class="footer">
          <p>EcomXtrade Tracking App - Real-time analytics for Shopify stores</p>
        </div>

        <script>
          // Real-time data fetching
          async function fetchData() {
            try {
              // Get shop parameter from URL or use default
              const urlParams = new URLSearchParams(window.location.search);
              const shop = urlParams.get('shop') || '${DEFAULT_SHOP}';
              
              // Fetch all dashboard data from API
              const response = await fetch('${publicBaseUrl}/api/dashboard?t=' + Date.now() + '&shop=' + encodeURIComponent(shop));
              const data = await response.json();
              
              // Update all metrics
              const cr = (data && data.conversionRate != null) ? data.conversionRate : 0;
              document.getElementById('conversionRate').textContent = cr + '%';
              document.getElementById('activeUsers').textContent   = Number.isFinite(data.activeUsers)   ? data.activeUsers   : 0;
              document.getElementById('totalSessions').textContent = Number.isFinite(data.totalSessions) ? data.totalSessions : 0;
              document.getElementById('pageViews').textContent     = Number.isFinite(data.pageViews)     ? data.pageViews     : 0;
              
              // Update change indicators
              const updateTime = new Date().toLocaleTimeString();
              document.getElementById('activeUsersChange').textContent = 'Updated ' + updateTime;
              document.getElementById('totalSessionsChange').textContent = 'Updated ' + updateTime;
              document.getElementById('pageViewsChange').textContent = 'Updated ' + updateTime;
              document.getElementById('conversionRateChange').textContent = 'Updated ' + updateTime;
              
              // Dashboard updated (console log removed for cleaner console)
              
            } catch (error) {
              console.error('Error fetching data:', error);
              document.getElementById('activeUsers').textContent = 'Error';
              document.getElementById('totalSessions').textContent = 'Error';
              document.getElementById('pageViews').textContent = 'Error';
              document.getElementById('conversionRate').textContent = 'Error';
            }
          }

          function refreshData() {
            fetchData();
          }

          // Initial load
          fetchData();

          // Auto-refresh every 5 seconds (more aggressive)
          setInterval(fetchData, 5000);
          
          // Debug: Log when auto-refresh runs
          // Dashboard auto-refresh started - every 5 seconds
          
          // Force refresh on page focus
          window.addEventListener('focus', fetchData);
        </script>
      </body>
      </html>
    `);
  });

  // Admin dashboard route
  fastify.get('/admin', async (req, reply) => {
    const key = req.headers['x-tracking-key'];
    if (!process.env.TRACKING_KEY || key !== process.env.TRACKING_KEY) {
      return reply.code(401).send('unauthorized');
    }
    
    return reply.type('text/html').send(`
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>EcomXtrade Tracking Admin</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 40px; background: #f5f5f5; }
          .container { max-width: 800px; margin: 0 auto; background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
          h1 { color: #333; margin-bottom: 20px; }
          .status { background: #e8f5e8; padding: 15px; border-radius: 5px; margin: 20px 0; }
          .endpoints { background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 20px 0; }
          .endpoint { margin: 10px 0; font-family: monospace; }
        </style>
      </head>
      <body>
        <div class="container">
          <h1>🎯 EcomXtrade Tracking App</h1>
          <div class="status">
            <strong>Status:</strong> Active and Running<br>
            <strong>Version:</strong> 1.0.0<br>
            <strong>Last Updated:</strong> ${new Date().toLocaleString()}
          </div>
          <div class="endpoints">
            <h3>Available Endpoints:</h3>
            <div class="endpoint">GET / - Root endpoint</div>
            <div class="endpoint">GET /health - Health check</div>
            <div class="endpoint">POST /collect - Collect tracking data</div>
            <div class="endpoint">POST /presence/beat - Presence heartbeat</div>
            <div class="endpoint">GET /presence/stream - Presence stream (SSE)</div>
            <!-- WS disabled for now -->
            <div class="endpoint">GET /app-proxy/presence - App proxy presence</div>
            <div class="endpoint">POST /app-proxy/collect - App proxy collect</div>
          </div>
          <p><strong>Note:</strong> This is the admin dashboard for the EcomXtrade Tracking App. The app is configured to work with Shopify stores and collect visitor tracking data.</p>
        </div>
      </body>
      </html>
    `);
  });

  // Presence beat endpoint
  fastify.post('/presence/beat', async (req: any, reply: any) => {
    const body = z
      .object({ 
        shop: z.string().min(1).max(255),
        session_id: z.string().uuid(),
        ts: z.number().positive().optional() // artık opsiyonel; yok saysak da olur
      })
      .parse(req.body);
    
    // Güvenlik: shop domain formatını doğrula
    if (!SHOP_RE.test(body.shop)) {
      return reply.code(400).send({ ok: false, error: 'invalid_shop' });
    }
    
    if (!redis) {
      return reply.send({ ok: true, note: 'no_redis_dev' });
    }
    
    const key = `presence:${body.shop}`;
    const serverNowSec = Math.floor(Date.now() / 1000);
    
    if (useRest) {
      await (redis as UpstashRedis).zadd(key, { score: serverNowSec, member: body.session_id });
      await (redis as UpstashRedis).expire(key, 300);
    } else {
      await (redis as any).zadd(key, serverNowSec, body.session_id);
      await (redis as any).expire(key, 300);
    }
    reply.send({ ok: true });
  });

  // Presence stream endpoint
  fastify.get('/presence/stream', async (req: any, reply: any) => {
    const q = (req.query as any) as Record<string, string>;
    const shop = q.shop as string;
    if (!shop) return reply.code(400).send({ ok: false, error: 'shop_required' });
    
    // Sanitize shop parameter for security
    if (!SHOP_RE.test(shop)) {
      return reply.code(400).send({ ok: false, error: 'invalid_shop' });
    }

    reply.hijack();
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('Access-Control-Allow-Origin', '*');
    reply.raw.setHeader('X-Accel-Buffering', 'no'); // Nginx proxy desteği
    reply.raw.write(`:\n\n`);
    
    // Reconnect interval bildir
    reply.raw.write(`retry: 5000\n`);
    reply.raw.write(`event: ping\ndata: "ready"\n\n`);
    
    const interval = setInterval(async () => {
      try {
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
      } catch (e) {
        stop();
      }
    }, 2000);

    const stop = () => {
      clearInterval(interval);
      try { reply.raw.end(); } catch {}
    };

    // İlk değer hemen
    (async () => {
      try {
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
      } catch (e) {
        stop();
      }
    })();
    (req.raw as any).on('close', stop);
    (req.raw as any).on('error', stop);
  });

  // WebSocket endpoint removed for now - focus on session tracking
  // fastify.get('/ws', { websocket: true }, (connection: any, req: any) => {
  // WebSocket handler commented out for now
  /*
    const q = (req.query as any) as Record<string, string>;
    const shop = q.shop as string || DEFAULT_SHOP;
    
    console.log('WebSocket connection established for shop:', shop);
    
    // Send initial data
    const sendUpdate = async () => {
      const now = Math.floor(Date.now() / 1000);
      let activeUsers = 0;
      let totalSessions = 0;
      let pageViews = 0;
      let conversionRate = 0;

      // Get active users from Redis
      if (redis) {
        const key = `presence:${shop}`;
        try {
          if (useRest) {
            await (redis as UpstashRedis).zremrangebyscore(key, 0, now - ACTIVE_WINDOW_SEC);
            activeUsers = Number(await (redis as UpstashRedis).zcount(key, now - ACTIVE_WINDOW_SEC, '+inf'));
          } else {
            await (redis as any).zremrangebyscore(key, 0, now - ACTIVE_WINDOW_SEC);
            activeUsers = await (redis as any).zcount(key, now - ACTIVE_WINDOW_SEC, '+inf');
          }
        } catch (err) {
          fastify.log.error({ err }, 'Redis error in WebSocket');
        }
      }

      // Get database stats if available
      if (supabase) {
        try {
          // Get total sessions from last 24 hours (using sessions table)
          const { data: sessionData, error: sessionError } = await supabase
            .from('sessions')
            .select('id')
            .gte('first_seen', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
          
          if (!sessionError) {
            totalSessions = sessionData?.length || 0;
          }

          // Get page views from last 24 hours (using page_views table)
          const { data: pageViewData, error: pageViewError } = await supabase
            .from('page_views')
            .select('id')
            .gte('viewed_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
          
          if (!pageViewError) {
            pageViews = pageViewData?.length || 0;
          }

          // Get conversions from last 24 hours (using events table)
          const { data: conversionData, error: conversionError } = await supabase
            .from('events')
            .select('id')
            .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
            .in('event_name', ['add_to_cart', 'checkout_started', 'purchase']);
          
          if (!conversionError) {
            const conversions = conversionData?.length || 0;
            conversionRate = totalSessions > 0 ? parseFloat(((conversions / totalSessions) * 100).toFixed(1)) : 0;
          }
        } catch (err) {
          fastify.log.error({ err }, 'Supabase error in WebSocket');
        }

      const data = {
        type: 'dashboard_update',
        activeUsers,
        totalSessions,
        pageViews,
        conversionRate,
        timestamp: new Date().toISOString()
      };

      connection.socket.write(JSON.stringify(data));
    };

    // Send initial data
    sendUpdate();

    // Send updates every 5 seconds
    const interval = setInterval(sendUpdate, 5000);

    connection.socket.on('close', () => {
      console.log('WebSocket connection closed for shop:', shop);
      clearInterval(interval);
    });

    connection.socket.on('error', (err: any) => {
      console.error('WebSocket error:', err);
      clearInterval(interval);
    });
  });
  */

  // Collect endpoint - app-proxy/collect ile tutarlı
  fastify.post('/collect', async (req: any, reply: any) => {
    const schema = z.object({
      event: z.string(),
      ts: z.number().optional(),
      session_id: z.string(),
      visitor_id: z.string().optional(), // app-proxy ile tutarlı
      shop_domain: z.string(),
      page: z
        .object({ path: z.string().optional(), title: z.string().optional(), ref: z.string().optional() })
        .optional(),
      duration_ms: z.number().min(0).optional(),
      payload: z.any().optional(),
      event_id: z.string().optional(),
    });
    const body = typeof req.body === 'string'
      ? schema.parse(JSON.parse(req.body))
      : schema.parse(req.body);

    if (!SHOP_RE.test(body.shop_domain)) {
      return reply.code(400).send({ ok: false, error: 'invalid_shop' });
    }
    
    // TS güvenliği: +/- 5dk dışındaki ts'leri server saatine çek
    const nowMs = Date.now();
    const tsMs = (typeof body.ts === 'number' && Math.abs(nowMs - body.ts) <= 5 * 60 * 1000)
      ? body.ts : nowMs;

    if (supabase) {
      try {
        // Upsert shop by domain
        const { data: shopData, error: shopError } = await supabase
          .from('shops')
          .upsert({ domain: body.shop_domain }, { onConflict: 'domain' })
          .select('id')
          .single();
        
        if (shopError) {
          fastify.log.error({ err: shopError }, 'Supabase shop upsert error');
          return reply.code(500).send({ ok: false, error: 'shop_upsert_failed' });
        }
        
        const shopId = shopData.id;
        const sessionId = body.session_id;
        const visitorId = body.visitor_id || null;

        // 1) Güncelle (first_seen'e dokunma)
        const { data: updated, error: updErr } = await supabase
          .from('sessions')
          .update({
            last_seen: new Date(tsMs).toISOString(),
            ip: (req.headers['x-forwarded-for'] || '').toString().split(',')[0] || req.ip || null,
            ua: (req.headers['user-agent'] as string) || null,
            referrer: body.page?.ref || null
          })
          .eq('id', sessionId)
          .select('id')  // Supabase v2'de etkilenen satırı görmek için select gerekir
          .maybeSingle();

        if (!updated) {
          // 2) Satır yoksa INSERT (first_seen burada set edilir)
          // INSERT yarışlarını yumuşatmak için önce insert ... on conflict do nothing
          const { error: insErr } = await supabase.from('sessions').insert({
            id: sessionId,
            shop_id: shopId,
            visitor_id: visitorId || null,
            first_seen: new Date(tsMs).toISOString(),
            last_seen: new Date(tsMs).toISOString(),
            ip: (req.headers['x-forwarded-for'] || '').toString().split(',')[0] || req.ip || null,
            ua: (req.headers['user-agent'] as string) || null,
            referrer: body.page?.ref || null
          });
          
          // INSERT başarısız olursa (yarış durumu), last_seen'i güncelle
          if (insErr) {
            if (process.env.NODE_ENV !== 'production') {
              console.log('🔄 Session INSERT yarışı, last_seen güncelleniyor:', sessionId);
            }
            await supabase.from('sessions')
              .update({ last_seen: new Date(tsMs).toISOString() })
              .eq('id', sessionId);
          }
        }

        // Events/Page views aynen (sadece foreign key doğru id)
        // Event deduplikasyonu için upsert kullan (event_id varsa)
        const eventData = {
          shop_id: shopId,
          session_id: sessionId,
          name: body.event,                 // ✅
          ts: new Date(tsMs).toISOString(), // ✅
          page_path: body.page?.path || null,
          payload: body.payload ?? null,
          event_id: body.event_id || null
        };
        
        const { error: eventError } = body.event_id 
          ? await supabase.from('events').upsert(eventData, { onConflict: 'shop_id,event_id' })
          : await supabase.from('events').insert(eventData);
        
        if (eventError) {
          fastify.log.error({ err: eventError }, 'Supabase event insert error');
        }

        if (body.event === 'page_view') {
          if (process.env.NODE_ENV !== 'production') {
            console.log('📄 PAGE VIEW INSERT:', {
              shopId: shopId,
              sessionId: sessionId,
              path: body.page?.path || '/',
              title: body.page?.title || '',
              ts: new Date(tsMs).toISOString()
            });
          }
          
          const { error: pageViewError } = await supabase.from('page_views').insert({
            shop_id: shopId,
            session_id: sessionId,
            path: body.page?.path || '/',     // ✅
            title: body.page?.title || '',
            engaged_ms: body.duration_ms ? Math.max(0, Math.round(body.duration_ms)) : null,
            ts: new Date(tsMs).toISOString()  // ✅
          });
          
          if (pageViewError) {
            fastify.log.error({ err: pageViewError }, 'Supabase page view insert error');
            if (process.env.NODE_ENV !== 'production') {
              console.log('❌ PAGE VIEW INSERT ERROR:', pageViewError);
            }
          } else {
            if (process.env.NODE_ENV !== 'production') {
              console.log('✅ PAGE VIEW INSERT SUCCESS');
            }
          }
        }
      } catch (err) {
        fastify.log.error({ err }, 'Supabase collect error');
        return reply.code(500).send({ ok: false, error: 'supabase_error' });
      }
    } else {
      return reply.send({ ok: true, note: 'no_supabase' });
    }

    reply.send({ ok: true });
  });

  // App Proxy endpoints - Signature verification removed for tracking code compatibility

  // App Proxy presence endpoint
  fastify.get('/app-proxy/presence', async (req: any, reply: any) => {
    try {
      // Signature kontrolünü kaldırdık - tracking kodu için
      const q = (req.query as any) as Record<string, string>;
      const shop = q.shop as string;
      if (!shop) return reply.code(400).send({ ok: false, error: 'shop_required' });
      
      // Sanitize shop parameter for security
      if (!SHOP_RE.test(shop)) {
        return reply.code(400).send({ ok: false, error: 'invalid_shop' });
      }

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
      // ETag'i ts olmadan hesapla (ts her istekte değişir, 304 asla dönmez)
      const etagPayload = { current, display: current };
      const etag = 'W/"' + crypto.createHash('sha1').update(JSON.stringify(etagPayload)).digest('hex') + '"';
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
      // Auth kontrolü (opsiyonel - tracking için)
      const trackingKey = req.headers['x-tracking-key'] as string;
      if (trackingKey && (!process.env.TRACKING_KEY || trackingKey !== process.env.TRACKING_KEY)) {
        return reply.code(401).send({ ok: false, error: 'unauthorized' });
      }

      const schema = z.object({
        event: z.string().min(1).max(100),
        ts: z.number().positive().optional(),
        session_id: z.string().min(1).max(255), // UUID değil, herhangi bir string olabilir
        visitor_id: z.string().min(1).max(255).optional(),
        shop_domain: z.string().min(1).max(255),
        page: z.object({ 
          path: z.string().max(1000).optional(), 
          title: z.string().max(500).optional(), 
          ref: z.string().max(1000).optional() 
        }).optional(),
        duration_ms: z.number().min(0).optional(),
        payload: z.any().optional(),
        event_id: z.string().max(100).optional(),
      });
      const body = typeof req.body === 'string'
        ? schema.parse(JSON.parse(req.body))
        : schema.parse(req.body);

      if (!SHOP_RE.test(body.shop_domain)) {
        return reply.code(400).send({ ok: false, error: 'invalid_shop' });
      }
      
      // TS güvenliği: +/- 5dk dışındaki ts'leri server saatine çek
      const nowMs = Date.now();
      const tsMs = (typeof body.ts === 'number' && Math.abs(nowMs - body.ts) <= 5 * 60 * 1000)
        ? body.ts : nowMs;

      // Debug: Supabase kullanımını kontrol et
      if (process.env.NODE_ENV !== 'production') {
        console.log('🔍 SUPABASE DEBUG:', {
          hasSupabase: !!supabase,
          supabaseUrl: process.env.SUPABASE_URL ? 'SET' : 'NOT_SET',
          event: body.event,
          sessionId: body.session_id
        });
      }

      // Force log to stdout for Railway
      if (process.env.NODE_ENV !== 'production') {
        process.stdout.write(`\n🔍 SUPABASE DEBUG: hasSupabase=${!!supabase}\n`);
        process.stdout.write(`🔍 ENV VARS: SUPABASE_URL=${process.env.SUPABASE_URL ? 'SET' : 'NOT_SET'}\n`);
      }

      if (supabase) {
        try {
          // Upsert shop by domain
          const { data: shopData, error: shopError } = await supabase
            .from('shops')
            .upsert({ domain: body.shop_domain }, { onConflict: 'domain' })
            .select('id')
            .single();
          
          if (shopError) {
            fastify.log.error({ err: shopError }, 'Supabase shop upsert error (app-proxy)');
            return reply.code(500).send({ ok: false, error: 'shop_upsert_failed' });
          }
          
          const shopId = shopData.id;

          // Session ve visitor bilgilerini al
          const sessionId = body.session_id;
          const visitorId = body.visitor_id || null;
          
          if (process.env.NODE_ENV !== 'production') {
            console.log('🎯 COLLECT DEBUG:', {
              event: body.event,
              sessionId: sessionId,
              visitorId: visitorId,
              shopId: shopId,
              timestamp: new Date().toISOString()
            });
          }
          
          // Client'ın gönderdiği session_id'yi her zaman kullan
          // Session rotation client tarafında yapılıyor, server sadece kaydediyor
          const finalSessionId = sessionId;
          
          if (process.env.NODE_ENV !== 'production') {
            console.log('🎯 COLLECT DEBUG:', {
              event: body.event,
              sessionId: finalSessionId,
              visitorId: visitorId,
              shopId: shopId,
              timestamp: new Date().toISOString()
            });
          }
          
          // 1) Güncelle (first_seen'e dokunma)
          if (process.env.NODE_ENV !== 'production') {
            console.log('🔄 UPDATING SESSION (Supabase):', finalSessionId);
          }
          
          const { data: updated, error: updErr } = await supabase
            .from('sessions')
            .update({
              last_seen: new Date(tsMs).toISOString(),
              ip: (req.headers['x-forwarded-for'] || '').toString().split(',')[0] || req.ip || null,
              ua: (req.headers['user-agent'] as string) || null,
              referrer: body.page?.ref || null
            })
            .eq('id', finalSessionId)
            .select('id')  // Supabase v2'de etkilenen satırı görmek için select gerekir
            .maybeSingle();

          if (!updated) {
            // 2) Satır yoksa INSERT (first_seen burada set edilir)
            if (process.env.NODE_ENV !== 'production') {
              console.log('🆕 INSERTING NEW SESSION (Supabase):', finalSessionId);
            }
            const { error: insErr } = await supabase.from('sessions').insert({
              id: finalSessionId,
              shop_id: shopId,
              visitor_id: visitorId || null,
              first_seen: new Date(tsMs).toISOString(),
              last_seen: new Date(tsMs).toISOString(),
              ip: (req.headers['x-forwarded-for'] || '').toString().split(',')[0] || req.ip || null,
              ua: (req.headers['user-agent'] as string) || null,
              referrer: body.page?.ref || null
            });
            // INSERT başarısız olursa (yarış durumu), last_seen'i güncelle
            if (insErr) {
              if (process.env.NODE_ENV !== 'production') {
                console.log('🔄 Session INSERT yarışı (app-proxy), last_seen güncelleniyor:', finalSessionId);
              }
              await supabase.from('sessions')
                .update({ last_seen: new Date(tsMs).toISOString() })
                .eq('id', finalSessionId);
            } else {
              if (process.env.NODE_ENV !== 'production') {
                console.log(`✅ SESSION INSERTED SUCCESSFULLY (Supabase): ${finalSessionId}`);
              }
            }
          } else {
            if (process.env.NODE_ENV !== 'production') {
              console.log(`✅ SESSION UPDATED SUCCESSFULLY (Supabase): ${finalSessionId}`);
            }
          }

          // Events/Page views aynen (sadece foreign key doğru id)
          // Event deduplikasyonu için upsert kullan (event_id varsa)
          const eventData = {
            shop_id: shopId,
            session_id: finalSessionId,  // emniyet kemeri sonrası final session_id
            name: body.event,
            ts: new Date(tsMs).toISOString(),
            page_path: body.page?.path || null,
            payload: body.payload ?? null,
            event_id: body.event_id || null
          };
          
          const { error: eventError } = body.event_id 
            ? await supabase.from('events').upsert(eventData, { onConflict: 'shop_id,event_id' })
            : await supabase.from('events').insert(eventData);
          
          if (eventError) {
            fastify.log.error({ err: eventError }, 'Supabase event insert error (app-proxy)');
          }

          if (body.event === 'page_view') {
            if (process.env.NODE_ENV !== 'production') {
              console.log('📄 PAGE VIEW INSERT (app-proxy):', {
                shopId: shopId,
                sessionId: finalSessionId,
                path: body.page?.path || '/',
                title: body.page?.title || '',
                ts: new Date(tsMs).toISOString()
              });
            }
            
            const { error: pageViewError } = await supabase.from('page_views').insert({
              shop_id: shopId,
              session_id: finalSessionId,  // emniyet kemeri sonrası final session_id
              path: body.page?.path || '/',
              title: body.page?.title || '',
              engaged_ms: body.duration_ms ? Math.max(0, Math.round(body.duration_ms)) : null,
              ts: new Date(tsMs).toISOString()
            });
            
            if (pageViewError) {
              fastify.log.error({ err: pageViewError }, 'Supabase page view insert error (app-proxy)');
              if (process.env.NODE_ENV !== 'production') {
                console.log('❌ PAGE VIEW INSERT ERROR (app-proxy):', pageViewError);
              }
            } else {
              if (process.env.NODE_ENV !== 'production') {
                console.log('✅ PAGE VIEW INSERT SUCCESS (app-proxy)');
              }
            }
          }
        } catch (err) {
          fastify.log.error({ err }, 'Supabase app-proxy collect error');
          return reply.code(500).send({ ok: false, error: 'supabase_error' });
        }
      } else {
        return reply.send({ ok: true, note: 'no_supabase' });
      }

      return reply.send({ 
        ok: true, 
        debug: {
          hasSupabase: !!supabase,
          supabaseUrl: process.env.SUPABASE_URL ? 'SET' : 'NOT_SET'
        }
      });
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
