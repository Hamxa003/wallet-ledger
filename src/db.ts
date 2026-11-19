import { Pool } from 'pg';
import type { Config } from './config';

export function createPool(config: Config): Pool {
  const pool = new Pool({
    connectionString: config.databaseUrl,
    max: config.poolMax,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  pool.on('error', (err) => {
    console.error('idle database client error', err.message);
  });
  return pool;
}

export async function waitForDatabase(pool: Pool, attempts = 30, delayMs = 1_000): Promise<void> {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (i === attempts) throw err;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
