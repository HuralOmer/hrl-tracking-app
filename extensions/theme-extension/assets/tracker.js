// EcomXtrade Tracking Script v2.0 - Cache Bypass
(function() {
  'use strict';
  
  // Configuration
  const TRACKING_URL = 'https://hrl-tracking-app-production.up.railway.app';
  const SHOP_DOMAIN = window.location.hostname;
  
  console.log('🚀 ECOMXTRADE TRACKING SCRIPT v2.0 LOADED');
  
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
  
  // Get or create session ID - Her girişte yeni session
  function getSessionId() {
    // Her sayfa yüklendiğinde yeni session oluştur
    const sessionId = generateSessionId();
    localStorage.setItem('ecomxtrade_session_id', sessionId);
    console.log('🆕🆕🆕 NEW SESSION ID GENERATED v2.0:', sessionId);
    console.log('🆕🆕🆕 TIMESTAMP:', new Date().toISOString());
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

    fetch(`${TRACKING_URL}/presence/beat`, {
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
    
    console.log('📤 SENDING EVENT:', {
      event: eventName,
      sessionId: sessionId,
      timestamp: new Date().toISOString()
    });
    
    // Critical event'ler için sendBeacon kullan (tarayıcı kapanırken çalışır)
    const criticalEvents = ['page_view', 'beforeunload', 'unload'];
    
    if (criticalEvents.includes(eventName) && navigator.sendBeacon) {
      // sendBeacon kullan - daha güvenilir ama debug zor
      const success = navigator.sendBeacon(
        `${TRACKING_URL}/app-proxy/collect`,
        JSON.stringify(eventData)
      );
      
      if (!success) {
        console.warn('sendBeacon failed, falling back to fetch');
        // Fallback to fetch
        fetch(`${TRACKING_URL}/app-proxy/collect`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(eventData)
        }).catch(err => console.error('Event tracking failed:', err.message));
      }
    } else {
      // Normal event'ler için fetch kullan - debug kolay
      fetch(`${TRACKING_URL}/app-proxy/collect`, {
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
    console.log('📄📄📄 TRACKING PAGE VIEW v2.0');
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
