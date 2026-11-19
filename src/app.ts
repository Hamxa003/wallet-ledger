import Fastify, { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { registerAuth } from './auth';
import type { Config } from './config';
import { registerErrorHandling } from './errors';
import { assertReviverSourceSupported, parseJsonStrict } from './validation';

export interface AppDeps {
  config: Config;
  pool: Pool;
  logger?: boolean;
}

export function buildApp({ config, pool, logger = true }: AppDeps): FastifyInstance {
  assertReviverSourceSupported();

  const app = Fastify({
    logger: logger ? { level: process.env.LOG_LEVEL || 'warn', redact: ['req.headers.authorization'] } : false,
    bodyLimit: 16 * 1024,
  });

  registerErrorHandling(app);
  registerAuth(app, config.apiToken);

  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    try {
      done(null, parseJsonStrict(body as string));
    } catch {
      const err = new Error('Malformed JSON body') as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
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
