import { Pool } from 'pg';
import { waitForDatabase } from './db';
import { runMigrations } from './migrate';

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Missing required environment variable DATABASE_URL');

  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    await waitForDatabase(pool);
    const applied = await runMigrations(pool);
    console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'Schema is up to date');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
