import { createApp } from '../src/app.js';
import { createContext } from '../src/context.js';
import { createDatabase } from '../src/db/database.js';
import type { BackendEnv } from '../src/env.js';
import { RealChain } from '../src/chain/real/index.js';
import { settleRoutes } from '../src/routes/settle.js';
import { SettlementService } from '../src/routes/settle-service.js';
import { ReconciliationJob } from '../src/jobs/reconcile.js';
import { errorHandler } from '../src/http.js';
import express, { type Request, type Response, type NextFunction } from 'express';
import { logger } from '../src/logger.js';
import { settlementWalletRoutes } from '../src/routes/settle-wallet.js';

/** Owned-path entry point until P2 mounts the same modules in the standard app. */
export function createSettlementApp(env: BackendEnv) {
  const db = createDatabase(env.DB_PATH);
  const chain = env.CHAIN_MODE === 'chain' ? new RealChain(env, db) : undefined;
  const context = createContext({ env, db, chain });
  const service = new SettlementService(context);
  const base = createApp({ env, db, chain: context.chain, gateway: context.gateway });
  base.use(settleRoutes(context, service));
  base.use((error: unknown, _request: Request, _response: Response, next: NextFunction) => {
    logger.error({ event: 'settlement_error', error: error instanceof Error ? error.name : 'unknown', message: error && typeof error === 'object' && 'shortMessage' in error ? String(error.shortMessage) : undefined });
    next(error);
  });
  base.use(errorHandler);
  const app = express();
  app.use(settlementWalletRoutes(context));
  app.use(base);
  app.use(errorHandler);
  const job = new ReconciliationJob(context, service);
  return { app, context, service, job };
}
