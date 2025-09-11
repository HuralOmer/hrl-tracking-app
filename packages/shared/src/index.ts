// Shared utilities and types
export interface TrackingEvent {
  event: string;
  ts: number;
  session_id: string;
  shop_domain: string;
  payload?: any;
}

export interface TrackingConfig {
  apiHost: string;
  shop: string;
  sessionId: string;
  mode: 'proxy-poll' | 'sse';
}
