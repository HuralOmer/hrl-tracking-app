// server.js (DB'ye yazan + insert log'lu)
const express = require('express');
const cors = require('cors');
const UAParser = require('ua-parser-js');
require('dotenv').config();
const { pool } = require('./db');

const app = express();
const statsRoutes = require('./stats-routes'); 


// CORS (dev için açık; prod'da domain ile kısıtlayacağız)
const allowed = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowed.includes('*') || allowed.includes(origin)) return cb(null, true);
    return cb(new Error('Origin not allowed by CORS'));
  }
}));

app.use(express.json({ limit: '64kb' }));
app.get('/health', (req, res) => res.status(200).send('ok'));
app.use('/stats', statsRoutes); 

const ALLOWED_EVENTS = new Set(['page_view_start', 'page_view_end', 'click']);

app.post('/e', async (req, res) => {
  try {
    const { ts, shopId, event, url, referrer, ua, productHandle, data } = req.body || {};
    if (!shopId || !event || !ts) return res.status(400).json({ error: 'Missing ts/shopId/event' });
    if (!ALLOWED_EVENTS.has(event)) return res.status(400).json({ error: 'Unknown event' });

    // IP'yi kaydetmiyoruz; header ile şehir/ülke gelebilir
    const region_city = req.headers['x-geo-city'] || null;
    const region_country = req.headers['x-geo-country'] || null;

    // UA parse
    const parsed = new UAParser(ua || '').getResult();
    const device = parsed.device?.model || parsed.device?.type || 'unknown';
    const os = parsed.os?.name ? `${parsed.os.name} ${parsed.os.version || ''}`.trim() : 'unknown';
    const browser = parsed.browser?.name ? `${parsed.browser.name} ${parsed.browser.version || ''}`.trim() : 'unknown';

    const { rows } = await pool.query(
      `insert into events
       (ts, shop_id, event_name, url, referrer, ua, device, os, browser,
        region_country, region_city, product_handle, payload)
       values (to_timestamp($1/1000.0), $2, $3, $4, $5, $6, $7, $8, $9,
               $10, $11, $12, $13)
       returning id`,
      [ts, shopId, event, url, referrer, ua || '', device, os, browser,
       region_country, region_city, productHandle || null, data || {}]
    );

    console.log('✅ saved event', { id: rows[0].id, shopId, event });
    return res.status(204).end();
  } catch (err) {
    console.error('collector error:', err);
    return res.status(500).json({ error: 'server_error' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Collector listening on http://localhost:${PORT}`));
