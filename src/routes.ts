import type { FastifyInstance } from 'fastify';
import type { LedgerService } from './ledger';
import { parseMutationBody, validateUserId } from './validation';

export function registerLedgerRoutes(app: FastifyInstance, ledger: LedgerService): void {
  app.post('/credit', async (req) => {
    const { userId, amount } = parseMutationBody(req.body);
    const balance = await ledger.credit(userId, amount);
    return { user_id: userId, balance };
  });

  app.post('/debit', async (req) => {
    const { userId, amount } = parseMutationBody(req.body);
    const balance = await ledger.debit(userId, amount);
    return { user_id: userId, balance };
  });

  app.get<{ Params: { user_id: string } }>('/balance/:user_id', async (req) => {
    const userId = validateUserId(req.params.user_id);
    const balance = await ledger.getBalance(userId);
    return { user_id: userId, balance };
  });
}
