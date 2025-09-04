-- events: ham olaylar
create table if not exists events (
  id bigserial primary key,
  ts timestamptz not null,
  shop_id text not null,
  event_name text not null,        -- page_view_start / page_view_end / click
  url text,
  referrer text,
  ua text,
  device text,
  os text,
  browser text,
  region_country text,
  region_city text,
  product_handle text,
  payload jsonb
);

create index if not exists idx_events_shop_ts on events (shop_id, ts);
create index if not exists idx_events_shop_event_ts on events (shop_id, event_name, ts);
create index if not exists idx_events_product on events (shop_id, product_handle);

-- ileride ürün başlığı/fiyatı eşlemek için cache
create table if not exists product_cache (
  shop_id text,
  handle text,
  title text,
  price numeric,
  currency text,
  collection text,
  updated_at timestamptz,
  primary key (shop_id, handle)
);

-- canlı presence tablosu (stabil aktif kullanıcı sayımı)
create table if not exists presence (
  shop_id text not null,
  session_id text not null,
  last_seen timestamptz not null,
  primary key (shop_id, session_id)
);

-- aktif oturumlar (boolean + last_seen ile daha stabil sayaç)
create table if not exists active_sessions (
  shop_id text not null,
  session_id text not null,
  active boolean not null default true,
  last_seen timestamptz not null,
  primary key (shop_id, session_id)
);
-- shopify mağaza access tokenları
create table if not exists shop_tokens (
  shop_domain text primary key,
  access_token text not null,
  scopes text,
  created_at timestamptz default now()
);