// Shopify Tracking App - Tracker
// Bu script Shopify mağazalarında çalışır ve kullanıcı aktivitelerini takip eder

interface TrackingConfig {
  apiHost: string;
  shop: string;
  sessionId: string;
  mode: 'proxy-poll' | 'sse';
}

class ShopifyTracker {
  private config: TrackingConfig;
  private isActive = false;
  private heartbeatInterval: number | null = null;
  private eventQueue: any[] = [];

  constructor(config: TrackingConfig) {
    this.config = config;
    this.init();
  }

  private init() {
    if (typeof window === 'undefined') return;
    
    this.sessionId = this.getOrCreateSessionId();
    this.isActive = true;
    
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => this.start());
    } else {
      this.start();
    }
  }

  private getOrCreateSessionId(): string {
    const key = 'shopify_tracking_session_id';
    let sessionId = localStorage.getItem(key);
    
    if (!sessionId) {
      sessionId = 'sess_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
      localStorage.setItem(key, sessionId);
    }
    
    return sessionId;
  }

  private start() {
    this.track('page_view', {
      path: window.location.pathname,
      title: document.title,
      ref: document.referrer
    });
    this.startHeartbeat();
  }

  private startHeartbeat() {
    if (this.heartbeatInterval) return;

    this.heartbeatInterval = window.setInterval(() => {
      this.sendHeartbeat();
    }, 10000);
  }

  private sendHeartbeat() {
    if (!this.isActive) return;

    const data = {
      shop: this.config.shop,
      session_id: this.config.sessionId,
      ts: Date.now()
    };

    fetch(`${this.config.apiHost}/presence/beat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
      keepalive: true
    }).catch(() => {});
  }

  public track(eventName: string, payload: any = {}) {
    if (!this.isActive) return;

    const event = {
      event: eventName,
      ts: Date.now(),
      event_id: `${eventName}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      session_id: this.config.sessionId,
      shop_domain: this.config.shop,
      page: {
        path: window.location.pathname,
        title: document.title,
        ref: document.referrer
      },
      payload
    };

    this.eventQueue.push(event);
    this.flushEvents();
  }

  private flushEvents() {
    if (this.eventQueue.length === 0) return;

    const events = [...this.eventQueue];
    this.eventQueue = [];

    events.forEach(event => {
      fetch(`${this.config.apiHost}/collect`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(event),
        keepalive: true
      }).catch(() => {
        this.eventQueue.push(event);
      });
    });
  }
}

export default ShopifyTracker;