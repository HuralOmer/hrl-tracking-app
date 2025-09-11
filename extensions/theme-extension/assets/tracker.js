// EcomXtrade Tracking Script
(function() {
  'use strict';
  
  // Configuration
  const TRACKING_URL = 'https://hrl-tracking-app-production.up.railway.app';
  const SHOP_DOMAIN = window.location.hostname;
  
  // Generate session ID
  function generateSessionId() {
    return 'session_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  }
  
  // Get or create session ID
  function getSessionId() {
    let sessionId = localStorage.getItem('ecomxtrade_session_id');
    if (!sessionId) {
      sessionId = generateSessionId();
      localStorage.setItem('ecomxtrade_session_id', sessionId);
    }
    return sessionId;
  }
  
  // Track event
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
    
    // Send to tracking endpoint
    fetch(`${TRACKING_URL}/collect`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(eventData)
    }).catch(err => console.log('Tracking error:', err));
  }
  
  // Track page view
  function trackPageView() {
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
    // Track initial page view
    trackPageView();
    
    // Track page changes (SPA support)
    let lastUrl = window.location.href;
    new MutationObserver(() => {
      const url = window.location.href;
      if (url !== lastUrl) {
        lastUrl = url;
        trackPageView();
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
    trackPurchase
  };
})();
