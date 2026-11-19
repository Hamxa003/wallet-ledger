import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { errorBody } from './errors';

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const space = header.indexOf(' ');
  if (space === -1) return null;
  const scheme = header.slice(0, space);
  const token = header.slice(space + 1).trim();
  if (scheme.toLowerCase() !== 'bearer' || token.length === 0) return null;
  return token;
}

export function registerAuth(app: FastifyInstance, apiToken: string): void {
  const expected = digest(apiToken);

  app.addHook('onRequest', async (req, reply) => {
    const token = extractBearerToken(req.headers.authorization);
    if (token === null || !timingSafeEqual(digest(token), expected)) {
      return reply.code(401).send(errorBody('unauthorized', 'Missing or invalid bearer token'));
    }
  });
}
