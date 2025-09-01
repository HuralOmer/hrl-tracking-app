// collector/migrate.js
require('dotenv').config();
const fs = require('fs/promises');
const path = require('path');
const { Pool } = require('pg');

(async () => {
  const envPath = process.env.MIGRATIONS_FILE;
  const candidates = [];

  if (envPath) {
    candidates.push(path.isAbsolute(envPath) ? envPath : path.resolve(__dirname, envPath));
  }
  candidates.push(
    path.resolve(__dirname, 'db/migrations.sql'),
    path.resolve(__dirname, '../db/migrations.sql')
  );

  let found;
  for (const p of candidates) {
    try { await fs.access(p); found = p; break; } catch {}
  }

  if (!found) {
    console.warn('Migration skipped: file not found. Tried:\n' + candidates.join('\n'));
    return;
  }

  console.log('Running migrations from:', found);
  const sql = await fs.readFile(found, 'utf8');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await pool.query(sql);
    console.log('Migrations completed ✅');
  } catch (err) {
    console.error('Migration error:', err.message);
  } finally {
    await pool.end();
  }
})();
