// stats-routes.js
const express = require('express');
const router = express.Router();
const { pool } = require('./db');

// Yardımcı: tarih parametrelerini al
function parseRange(q) {
  const from = q.from ? new Date(q.from) : new Date(Date.now() - 7*24*60*60*1000);
  const to   = q.to   ? new Date(q.to)   : new Date();
  return { from, to };
}

// Özet: views, avg_dwell_ms, clicks
router.get('/summary', async (req, res) => {
  try {
    const shopId = req.query.shopId;
    if (!shopId) return res.status(400).json({error:'shopId required'});
    const { from, to } = parseRange(req.query);

    const { rows } = await pool.query(
      `
      with
      views as (
        select count(*)::int as c
        from events
        where shop_id=$1 and event_name='page_view_start' and ts between $2 and $3
      ),
      dwell as (
        select avg((payload->>'dwell_ms')::numeric)::int as ms
        from events
        where shop_id=$1 and event_name='page_view_end' and ts between $2 and $3
      ),
      clicks as (
        select count(*)::int as c
        from events
        where shop_id=$1 and event_name='click' and ts between $2 and $3
      )
      select (select c from views) as views,
             (select ms from dwell) as avg_dwell_ms,
             (select c from clicks) as clicks
      `,
      [shopId, from, to]
    );

    res.json(rows[0] || {views:0, avg_dwell_ms:0, clicks:0});
  } catch (e) {
    console.error('summary error', e);
    res.status(500).json({error:'server_error'});
  }
});

// En çok tıklanan butonlar
router.get('/top-buttons', async (req, res) => {
  try {
    const shopId = req.query.shopId;
    if (!shopId) return res.status(400).json({error:'shopId required'});
    const { from, to } = parseRange(req.query);

    const { rows } = await pool.query(
      `
      select coalesce(payload->>'button_id','(unknown)') as button_id,
             count(*)::int as clicks
      from events
      where shop_id=$1 and event_name='click' and ts between $2 and $3
      group by 1
      order by clicks desc
      limit 20
      `,
      [shopId, from, to]
    );
    res.json(rows);
  } catch (e) {
    console.error('top-buttons error', e);
    res.status(500).json({error:'server_error'});
  }
});

// En çok görüntülenen ürün handle'ları
router.get('/top-products', async (req, res) => {
  try {
    const shopId = req.query.shopId;
    if (!shopId) return res.status(400).json({error:'shopId required'});
    const { from, to } = parseRange(req.query);

    const { rows } = await pool.query(
      `
      select coalesce(product_handle,'(NA)') as product_handle,
             count(*) filter (where event_name='page_view_start')::int as views,
             avg((payload->>'dwell_ms')::numeric) filter (where event_name='page_view_end')::int as avg_dwell_ms
      from events
      where shop_id=$1 and ts between $2 and $3
      group by 1
      order by views desc
      limit 20
      `,
      [shopId, from, to]
    );
    res.json(rows);
  } catch (e) {
    console.error('top-products error', e);
    res.status(500).json({error:'server_error'});
  }
});

module.exports = router;
