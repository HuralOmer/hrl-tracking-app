/* eslint-disable no-console */
import express from 'express';
import cors from 'cors';

const app = express();

// --- Middlewares ---
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// sendBeacon için: text/plain gövdeleri de alalım
app.use(express.text({ type: ['text/plain'] }));

// Basit sağlık kontrolü
app.get('/health', (_req, res) => res.json({ ok: true }));

/**
 * Tüm event istekleri için ortak handler
 * /e, /collect, /api/collect -> hepsi buraya geliyor
 */
async function handleCollect(req, res) {
  try {
    const method = req.method;

    // 1) Paramları topla (GET->query, POST->body)
    let params = method === 'GET' ? req.query : req.body;

    // 2) sendBeacon gibi durumlarda body string gelebilir (text/plain)
    if (typeof params === 'string' && params.trim() !== '') {
      try {
        params = JSON.parse(params);
      } catch {
        // URL-encoded string geldiyse (olasılık düşük) onu da dene
        try {
          params = Object.fromEntries(new URLSearchParams(params));
        } catch {
          // Yine de parse edemediysek boş bırak
        }
      }
    }

    // 3) Zorunlular
    const required = ['shopId', 'event'];
    const missing = required.filter((k) => !params?.[k]);

    if (missing.length) {
      return res.status(400).json({
        ok: false,
        error: 'missing_params',
        required: missing,
      });
    }

    const { shopId, event } = params;
    const productHandle = params.productHandle ?? null;
    const buttonId = params.buttonId ?? null;

    let extra = null;
    if (params.extra != null) {
      extra =
        typeof params.extra === 'string'
          ? safeJsonParse(params.extra)
          : params.extra;
    }

    if (process.env.LOG_REQUESTS) {
      console.log(
        '[collect]',
        JSON.stringify({ method, shopId, event, productHandle, buttonId, extra })
      );
    }

    // Burada DB'ye yazma/queue'ya atma vb yapılabilir.
    // Bu demo için hızlı dönüyoruz.
    return res.status(204).end();
  } catch (err) {
    console.error('internal_error:', err);
    return res
      .status(500)
      .json({ ok: false, error: 'internal_error' });
  }
}

function safeJsonParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// --- Tüm rotaları bağla ---
// GET ve POST'u destekle
app.all(['/e', '/collect', '/api/collect'], handleCollect);

// (Opsiyonel) test-send.html ve statik dosyalar için -
// zip'te public klasörü yoktu, ama eklersen:
// app.use(express.static('collector'));

// Port/host
const PORT = process.env.PORT || 8080;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`Collector listening on http://localhost:${PORT}`);
});
