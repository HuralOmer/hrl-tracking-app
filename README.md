# Shopify Tracking App

Modern, performanslı Shopify mağaza takip uygulaması. Gerçek zamanlı kullanıcı aktivitelerini takip eder ve detaylı analitik sağlar.

## 🚀 Özellikler

- **Gerçek Zamanlı Takip**: Aktif kullanıcı sayısını canlı olarak gösterir
- **App Proxy Entegrasyonu**: Shopify App Proxy ile güvenli veri toplama
- **SSE Desteği**: Server-Sent Events ile düşük gecikmeli güncellemeler
- **Redis Optimizasyonu**: Yüksek performanslı veri saklama
- **Supabase Entegrasyonu**: Güvenilir veritabanı çözümü
- **Modern UI**: Shopify Polaris ile tutarlı arayüz

## 📁 Proje Yapısı

```
├── apps/
│   ├── api/                 # Backend API (Fastify + TypeScript)
│   └── admin/               # Admin Dashboard (React + Polaris)
├── extensions/              # Shopify Extensions
│   ├── theme-app-embed/     # Mağaza temasına gömme
│   └── web-pixel/           # E-ticaret olayları
├── packages/
│   └── tracker/             # Frontend tracking script
├── db/                      # Veritabanı şeması
└── railway.toml             # Railway deployment config
```

## 🛠️ Kurulum

### 1. Bağımlılıkları Yükleyin
```bash
pnpm install
```

### 2. Environment Variables
`.env` dosyasını düzenleyin:
```env
DATABASE_URL=your_supabase_url
REDIS_URL=your_redis_url
UPSTASH_REDIS_REST_URL=your_upstash_url
UPSTASH_REDIS_REST_TOKEN=your_upstash_token
APP_PROXY_SECRET=your_app_proxy_secret
PORT=8082
```

### 3. Veritabanını Kurun
Supabase'de `db/migrations.sql` dosyasını çalıştırın.

### 4. Geliştirme Modunda Çalıştırın
```bash
pnpm dev
```

## 🚀 Deployment

### Railway ile Deploy
```bash
# Railway CLI ile
railway login
railway link
railway up
```

### Environment Variables (Railway)
- `DATABASE_URL`: Supabase connection string
- `REDIS_URL`: Redis connection string
- `UPSTASH_REDIS_REST_URL`: Upstash Redis REST URL
- `UPSTASH_REDIS_REST_TOKEN`: Upstash Redis token
- `APP_PROXY_SECRET`: Shopify App Proxy secret

## 📊 API Endpoints

### Health Check
```
GET /health
```

### Presence Tracking
```
POST /presence/beat
GET /presence/stream
GET /app-proxy/presence
```

### Event Collection
```
POST /collect
POST /app-proxy/collect
```

## 🔧 Geliştirme

### Type Check
```bash
pnpm typecheck
```

### Build
```bash
pnpm build
```

### Lint
```bash
pnpm lint
```

## 📝 Lisans

MIT License
