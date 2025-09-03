// HRL Tracking Script - Shopify Integration
// Bu script Shopify mağazalarında otomatik olarak çalışacak

(function() {
  'use strict';
  
  // Configuration
  const currentSrc = (function(){
    try { return document.currentScript && document.currentScript.src; } catch(e) { return ''; }
  })();
  const inferredApi = (function(){
    try { return currentSrc ? new URL(currentSrc).origin + '/collect' : 'https://hrl-tracking-app-production-9cbc.up.railway.app/collect'; }
    catch { return 'https://hrl-tracking-app-production-9cbc.up.railway.app/collect'; }
  })();
  const CONFIG = {
    apiUrl: inferredApi,
    shopId: window.Shopify?.shop || 'unknown-shop',
    debug: true
  };

  // Event counter for debugging
  let eventCounter = 0;
  // Session management
  const SESSION_KEY = 'hrl.session.id';
  const LAST_PING_KEY = 'hrl.session.lastPing';
  function getSessionId(){
    try {
      let id = localStorage.getItem(SESSION_KEY);
      if (!id) {
        id = Math.random().toString(36).slice(2) + Date.now().toString(36);
        localStorage.setItem(SESSION_KEY, id);
      }
      return id;
    } catch { return 'anon'; }
  }
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
    if (isNewSession) {
      sendEvent('visit_start');
    }
    // heartbeat
    markPing();
    setInterval(() => { markPing(); sendEvent('visit_heartbeat'); }, 5*1000);
    // görünür olduğunda ve odağa geldiğinde ekstra ping gönder
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') { markPing(); sendEvent('visit_heartbeat'); }
    });
    window.addEventListener('focus', () => { markPing(); sendEvent('visit_heartbeat'); });
    
    // Page view end tracking (sayfa kapanırken) — sendBeacon tercih et
    window.addEventListener('beforeunload', () => {
      const dwellTime = Date.now() - pageStartTime;
      const payload = {
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
          dwell_ms: dwellTime
        }
      };

      if (navigator.sendBeacon) {
        try {
          const blob = new Blob([JSON.stringify(payload)], { type: 'text/plain' });
          navigator.sendBeacon(CONFIG.apiUrl, blob);
        } catch (_e) {
          // Fallback fetch (sync olmamalı)
          fetch(CONFIG.apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            keepalive: true,
            body: JSON.stringify(payload)
          }).catch(() => {});
        }
      } else {
        // Fallback fetch
        fetch(CONFIG.apiUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
          body: JSON.stringify(payload)
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
          buttonId: buttonId,
          extra: {
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
