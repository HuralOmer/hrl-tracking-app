-- Database Index & Unique Constraints for Performance + Deduplication
-- Run these commands in Supabase SQL Editor

-- 1. Event deduplication (event_id varsa)
-- Prevents duplicate events with same event_id per shop
CREATE UNIQUE INDEX IF NOT EXISTS events_shop_event_id_uniq
  ON public.events (shop_id, event_id) 
  WHERE event_id IS NOT NULL;

-- 2. Time window queries (dashboard performance)
-- Sessions by shop and time (most recent first)
CREATE INDEX IF NOT EXISTS sessions_shop_first_seen_idx 
  ON public.sessions (shop_id, first_seen DESC);

-- Page views by shop and time (most recent first)
CREATE INDEX IF NOT EXISTS page_views_shop_ts_idx 
  ON public.page_views (shop_id, ts DESC);

-- Events by shop and time (most recent first)
CREATE INDEX IF NOT EXISTS events_shop_ts_idx 
  ON public.events (shop_id, ts DESC);

-- 3. Session rotation control (visitor lookup performance)
-- Fast lookup for visitor's last session per shop
CREATE INDEX IF NOT EXISTS sessions_visitor_shop_last_seen_idx
  ON public.sessions (visitor_id, shop_id, last_seen DESC);

-- 4. Additional performance indexes
-- Shop domain lookup (for shop_id resolution)
CREATE INDEX IF NOT EXISTS shops_domain_idx 
  ON public.shops (domain);

-- Session lookup by session_id (primary key, but good to have)
CREATE INDEX IF NOT EXISTS sessions_id_idx 
  ON public.sessions (id);

-- 5. Composite indexes for common queries
-- Dashboard metrics: sessions count by shop and time
CREATE INDEX IF NOT EXISTS sessions_shop_first_seen_count_idx 
  ON public.sessions (shop_id, first_seen) 
  WHERE first_seen >= NOW() - INTERVAL '24 hours';

-- Conversion events lookup
CREATE INDEX IF NOT EXISTS events_shop_name_ts_idx 
  ON public.events (shop_id, name, ts DESC) 
  WHERE name IN ('add_to_cart', 'checkout_started', 'purchase');

-- 6. Partial indexes for active data
-- Active sessions (last_seen within 24 hours)
CREATE INDEX IF NOT EXISTS sessions_active_idx 
  ON public.sessions (shop_id, last_seen DESC) 
  WHERE last_seen >= NOW() - INTERVAL '24 hours';

-- Recent page views (within 24 hours)
CREATE INDEX IF NOT EXISTS page_views_recent_idx 
  ON public.page_views (shop_id, ts DESC) 
  WHERE ts >= NOW() - INTERVAL '24 hours';

-- Recent events (within 24 hours)
CREATE INDEX IF NOT EXISTS events_recent_idx 
  ON public.events (shop_id, ts DESC) 
  WHERE ts >= NOW() - INTERVAL '24 hours';
