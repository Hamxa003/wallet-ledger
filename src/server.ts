import cluster from 'node:cluster';
import { buildApp } from './app';
import { Config, loadConfig } from './config';
import { createPool, waitForDatabase } from './db';
import { runMigrations } from './migrate';

async function migrate(config: Config): Promise<void> {
  const pool = createPool({ ...config, poolMax: 1 });
  try {
    await waitForDatabase(pool);
    const applied = await runMigrations(pool);
    if (applied.length > 0) console.log(`applied migrations: ${applied.join(', ')}`);
  } finally {
    await pool.end();
  }
}

async function startWorker(config: Config): Promise<void> {
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

function startPrimary(config: Config): void {
  let shuttingDown = false;

  for (let i = 0; i < config.workers; i++) cluster.fork();

  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) {
      if (Object.keys(cluster.workers ?? {}).length === 0) process.exit(0);
      return;
    }
    console.error(`worker ${worker.process.pid} exited (${signal ?? code}), restarting`);
    cluster.fork();
  });

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const worker of Object.values(cluster.workers ?? {})) worker?.process.kill('SIGTERM');
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (cluster.isWorker) return startWorker(config);

  await migrate(config);
  if (config.workers === 1) return startWorker(config);
  startPrimary(config);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
