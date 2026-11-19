import { buildApp } from './app';
import { loadConfig } from './config';
import { createPool, waitForDatabase } from './db';
import { runMigrations } from './migrate';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  await waitForDatabase(pool);

  const app = buildApp({ config, pool });

  const applied = await runMigrations(pool);
  if (applied.length > 0) {
    app.log.warn({ applied }, 'applied migrations');
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    try {
      await app.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      app.log.error(err, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
