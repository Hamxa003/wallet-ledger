import type { FastifyError, FastifyInstance } from 'fastify';

export type ErrorCode =
  | 'invalid_request'
  | 'unauthorized'
  | 'user_not_found'
  | 'insufficient_funds'
  | 'not_found'
  | 'internal_error';

export class ApiError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function errorBody(code: ErrorCode, message: string) {
  return { error: code, message };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | ApiError, req, reply) => {
    if (err instanceof ApiError) {
      return reply.code(err.statusCode).send(errorBody(err.code, err.message));
    }

    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.code(400).send(errorBody('invalid_request', err.message || 'Invalid request'));
    }

    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send(errorBody('internal_error', 'Internal server error'));
  });

  app.setNotFoundHandler((_req, reply) => {
    return reply.code(404).send(errorBody('not_found', 'Route not found'));
  });
}
