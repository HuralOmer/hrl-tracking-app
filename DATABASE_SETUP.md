# Database Setup - Kritik Index'ler

## ⚠️ ÖNEMLİ: Bu index'ler olmadan uygulama yavaşlar!

### 🚨 Kritik Index'ler (MUTLAKA ÇALIŞTIRIN)

Bu index'ler olmadan dashboard sorguları çok yavaş çalışır ve büyük veri setlerinde timeout olabilir.

#### 1. Event Deduplikasyon (UNIQUE)
```sql
CREATE UNIQUE INDEX IF NOT EXISTS events_shop_event_id_uniq
  ON public.events (shop_id, event_id) 
  WHERE event_id IS NOT NULL;
```
**Neden kritik:** Event deduplikasyon için şart. Aynı event_id'li eventler tekrar eklenmez.

#### 2. Sessions Performance (Dashboard)
```sql
CREATE INDEX IF NOT EXISTS sessions_shop_first_seen_idx 
  ON public.sessions (shop_id, first_seen DESC);
```
**Neden kritik:** 24 saatlik dashboard sorguları için şart. Sessions sayımı çok hızlanır.

#### 3. Page Views Performance (Dashboard)
```sql
CREATE INDEX IF NOT EXISTS page_views_shop_ts_idx 
  ON public.page_views (shop_id, ts DESC);
```
**Neden kritik:** Sayfa görüntüleme sayıları için şart. Page view sorguları hızlanır.

#### 4. Events Performance (Dashboard)
```sql
CREATE INDEX IF NOT EXISTS events_shop_ts_idx 
  ON public.events (shop_id, ts DESC);
```
**Neden kritik:** Event sorguları ve conversion rate hesaplamaları için şart.

### 📊 Performans Etkisi

**Index'ler olmadan:**
- Dashboard yükleme süresi: 5-30 saniye
- 24 saatlik sorgular: 10-60 saniye
- Büyük veri setlerinde: Timeout

**Index'ler ile:**
- Dashboard yükleme süresi: 0.1-1 saniye
- 24 saatlik sorgular: 0.1-0.5 saniye
- Büyük veri setlerinde: Hızlı

### 🔧 Kurulum

1. Supabase SQL Editor'a git
2. `database_indexes.sql` dosyasını aç
3. Tüm komutları çalıştır
4. Index'lerin oluştuğunu kontrol et

### ✅ Doğrulama

Index'lerin oluştuğunu kontrol et:
```sql
SELECT 
    schemaname,
    tablename,
    indexname,
    indexdef
FROM pg_indexes 
WHERE schemaname = 'public' 
    AND tablename IN ('sessions', 'page_views', 'events', 'shops')
ORDER BY tablename, indexname;
```

### 🚨 Uyarı

Bu index'ler olmadan:
- Dashboard çok yavaş çalışır
- Kullanıcı deneyimi kötü olur
- Server kaynakları fazla kullanılır
- Büyük veri setlerinde uygulama çökebilir

**MUTLAKA çalıştırın!**
