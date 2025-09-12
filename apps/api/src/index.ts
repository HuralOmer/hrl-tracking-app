import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { z } from 'zod';
// PostgreSQL imports removed - using only Supabase
import Redis from 'ioredis';
import { Redis as UpstashRedis } from '@upstash/redis';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

async function bootstrap(): Promise<void> {
  const fastify = Fastify({ logger: true });
  await fastify.register(cors, {
    origin: '*',
    methods: ['GET', 'POST'],
    allowedHeaders: ['*'],
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
  const supabaseKey = process.env.SUPABASE_ANON_KEY || '';
  const supabase = supabaseUrl && supabaseKey ? createClient(supabaseUrl, supabaseKey) : null;

  // Redis configuration
  const redisUrl = process.env.REDIS_URL || process.env.UPSTASH_REDIS_REST_URL;
  const useRest = !!process.env.UPSTASH_REDIS_REST_URL;
  const redis = redisUrl ? (useRest ? new UpstashRedis({ url: process.env.UPSTASH_REDIS_REST_URL!, token: process.env.UPSTASH_REDIS_REST_TOKEN! }) : new Redis(redisUrl)) : null;
  
  // Constants
  const ACTIVE_WINDOW_SEC = 30; // 30 seconds
  
  // Real-time subscriptions for live updates
  if (supabase) {
    // Subscribe to events table changes
    supabase
      .channel('events_changes')
      .on('postgres_changes', 
        { event: 'INSERT', schema: 'public', table: 'events' },
        (payload) => {
          fastify.log.info({ payload }, 'New event received via real-time');
          // Broadcast to WebSocket clients if needed
        }
      )
      .subscribe();
    
    // Subscribe to users table changes
    supabase
      .channel('users_changes')
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'users' },
        (payload) => {
          fastify.log.info({ payload }, 'User updated via real-time');
        }
      )
      .subscribe();
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
  const TRACKING_URL = 'https://hrl-tracking-app-production.up.railway.app';
  const SHOP_DOMAIN = window.location.hostname;
  
  console.log('🚀 ECOMXTRADE TRACKING SCRIPT v2.1 LOADED FROM API');
  
  // Leader tab management
  let isLeaderTab = false;
  let leaderTabId = null;
  let heartbeatInterval = null;
  
  // Activity tracking
  let lastActivityTime = Date.now();
  let activityTimeout = null;
  const INACTIVITY_TIMEOUT = 4 * 60 * 1000; // 4 dakika
  
  // Generate session ID (UUID format)
  function generateSessionId() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c == 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
  }

  // Validate UUID format
  function isValidUUID(uuid) {
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return uuidRegex.test(uuid);
  }
  
  // Get or create session ID - Mevcut session'ı kullan veya yeni oluştur
  function getSessionId() {
    // Önce localStorage'dan mevcut session'ı kontrol et
    let sessionId = localStorage.getItem('ecomxtrade_session_id');
    
    // Eğer session yoksa veya geçersizse yeni oluştur
    if (!sessionId || !isValidUUID(sessionId)) {
      sessionId = generateSessionId();
      localStorage.setItem('ecomxtrade_session_id', sessionId);
      console.log('🆕🆕🆕 NEW SESSION ID GENERATED v2.1:', sessionId);
      console.log('🆕🆕🆕 TIMESTAMP:', new Date().toISOString());
    } else {
      console.log('♻️♻️♻️ REUSING EXISTING SESSION v2.1:', sessionId);
    }
    
    return sessionId;
  }

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
      console.log('Became leader tab:', tabId);
    } else {
      isLeaderTab = false;
      leaderTabId = existingLeader;
      console.log('Following leader tab:', existingLeader);
    }
    
    // Update leader timestamp every 10 seconds
    if (isLeaderTab) {
      setInterval(() => {
        localStorage.setItem('ecomxtrade_leader_timestamp', Date.now().toString());
      }, 10000);
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
      console.log('Lost leadership to:', currentLeader);
    } else if (!isLeaderTab && (!currentLeader || (now - parseInt(leaderTimestamp)) > 30000)) {
      // Leader is inactive, become new leader
      initializeLeaderTab();
    }
  }

  // Activity detection - kullanıcı aktif mi?
  function updateActivity() {
    lastActivityTime = Date.now();
    
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
    
    const sessionId = getSessionId();
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

  // Track event - Hibrit sistem
  function trackEvent(eventName, payload = {}) {
    const sessionId = getSessionId();
    const eventData = {
      event: eventName,
      ts: Date.now(),
      session_id: sessionId,
      shop_domain: SHOP_DOMAIN,
      page: {
        path: window.location.pathname,
        title: document.title,
        ref: document.referrer
      },
      payload: payload,
      event_id: 'event_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9)
    };
    
    console.log('📤 SENDING EVENT v2.1:', {
      event: eventName,
      sessionId: sessionId,
      timestamp: new Date().toISOString()
    });
    
    // Critical event'ler için sendBeacon kullan (tarayıcı kapanırken çalışır)
    const criticalEvents = ['page_view', 'beforeunload', 'unload'];
    
    if (criticalEvents.includes(eventName) && navigator.sendBeacon) {
      // sendBeacon kullan - daha güvenilir ama debug zor
      const success = navigator.sendBeacon(
        \`\${TRACKING_URL}/app-proxy/collect\`,
        JSON.stringify(eventData)
      );
      
      if (!success) {
        console.warn('sendBeacon failed, falling back to fetch');
        // Fallback to fetch
        fetch(\`\${TRACKING_URL}/app-proxy/collect\`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(eventData)
        }).catch(err => console.error('Event tracking failed:', err.message));
      }
    } else {
      // Normal event'ler için fetch kullan - debug kolay
      fetch(\`\${TRACKING_URL}/app-proxy/collect\`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(eventData)
      }).catch(err => {
        console.error('Event tracking failed:', err.message);
      });
    }
  }
  
  // Track page view
  function trackPageView() {
    console.log('📄📄📄 TRACKING PAGE VIEW v2.1');
    console.log('📄📄📄 URL:', window.location.href);
    trackEvent('page_view');
  }
  
  // Track add to cart
  function trackAddToCart(productId, variantId, quantity = 1) {
    trackEvent('add_to_cart', {
      product_id: productId,
      variant_id: variantId,
      quantity: quantity
    });
  }
  
  // Track checkout started
  function trackCheckoutStarted() {
    trackEvent('checkout_started');
  }
  
  // Track purchase
  function trackPurchase(orderId, total, currency) {
    trackEvent('purchase', {
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
    
    // Start presence heartbeat (5 saniyede bir) - only leader tab
    heartbeatInterval = setInterval(() => {
      checkLeaderStatus();
      sendPresenceHeartbeat();
    }, 5000);
    
    // Track page changes (SPA support)
    let lastUrl = window.location.href;
    new MutationObserver(() => {
      const url = window.location.href;
      if (url !== lastUrl) {
        lastUrl = url;
        trackPageView();
        // Page değiştiğinde de heartbeat gönder
        sendPresenceHeartbeat();
      }
    }).observe(document, { subtree: true, childList: true });
    
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
    // Get real-time data
    const now = Math.floor(Date.now() / 1000);
    let activeUsers = 0;
    let totalSessions = 0;
    let pageViews = 0;
    let conversionRate = 0;

    // Get active users from Redis
    if (redis) {
      const shop = 'ecomxtrade.myshopify.com';
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
      timestamp: new Date().toISOString()
    });
  });

  // Redis cleanup endpoint
  fastify.post('/cleanup', async (req: any, reply: any) => {
    if (!redis) {
      return reply.send({ ok: true, note: 'no_redis' });
    }

    try {
      const q = (req.query as any) as Record<string, string>;
      const shop = q.shop as string || 'ecomxtrade.myshopify.com';
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
    // Get real-time data
    const now = Math.floor(Date.now() / 1000);
    let activeUsers = 0;
    let totalSessions = 0;
    let pageViews = 0;
    let conversionRate = 0;

    // Get active users from Redis
    if (redis) {
      const shop = 'ecomxtrade.myshopify.com'; // Default shop for demo
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
        fastify.log.error({ err }, 'Supabase error in dashboard stats');
        // Fallback to demo data
        totalSessions = Math.floor(Math.random() * 500) + 100;
        pageViews = Math.floor(Math.random() * 2000) + 500;
        conversionRate = parseFloat((Math.random() * 5 + 1).toFixed(1));
      }
    } else {
      // Demo data when no database
      totalSessions = Math.floor(Math.random() * 500) + 100;
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
              // Fetch all dashboard data from API
              const response = await fetch('https://hrl-tracking-app-production.up.railway.app/api/dashboard?t=' + Date.now());
              const data = await response.json();
              
              // Update all metrics
              document.getElementById('activeUsers').textContent = data.activeUsers || 0;
              document.getElementById('totalSessions').textContent = data.totalSessions || 0;
              document.getElementById('pageViews').textContent = data.pageViews || 0;
              document.getElementById('conversionRate').textContent = data.conversionRate + '%' || '0%';
              
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
            <div class="endpoint">GET /ws - WebSocket real-time updates</div>
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
        ts: z.number().positive() 
      })
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

  // WebSocket endpoint for real-time updates
  fastify.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, (connection: any, req: any) => {
      const q = (req.query as any) as Record<string, string>;
      const shop = q.shop as string || 'ecomxtrade.myshopify.com';
      
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

        // Her girişte tamamen yeni session oluştur
        const ipHeader = (req.headers['x-forwarded-for'] as string) || '';
        const ip = (ipHeader.split(',')[0] || req.ip || null) as any;
        const ua = (req.headers['user-agent'] as string) || null;
        const ref = body.page?.ref || null;
        
        // Client'tan gelen sabit session_id'yi kullan
        const sessionId = body.session_id;
        
        // Her girişte yeni session oluştur
        const { error: sessionInsertErr } = await supabase
          .from('sessions')
          .insert({
            id: crypto.randomUUID(),
            shop_id: shopId,
            session_id: sessionId,
            ip_address: ip,
            user_agent: ua,
            first_seen: new Date().toISOString(),
            last_seen: new Date().toISOString()
          });
        if (sessionInsertErr) fastify.log.error({ err: sessionInsertErr }, 'Supabase session insert error');

        // Insert event
        const tsMs = body.ts ?? Date.now();
        const { error: eventError } = await supabase
          .from('events')
          .insert({
            shop_id: shopId,
            session_id: sessionId,
            event_name: body.event,
            created_at: new Date(tsMs).toISOString(),
            event_data: body.payload ?? null
          });
        
        if (eventError) {
          fastify.log.error({ err: eventError }, 'Supabase event insert error');
        }

        // Insert page view if it's a page_view event
        if (body.event === 'page_view') {
          const { error: pageViewError } = await supabase
            .from('page_views')
            .insert({
              shop_id: shopId,
              session_id: sessionId,
              url: body.page?.path || '/',
              title: body.page?.title || '',
              referrer: body.page?.ref || null,
              viewed_at: new Date(tsMs).toISOString()
            });
          
          if (pageViewError) {
            fastify.log.error({ err: pageViewError }, 'Supabase page view insert error');
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
      // Signature kontrolünü kaldırdık - tracking kodu için

      const body = z.object({
        event: z.string().min(1).max(100),
        ts: z.number().positive().optional(),
        session_id: z.string().uuid(),
        shop_domain: z.string().min(1).max(255),
        page: z.object({ 
          path: z.string().max(1000).optional(), 
          title: z.string().max(500).optional(), 
          ref: z.string().max(1000).optional() 
        }).optional(),
        duration_ms: z.number().positive().optional(),
        payload: z.any().optional(),
        event_id: z.string().max(100).optional(),
      }).parse(req.body);

      // Debug: Supabase kullanımını kontrol et
      console.log('🔍 SUPABASE DEBUG:', {
        hasSupabase: !!supabase,
        supabaseUrl: process.env.SUPABASE_URL ? 'SET' : 'NOT_SET',
        event: body.event,
        sessionId: body.session_id
      });

      // Force log to stdout for Railway
      process.stdout.write(`\n🔍 SUPABASE DEBUG: hasSupabase=${!!supabase}\n`);
      process.stdout.write(`🔍 ENV VARS: SUPABASE_URL=${process.env.SUPABASE_URL ? 'SET' : 'NOT_SET'}\n`);

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

          // Her girişte tamamen yeni session oluştur
          const ipHeader = (req.headers['x-forwarded-for'] as string) || '';
          const ip = (ipHeader.split(',')[0] || req.ip || null) as any;
          const ua = (req.headers['user-agent'] as string) || null;
          const ref = body.page?.ref || null;
          
          // Session ID'yi client'tan al (localStorage'dan geliyor)
          const sessionId = body.session_id;
          
          console.log('🎯 COLLECT DEBUG:', {
            event: body.event,
            sessionId: sessionId,
            shopId: shopId,
            timestamp: new Date().toISOString()
          });
          
          // Session'ı upsert et - her event'te session'ı güncelle
          console.log('🔄 UPSERTING SESSION (Supabase):', sessionId);
          
          const { error: sessionError } = await supabase
            .from('sessions')
            .upsert({
              id: sessionId, // session_id'yi id olarak kullan
              shop_id: shopId,
              session_id: sessionId,
              ip_address: ip,
              user_agent: ua,
              first_seen: new Date().toISOString(),
              last_seen: new Date().toISOString()
            }, { 
              onConflict: 'id',
              ignoreDuplicates: false 
            });
          
          if (sessionError) {
            fastify.log.error({ err: sessionError }, 'Supabase session upsert error (app-proxy)');
          } else {
            console.log('✅ SESSION UPSERTED SUCCESSFULLY (Supabase):', sessionId);
          }

          // Insert event
          const tsMs = body.ts ?? Date.now();
          const { error: eventError } = await supabase
            .from('events')
            .insert({
              shop_id: shopId,
              session_id: sessionId,
              event_name: body.event,
              created_at: new Date(tsMs).toISOString(),
              event_data: body.payload ?? null
            });
          
          if (eventError) {
            fastify.log.error({ err: eventError }, 'Supabase event insert error (app-proxy)');
          }

          // Insert page view if it's a page_view event
          if (body.event === 'page_view') {
            console.log('📄 INSERTING PAGE VIEW:', {
              sessionId: sessionId,
              url: body.page?.path || '/',
              title: body.page?.title || ''
            });
            
            const { error: pageViewError } = await supabase
              .from('page_views')
              .insert({
                shop_id: shopId,
                session_id: sessionId,
                url: body.page?.path || '/',
                title: body.page?.title || '',
                referrer: body.page?.ref || null,
                viewed_at: new Date(tsMs).toISOString()
              });
            
            if (pageViewError) {
              fastify.log.error({ err: pageViewError }, 'Supabase page view insert error (app-proxy)');
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
