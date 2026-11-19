import { ApiError } from './errors';

export const MAX_AMOUNT = 1_000_000_000;
const USER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const INTEGER_LITERAL = /^-?\d+$/;

// JSON.parse turns `1.0` into the integer 1, so the literal text has to be checked.
const NON_INTEGER_LITERAL = Object.freeze({ nonInteger: true });

type ReviverContext = { source?: string };

function strictReviver(this: unknown, _key: string, value: unknown, context?: ReviverContext): unknown {
  if (typeof value === 'number' && context?.source !== undefined && !INTEGER_LITERAL.test(context.source)) {
    return NON_INTEGER_LITERAL;
  }
  return value;
}

export function parseJsonStrict(text: string): unknown {
  return JSON.parse(text, strictReviver as (key: string, value: unknown) => unknown);
}

export function assertReviverSourceSupported(): void {
  const parsed = parseJsonStrict('{"n":1.0}') as { n: unknown };
  if (parsed.n !== NON_INTEGER_LITERAL) {
    throw new Error('This Node.js runtime does not expose JSON source text; Node 22 or newer is required');
  }
}

export interface MutationInput {
  userId: string;
  amount: number;
}

export function isValidUserId(value: unknown): value is string {
  return typeof value === 'string' && USER_ID_PATTERN.test(value);
}

export function isValidAmount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= MAX_AMOUNT;
}

export function validateUserId(value: unknown): string {
  if (!isValidUserId(value)) {
    throw new ApiError(400, 'invalid_request', 'user_id must be 1-64 characters of A-Z, a-z, 0-9, _ or -');
  }
  return value;
}

export function parseMutationBody(body: unknown): MutationInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'invalid_request', 'Request body must be a JSON object');
  }
  const { user_id, amount } = body as Record<string, unknown>;

  if (user_id === undefined) throw new ApiError(400, 'invalid_request', 'user_id is required');
  const userId = validateUserId(user_id);

  if (amount === undefined) throw new ApiError(400, 'invalid_request', 'amount is required');
  if (!isValidAmount(amount)) {
    throw new ApiError(400, 'invalid_request', `amount must be an integer between 1 and ${MAX_AMOUNT}`);
  }

  return { userId, amount };
}
