// HRL Tracking Script - Shopify Integration
// Bu script Shopify mağazalarında otomatik olarak çalışacak

(function() {
  'use strict';
  
  // Configuration
  const CONFIG = {
    apiUrl: 'https://hrl-tracking-app-production-9cbc.up.railway.app/collect',
    shopId: window.Shopify?.shop || 'unknown-shop',
    debug: false
  };

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
        ...data.extra
      }
    };

    log('Sending event:', payload);

    // Fetch ile gönder
    fetch(CONFIG.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    }).catch(err => {
      log('Error sending event:', err);
    });

    // SendBeacon ile backup (sayfa kapanırken)
    if (navigator.sendBeacon) {
      navigator.sendBeacon(CONFIG.apiUrl, JSON.stringify(payload));
    }
  }

  // Page view tracking
  function trackPageView() {
    sendEvent('page_view_start');
    
    // Page view end tracking (sayfa kapanırken)
    window.addEventListener('beforeunload', () => {
      const dwellTime = Date.now() - pageStartTime;
      sendEvent('page_view_end', {
        extra: { dwell_ms: dwellTime }
      });
    });
  }

  // Button click tracking
  function trackButtonClicks() {
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
  function trackCartEvents() {
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

  // Product view tracking
  function trackProductView() {
    if (getProductHandle()) {
      sendEvent('product_view', {
        extra: {
          productHandle: getProductHandle(),
          productTitle: document.querySelector('h1')?.textContent?.trim()
        }
      });
    }
  }

  // Initialize tracking
  function init() {
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
