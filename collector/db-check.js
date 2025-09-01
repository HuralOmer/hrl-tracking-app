const { pool } = require('./db');

(async () => {
  try {
    const r = await pool.query('select now() as now');
    console.log('DB time:', r.rows[0].now);
  } catch (e) {
    console.error('db-check error:', e);
  } finally {
    await pool.end();
  }
})();
