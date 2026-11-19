import Fastify, { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import type { Config } from './config';

export interface AppDeps {
  config: Config;
  pool: Pool;
  logger?: boolean;
}

export function buildApp({ pool, logger = true }: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: logger ? { level: process.env.LOG_LEVEL || 'warn', redact: ['req.headers.authorization'] } : false,
  });

  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      return reply.code(503).send({ status: 'unavailable' });
    }
  });

  return app;
}
