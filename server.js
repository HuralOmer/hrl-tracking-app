// collector/server.js
/* eslint-disable no-console */
const express = require("express");
const cors = require("cors");
const path = require("path");
const { Pool } = require("pg");

const app = express();

// ---- CONFIG ----
const PORT = process.env.PORT || 8080;
const LOG_REQUESTS = process.env.LOG_REQUESTS === "1";
const DEBUG_ERRORS = process.env.DEBUG_ERRORS === "1";

// DB
const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL eksik! Railway/Supabase connection string'i env olarak girin.");
  process.exit(1);
}
const pool = new Pool({ connectionString: DATABASE_URL });

// ---- MIDDLEWARES ----
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    credentials: false,
  })
);

// Pre-body logger
if (LOG_REQUESTS) {
  app.use((req, _res, next) => {
    console.log(`[req] ${req.method} ${req.path}`);
    next();
  });
}

// Body parsers (sırayla deneyeceğiz)
app.use(express.json({ limit: "200kb", type: ["application/json", "application/json; charset=utf-8"] }));
app.use(express.text({ limit: "200kb", type: "*/*" })); // sendBeacon text/plain vs.

// Statikler (test-send.html burada)
app.use(express.static(path.join(__dirname)));

// ---- HELPERS ----
function asJsonMaybe(raw) {
  if (raw == null) return null;
  if (typeof raw === "object") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function insertEvent({ shopId, event, productHandle, buttonId, extra }) {
  // extra obj ise JSON string'e çevir
  const extraStr = extra ? (typeof extra === "string" ? extra : JSON.stringify(extra)) : null;

  const text = `
    insert into events (shop_id, event_name, product_handle, button_id, extra_json, created_at)
    values ($1, $2, $3, $4, $5, now())
    returning id
  `;
  const vals = [shopId, event, productHandle || null, buttonId || null, extraStr];
  const { rows } = await pool.query(text, vals);
  return rows[0].id;
}

function ok(res, data = {}) {
  res.status(200).json({ ok: true, ...data });
}

function bad(res, msg, code = 400) {
  res.status(code).json({ ok: false, error: msg });
}

function normalizePayload(req) {
  // GET ile gelirse query’den oku
  if (req.method === "GET") {
    const { shopId, event, productHandle, buttonId, extra } = req.query;
    return {
      shopId,
      event,
      productHandle,
      buttonId,
      extra: asJsonMaybe(extra) ?? extra ?? null,
      _src: "query",
    };
  }

  // POST: önce JSON body
  if (req.is("application/json")) {
    const b = req.body || {};
    return {
      shopId: b.shopId,
      event: b.event,
      productHandle: b.productHandle,
      buttonId: b.buttonId,
      extra: b.extra ?? null,
      _src: "json",
    };
  }

  // Son çare: text body (sendBeacon çoğunlukla text/plain)
  if (typeof req.body === "string" && req.body.trim()) {
    const parsed = asJsonMaybe(req.body.trim());
    if (parsed) {
      return {
        shopId: parsed.shopId,
        event: parsed.event,
        productHandle: parsed.productHandle,
        buttonId: parsed.buttonId,
        extra: parsed.extra ?? null,
        _src: "text",
      };
    }
  }
  return { _src: "unknown" };
}

// ---- ROUTES ----

// Basit kök: tarayıcıda “Cannot GET /” yerine ufak bilgi
app.get("/", (_req, res) => {
  res
    .status(200)
    .type("text/html")
    .send(
      `<pre>OK ${nowIso()}
      
- Test sayfası: /test-send.html
- Toplama endpointleri: POST /collect  (alias: /c, /e)
- GET /collect sadece sağlık kontrol içindir.</pre>`
    );
});

// Sağlık kontrol
app.get("/healthz", (_req, res) => res.status(200).json({ ok: true, time: nowIso() }));

// OPTIONS preflight
app.options(["/collect", "/c", "/e"], (_req, res) => res.sendStatus(204));

// GET bilgi amaçlı (404 yerine 200 ve açıklama)
app.get(["/collect", "/c", "/e"], (_req, res) => {
  res
    .status(200)
    .json({ ok: true, hint: "Bu endpoint POST ile veri toplar. (GET sadece test amaçlıdır.)" });
});

// TOPLAMA (POST)
async function handleCollect(req, res) {
  try {
    const p = normalizePayload(req);

    if (LOG_REQUESTS) {
      console.log(`[collect] src=${p._src} payload=`, {
        shopId: p.shopId,
        event: p.event,
        productHandle: p.productHandle,
        buttonId: p.buttonId,
        extra: p.extra,
      });
    }

    const miss = [];
    if (!p.shopId) miss.push("shopId");
    if (!p.event) miss.push("event");
    if (miss.length) return bad(res, `missing_params: ${miss.join(",")}`, 400);

    const id = await insertEvent({
      shopId: String(p.shopId),
      event: String(p.event),
      productHandle: p.productHandle ? String(p.productHandle) : null,
      buttonId: p.buttonId ? String(p.buttonId) : null,
      extra: p.extra ?? null,
    });

    return ok(res, { id });
  } catch (err) {
    console.error("Collect error:", err);
    if (DEBUG_ERRORS) return bad(res, String(err.stack || err), 500);
    return bad(res, "internal_error", 500);
  }
}

app.post("/collect", handleCollect);
app.post("/c", handleCollect);
app.post("/e", handleCollect);

// ---- START ----
app.listen(PORT, () => {
  console.log(`Collector listening on http://localhost:${PORT}`);
});
