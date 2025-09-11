// Supabase PostgreSQL Schema for Shopify Tracking App

export const shops = {
  id: 'uuid PRIMARY KEY DEFAULT gen_random_uuid()',
  domain: 'text UNIQUE NOT NULL',
  created_at: 'timestamp with time zone DEFAULT now()',
  updated_at: 'timestamp with time zone DEFAULT now()'
};

export const sessions = {
  id: 'text PRIMARY KEY',
  shop_id: 'uuid REFERENCES shops(id) ON DELETE CASCADE',
  first_seen: 'timestamp with time zone NOT NULL',
  last_seen: 'timestamp with time zone NOT NULL',
  ip: 'inet',
  ua: 'text',
  referrer: 'text'
};

export const events = {
  id: 'uuid PRIMARY KEY DEFAULT gen_random_uuid()',
  shop_id: 'uuid REFERENCES shops(id) ON DELETE CASCADE',
  session_id: 'text REFERENCES sessions(id) ON DELETE CASCADE',
  name: 'text NOT NULL',
  ts: 'timestamp with time zone NOT NULL',
  page_path: 'text',
  payload: 'jsonb',
  event_id: 'text UNIQUE'
};

export const page_views = {
  id: 'uuid PRIMARY KEY DEFAULT gen_random_uuid()',
  shop_id: 'uuid REFERENCES shops(id) ON DELETE CASCADE',
  session_id: 'text REFERENCES sessions(id) ON DELETE CASCADE',
  path: 'text',
  title: 'text',
  engaged_ms: 'integer',
  ts: 'timestamp with time zone NOT NULL',
  device: 'text'
};

// Indexes for better performance
export const indexes = [
  'CREATE INDEX IF NOT EXISTS idx_sessions_shop_id ON sessions(shop_id);',
  'CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen);',
  'CREATE INDEX IF NOT EXISTS idx_events_shop_id ON events(shop_id);',
  'CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);',
  'CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);',
  'CREATE INDEX IF NOT EXISTS idx_events_name ON events(name);',
  'CREATE INDEX IF NOT EXISTS idx_page_views_shop_id ON page_views(shop_id);',
  'CREATE INDEX IF NOT EXISTS idx_page_views_session_id ON page_views(session_id);',
  'CREATE INDEX IF NOT EXISTS idx_page_views_ts ON page_views(ts);'
];
