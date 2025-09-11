-- Shopify Tracking App Database Schema
-- Supabase PostgreSQL Migration

-- Shops table
CREATE TABLE IF NOT EXISTS shops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  domain text UNIQUE NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Sessions table
CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  shop_id uuid REFERENCES shops(id) ON DELETE CASCADE,
  first_seen timestamp with time zone NOT NULL,
  last_seen timestamp with time zone NOT NULL,
  ip inet,
  ua text,
  referrer text
);

-- Events table
CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid REFERENCES shops(id) ON DELETE CASCADE,
  session_id text REFERENCES sessions(id) ON DELETE CASCADE,
  name text NOT NULL,
  ts timestamp with time zone NOT NULL,
  page_path text,
  payload jsonb,
  event_id text UNIQUE
);

-- Page views table
CREATE TABLE IF NOT EXISTS page_views (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid REFERENCES shops(id) ON DELETE CASCADE,
  session_id text REFERENCES sessions(id) ON DELETE CASCADE,
  path text,
  title text,
  engaged_ms integer,
  ts timestamp with time zone NOT NULL,
  device text
);

-- Indexes for better performance
CREATE INDEX IF NOT EXISTS idx_sessions_shop_id ON sessions(shop_id);
CREATE INDEX IF NOT EXISTS idx_sessions_last_seen ON sessions(last_seen);
CREATE INDEX IF NOT EXISTS idx_events_shop_id ON events(shop_id);
CREATE INDEX IF NOT EXISTS idx_events_session_id ON events(session_id);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
CREATE INDEX IF NOT EXISTS idx_events_name ON events(name);
CREATE INDEX IF NOT EXISTS idx_page_views_shop_id ON page_views(shop_id);
CREATE INDEX IF NOT EXISTS idx_page_views_session_id ON page_views(session_id);
CREATE INDEX IF NOT EXISTS idx_page_views_ts ON page_views(ts);

-- RLS (Row Level Security) policies
ALTER TABLE shops ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE page_views ENABLE ROW LEVEL SECURITY;

-- Allow all operations for now (production'da daha sıkı olmalı)
CREATE POLICY "Allow all operations on shops" ON shops FOR ALL USING (true);
CREATE POLICY "Allow all operations on sessions" ON sessions FOR ALL USING (true);
CREATE POLICY "Allow all operations on events" ON events FOR ALL USING (true);
CREATE POLICY "Allow all operations on page_views" ON page_views FOR ALL USING (true);
