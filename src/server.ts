import { buildApp } from './app';
import { loadConfig } from './config';
import { createPool, waitForDatabase } from './db';

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool(config);
  await waitForDatabase(pool);

  const app = buildApp({ config, pool });

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
