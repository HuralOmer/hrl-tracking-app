// collector/server.js
const express = require("express");
const path = require("path");
const { Pool } = require("pg");

const PORT = process.env.PORT || 8080;
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";

// --- PG pool (Railway/Supabase uyumlu SSL) ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

const app = express();
app.set("trust proxy", true);

// basit CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

if (process.env.LOG_REQUESTS === "1") {
  app.use((req, _res, next) => {
    console.log(`[req] ${req.method} ${req.url}`);
    next();
  });
}

app.use(express.json({ limit: "100kb" }));
app.use(express.urlencoded({ extended: true }));

// statik test sayfası
app.use(express.static(path.join(__dirname)));

// sağlık
app.get("/healthz", (_req, res) => res.json({ ok: true }));

// ---- Event toplama ----
const ALLOWED = new Set(["page_view_start", "page_view_end", "click"]);

app.post("/e", async (req, res) => {
  try {
    // hem query hem body’den oku
    const get = (k) =>
      (req.body?.[k] ?? req.query?.[k] ?? "").toString().trim();

    const event = get("event");
    const shopId = get("shopId") || get("shop_id");
    const productHandle = get("product") || get("product_handle");
    const buttonId = get("button_id");
    const dwellMsStr = get("dwellMs") || get("dwell_ms");

    if (!event || !ALLOWED.has(event)) {
      return res.status(400).json({ ok: false, error: "invalid_event" });
    }
    if (!shopId) {
      return res.status(400).json({ ok: false, error: "missing_shopId" });
    }

    // extra: string gelmişse JSON’a çevir
    let extra = req.body?.extra ?? req.query?.extra ?? null;
    if (typeof extra === "string" && extra.length) {
      try {
        extra = JSON.parse(extra);
      } catch {
        // bozuksa, düz string olarak sakla
      }
    }

    const dwellMs =
      dwellMsStr !== "" && !Number.isNaN(Number(dwellMsStr))
        ? Number(dwellMsStr)
        : null;

    const userAgent = req.get("user-agent") || null;
    const ip =
      (req.headers["x-forwarded-for"] || req.ip || "")
        .toString()
        .split(",")[0]
        .trim() || null;

    // DB insert
    const sql = `
      INSERT INTO events
        (event_type, shop_id, product_handle, button_id, dwell_ms, extra, user_agent, ip)
      VALUES
        ($1,         $2,      NULLIF($3,''),  NULLIF($4,''), $5,      $6,   $7,        $8)
      RETURNING id
    `;
    const params = [
      event,
      shopId,
      productHandle,
      buttonId,
      dwellMs,
      extra ?? null,
      userAgent,
      ip || null,
    ];

    const { rows } = await pool.query(sql, params);

    return res.json({ ok: true, id: rows[0].id });
  } catch (err) {
    // detaylı log (sadece sunucu tarafında)
    console.error("[/e] insert failed:", err);

    // İstersen geçici olarak ayrıntıyı görmek için DEBUG_ERRORS=1 ekleyebilirsin
    const payload =
      process.env.DEBUG_ERRORS === "1"
        ? { ok: false, error: "internal_error", code: err.code, message: err.message }
        : { ok: false, error: "internal_error" };

    return res.status(500).json(payload);
  }
});

// ---- Basit istatistik uçları ----
app.get("/stats/summary", async (req, res) => {
  try {
    const shopId = (req.query.shopId || req.query.shop_id || "").toString().trim();
    if (!shopId) return res.status(400).json({ error: "missing_shopId" });

    const viewsQ = `
      SELECT
        COUNT(*) FILTER (WHERE event_type IN ('page_view_start','page_view_end'))::int AS views,
        COALESCE(AVG(dwell_ms)::int, 0) AS avg_dwell_ms,
        COUNT(*) FILTER (WHERE event_type = 'click')::int AS clicks
      FROM events
      WHERE shop_id = $1
    `;
    const { rows } = await pool.query(viewsQ, [shopId]);
    res.json(rows[0]);
  } catch (e) {
    console.error("[/stats/summary] failed:", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

app.get("/stats/top-products", async (req, res) => {
  try {
    const shopId = (req.query.shopId || req.query.shop_id || "").toString().trim();
    if (!shopId) return res.status(400).json({ error: "missing_shopId" });

    const q = `
      SELECT product_handle,
             COUNT(*) FILTER (WHERE event_type IN ('page_view_start','page_view_end'))::int AS views,
             COUNT(*) FILTER (WHERE event_type='click')::int AS clicks
      FROM events
      WHERE shop_id=$1
      GROUP BY product_handle
      ORDER BY views DESC NULLS LAST
      LIMIT 20
    `;
    const { rows } = await pool.query(q, [shopId]);
    res.json(rows);
  } catch (e) {
    console.error("[/stats/top-products] failed:", e);
    res.status(500).json({ ok: false, error: "internal_error" });
  }
});

app.listen(PORT, () => {
  console.log(`Collector listening on http://localhost:${PORT}`);
});
