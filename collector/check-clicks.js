// check-clicks.js
const { pool } = require('./db');

(async () => {
  try {
    const shop = 'dev-shop.myshopify.com';
    const { rows } = await pool.query(
      `select count(*)::int as clicks
         from events
        where shop_id = $1
          and event_name = 'click'
          and ts >= date_trunc('day', now())   -- bugün 00:00
          and ts <  date_trunc('day', now()) + interval '1 day'`,
      [shop]
    );
    console.log('today clicks =', rows[0].clicks);
  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
})();
