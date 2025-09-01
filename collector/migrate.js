// migrate.js
const fs = require('fs');
const path = require('path');
const { pool } = require('./db');

(async () => {
  try {
    const sql = fs.readFileSync(path.join(__dirname, '../db/migrations.sql'), 'utf8');
    await pool.query(sql);
    console.log('✅ Migrations completed');
  } catch (e) {
    console.error('Migration failed:', e.message);
  } finally {
    await pool.end();
  }
})();
