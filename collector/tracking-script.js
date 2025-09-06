// HRL Tracking Script - Shopify Integration
// Bu script Shopify mağazalarında otomatik olarak çalışacak

(function() {
  // duplicate guard
  if (window.__HRL_TRACKING_LOADED__) { return; }
  window.__HRL_TRACKING_LOADED__ = true;
  'use strict';
  
  // Configuration (CDN/asset üzerinden yüklense bile doğru APP_URL'e git)
  const scriptEl = (function(){
    try { return document.currentScript || null; } catch(e) { return null; }
  })();
  const DEFAULT_APP = 'https://hrl-tracking-app-production-9cbc.up.railway.app';
  const apiFromAttr = (function(){ try { return scriptEl && scriptEl.getAttribute('data-api'); } catch(_) { return null; }})();
  const wsFromAttr  = (function(){ try { return scriptEl && scriptEl.getAttribute('data-ws'); } catch(_) { return null; }})();
  const apiUrl = apiFromAttr || (DEFAULT_APP + '/collect');
  const wsUrl = (function(){
    if (wsFromAttr) return wsFromAttr;
    try {
      const base = new URL(DEFAULT_APP);
      base.pathname = '/'; base.search = ''; base.hash = '';
      base.protocol = (base.protocol === 'https:') ? 'wss:' : 'ws:';
      return base.origin;
    } catch(_) { return (window.location && window.location.origin) || DEFAULT_APP; }
  })();
  const CONFIG = {
    apiUrl: apiUrl,
    shopId: window.Shopify?.shop || 'unknown-shop',
    debug: true,
    wsUrl: wsUrl
  };

  // Event counter for debugging
  let eventCounter = 0;
  // Session management + privacy
  const SESSION_KEY = 'hrl.session.id';
  const LAST_PING_KEY = 'hrl.session.lastPing';
  const COOKIE_SID = 'hrl_sid';
  const COOKIE_CONSENT = 'hrl_consent'; // mağaza tarafı bu çerezi 1 yapabilir

  function readCookie(name){
    try {
      const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()\[\]\\\/\+^])/g, '\\$1') + '=([^;]*)'));
      return m ? decodeURIComponent(m[1]) : null;
    } catch { return null; }
  }
  function writeCookie(name, value, days){
    try {
      const d = new Date();
      d.setTime(d.getTime() + (days*24*60*60*1000));
      document.cookie = `${name}=${encodeURIComponent(value)}; path=/; expires=${d.toUTCString()}; SameSite=Lax`;
    } catch {}
  }
  function hasConsent(){
    try {
      // 1) Shopify Privacy API varsa genişletilebilir; şimdilik basit cookie ile
      const c = readCookie(COOKIE_CONSENT);
      return c === '1' || c === 'true';
    } catch { return false; }
  }
  function generateId(){
    return Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
  function getSessionId(){
    try {
      if (hasConsent()) {
        // 1P cookie ile kalıcı ID
        let sid = readCookie(COOKIE_SID) || localStorage.getItem(SESSION_KEY);
        if (!sid) { sid = generateId(); }
        writeCookie(COOKIE_SID, sid, 365);
        try { localStorage.setItem(SESSION_KEY, sid); } catch{}

        return sid;
      }
      // İzin yoksa: anonim, yalnızca oturum (sessionStorage) 
      const key = 'hrl.session.ephemeral';
      try {
        let sid = sessionStorage.getItem(key);
        if (!sid) { sid = generateId(); sessionStorage.setItem(key, sid); }
        return sid;
      } catch { return generateId(); }
    } catch { return 'anon'; }
  }
  function isAnonymous(){ return !hasConsent(); }
  function markPing(){
    try { localStorage.setItem(LAST_PING_KEY, String(Date.now())); } catch{}
  }

  // Utility functions
  function log(...args) {
    if (CONFIG.debug) console.log('[HRL Tracking]', ...args);
  }

  function getProductHandle() {
    // Shopify product page'den handle al
    if (window.Shopify?.product?.handle) {
      return window.Shopify.product.handle;
    }
    
    // URL'den handle çıkarmaya çalış
    const path = window.location.pathname;
    const productMatch = path.match(/\/products\/([^\/\?]+)/);
    return productMatch ? productMatch[1] : null;
  }

  function getButtonId(element) {
    // Button ID'yi element'ten çıkar
    return element.id || 
           element.getAttribute('data-button-id') ||
           element.getAttribute('data-testid') ||
           element.className.split(' ')[0] ||
           'unknown-button';
  }

  function sendEvent(eventName, data = {}) {
    eventCounter++;
    const payload = {
      shopId: CONFIG.shopId,
      event: eventName,
      productHandle: getProductHandle(),
      buttonId: data.buttonId || null,
      extra: {
        url: window.location.href,
        referrer: document.referrer,
        userAgent: navigator.userAgent,
        timestamp: Date.now(),
        session_id: getSessionId(),
        is_anonymous: isAnonymous(),
        eventCounter: eventCounter,
        ...data.extra
      }
    };

    log(`Sending event #${eventCounter}:`, payload);

    // Fetch ile gönder (tek kanal)
    fetch(CONFIG.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    }).catch(err => {
      log('Error sending event:', err);
    });
  }

  // Page view tracking
  function trackPageView() {
    // session başlat (tek sefer)
    const last = Number(localStorage.getItem(LAST_PING_KEY) || '0');
    const now = Date.now();
    const isNewSession = !last || (now - last) > 30*60*1000; // 30 dk
    if (isNewSession) { sendEvent('visit_start'); }
    // Analitik özetler için page_view_start ekle
    try { sendEvent('page_view_start'); } catch(_e){}
    // heartbeat
    markPing();
    const hbJitter = Math.random() * 5000;
    setTimeout(() => setInterval(() => { markPing(); sendEvent('visit_heartbeat'); }, 5000), hbJitter);
    // görünür olduğunda ve odağa geldiğinde ekstra ping gönder
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { markPing(); sendEvent('visit_heartbeat'); }
    });
    window.addEventListener('focus', () => { markPing(); sendEvent('visit_heartbeat'); });
    
    // Page view end tracking (sayfa kapanırken) — sendBeacon tercih et
    window.addEventListener('beforeunload', () => {
      const dwellTime = Date.now() - pageStartTime;
      const pvPayload = {
        shopId: CONFIG.shopId,
        event: 'page_view_end',
        productHandle: getProductHandle(),
        buttonId: null,
        extra: {
          url: window.location.href,
          referrer: document.referrer,
          userAgent: navigator.userAgent,
          timestamp: Date.now(),
          session_id: getSessionId(),
          dwell_ms: dwellTime,
          is_anonymous: isAnonymous()
        }
      };
      const visitEndPayload = {
        shopId: CONFIG.shopId,
        event: 'visit_end',
        productHandle: getProductHandle(),
        buttonId: null,
        extra: {
          url: window.location.href,
          referrer: document.referrer,
          userAgent: navigator.userAgent,
          timestamp: Date.now(),
          session_id: getSessionId(),
          dwell_ms: dwellTime,
          is_anonymous: isAnonymous()
        }
      };

      if (navigator.sendBeacon) {
        try {
          const b1 = new Blob([JSON.stringify(pvPayload)], { type: 'text/plain' });
          const b2 = new Blob([JSON.stringify(visitEndPayload)], { type: 'text/plain' });
          navigator.sendBeacon(CONFIG.apiUrl, b1);
          navigator.sendBeacon(CONFIG.apiUrl, b2);
        } catch (_e) {
          // Fallback fetch (sync olmamalı)
          fetch(CONFIG.apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            keepalive: true,
            body: JSON.stringify(pvPayload)
          }).catch(() => {});
          fetch(CONFIG.apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            keepalive: true,
            body: JSON.stringify(visitEndPayload)
          }).catch(() => {});
        }
      } else {
        // Fallback fetch
        fetch(CONFIG.apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          body: JSON.stringify(pvPayload)
        }).catch(() => {});
        fetch(CONFIG.apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          body: JSON.stringify(visitEndPayload)
        }).catch(() => {});
      }
    });
  }

  // Button click tracking
  let clickListenerAdded = false;
  
  function trackButtonClicks() {
    if (clickListenerAdded) {
      log('Click listener already added, skipping...');
      return;
    }
    
    clickListenerAdded = true;
    document.addEventListener('click', (event) => {
      const target = event.target;
      
      // Önemli butonları filtrele
      const isImportantButton = target.matches(
        'button, .btn, [data-testid*="button"], [class*="button"], ' +
        'input[type="submit"], input[type="button"], ' +
        '.add-to-cart, .buy-now, .checkout, .purchase'
      );

      if (isImportantButton) {
        const buttonId = getButtonId(target);
        sendEvent('click', {
          // buttonId üst seviyede server tarafından saklanmıyor; payload'a da yaz
          buttonId: buttonId,
          extra: {
            button_id: buttonId,
            buttonText: target.textContent?.trim(),
            buttonClass: target.className
          }
        });
      }
    });
  }

  // Cart tracking
  let cartListenerAdded = false;
  
  function trackCartEvents() {
    if (cartListenerAdded) {
      log('Cart listener already added, skipping...');
      return;
    }
    
    cartListenerAdded = true;
    
    // Cart add events
    document.addEventListener('click', (event) => {
      if (event.target.matches('.add-to-cart, [data-testid*="add-to-cart"], [class*="add-to-cart"]')) {
        sendEvent('cart_add', {
          buttonId: getButtonId(event.target),
          extra: {
            productHandle: getProductHandle()
          }
        });
      }
    });

    // Cart update events (quantity change)
    document.addEventListener('change', (event) => {
      if (event.target.matches('input[type="number"], select[name*="quantity"]')) {
        sendEvent('cart_update', {
          extra: {
            quantity: event.target.value,
            productHandle: getProductHandle()
          }
        });
      }
    });
  }

  // Product view tracking - kaldırıldı (page_view_start zaten var)
  function trackProductView() {
    // Product view tracking kaldırıldı - page_view_start yeterli
    // Çünkü her product page'de zaten page_view_start event'i gönderiliyor
  }

  // Initialize tracking
  let isInitialized = false;
  
  function init() {
    if (isInitialized) {
      log('HRL Tracking already initialized, skipping...');
      return;
    }
    
    isInitialized = true;
    log('HRL Tracking initialized for shop:', CONFIG.shopId);
    
    const pageStartTime = Date.now();
    
    // Start tracking
    trackPageView();
    trackButtonClicks();
    trackCartEvents();
    trackProductView();
    
    log('All tracking events registered');

    // --- WS presence: lider sekme + ping ---
    (function setupWS(){
      const KEY = 'hrl.leader.lock';
      const LOCK_TTL = 8000; // ms
      const PING_MS = 3000; // 3s ping

      function now(){ return Date.now(); }
      function isLeader(){
        try {
          const v = JSON.parse(localStorage.getItem(KEY) || 'null');
          return v && v.owner === window.name && (now() - v.ts) < LOCK_TTL;
        } catch { return false; }
      }
      function tryAcquire(){
        try {
          const v = JSON.parse(localStorage.getItem(KEY) || 'null');
          if (!v || (now() - v.ts) >= LOCK_TTL) {
            localStorage.setItem(KEY, JSON.stringify({ owner: window.name, ts: now() }));
            return true;
          }
          return v.owner === window.name;
        } catch { return false; }
      }
      function refresh(){
        try { localStorage.setItem(KEY, JSON.stringify({ owner: window.name, ts: now() })); } catch {}
      }

      // window.name boş ise ata
      if (!window.name) { try { window.name = 'hrl_' + Math.random().toString(36).slice(2); } catch{} }

      let socket = null;
      function ensureSocket(){
        if (!window.io) return;
        if (!socket) {
          socket = window.io(CONFIG.wsUrl, {
            transports: ['websocket','polling'],
            reconnectionDelay: 500,
            reconnectionDelayMax: 3000,
            randomizationFactor: 0.5
          });
          socket.on('connect', () => {
            socket.emit('hello', { shopId: CONFIG.shopId, sessionId: getSessionId() });
            // bağlanır bağlanmaz ping
            socket.emit('ping');
          });
        }
      }

      // socket.io client script yoksa yükle
      (function injectIo(){
        if (window.io) { ensureSocket(); return; }
        const s = document.createElement('script');
        // Tam origin ile yükle (Shopify domaini yerine Collector origin)
        const base = (function(){ try { return new URL(CONFIG.wsUrl).origin; } catch(_) { return ''; } })();
        s.src = (base ? (base + '/socket.io/socket.io.js') : '/socket.io/socket.io.js');
        s.async = true;
        s.onload = () => ensureSocket();
        document.head.appendChild(s);
      })();

      const __hrlStartJitter = Math.random() * PING_MS;
      setTimeout(() => {
        setInterval(() => {
          if (tryAcquire()) {
            refresh();
            ensureSocket();
            if (window.io && socket && socket.connected) {
              socket.emit('ping');
            }
            // WS yoksa HTTP heartbeat fallback
            if (!socket || !socket.connected) {
              try {
                fetch((CONFIG.apiUrl.replace(/\/collect$/, '')) + '/hb', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  keepalive: true,
                  body: JSON.stringify({ shopId: CONFIG.shopId, sessionId: getSessionId() })
                }).catch(()=>{});
              } catch(_){}
            }
          }
        }, PING_MS);
      }, __hrlStartJitter);

      // görünür/odak olduğunda anında ping
      try {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible' && socket && socket.connected) {
            socket.emit('ping');
          }
        });
        window.addEventListener('focus', () => {
          if (socket && socket.connected) socket.emit('ping');
        });
      } catch(_){}
    })();
  }

  // DOM ready'de başlat
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Global olarak erişilebilir yap
  window.HRLTracking = {
    config: CONFIG,
    sendEvent: sendEvent,
    log: log
  };

})();
