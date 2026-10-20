import express, { type Request } from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";
import { createContext, type AppOptions } from "./context.js";
import { errorHandler } from "./http.js";
import { logger } from "./logger.js";
import { kycRoutes } from "./routes/kyc.js";
import { onrampRoutes } from "./routes/onramp.js";
import { publicRoutes } from "./routes/public.js";
import { walletRoutes } from "./routes/wallet.js";
import { NotConfigured } from "./chain/index.js";
import { OnrampService } from './services/onramp.js';
import { settleRoutes } from './routes/settle.js';
import { SettlementService } from './routes/settle-service.js';
import { settlementWalletRoutes } from './routes/settle-wallet.js';
import { ReconciliationJob } from './jobs/reconcile.js';

export function createAppRuntime(options: AppOptions) {
  const context = createContext(options);
  const app = express();
  // Render terminates HTTPS at its reverse proxy. Keep local deployments untrusted.
  app.set("trust proxy", context.env.TRUST_PROXY_HOPS);
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: { directives: {
    'upgrade-insecure-requests': context.env.FIAT_GATEWAY === 'mock' ? null : [],
  } } }));
  app.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false }));
  app.use(express.json({
    limit: "32kb",
    verify: (request: Request, _response, buffer) => { request.rawBody = Buffer.from(buffer); },
  }));
  app.use(express.urlencoded({ extended: false, limit: "8kb" }));
  app.use((request, response, next) => {
    const startedAt = process.hrtime.bigint();
    response.on("finish", () => {
      const elapsedMs = Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
      logger.info({ method: request.method, path: request.path, statusCode: response.statusCode, elapsedMs });
    });
    next();
  });

  app.get("/health", (_request, response) => response.json({ status: "ok" }));
  app.use(publicRoutes(context));
  app.use(kycRoutes(context));
  app.use(onrampRoutes(context));
  const onrampService = new OnrampService(context);
  app.locals.onrampService = onrampService;
  app.use(onrampService.routes());
  const service = new SettlementService(context);
  const job = new ReconciliationJob(context, service);
  app.use(settleRoutes(context, service));
  app.use(settlementWalletRoutes(context));
  app.use(walletRoutes(context));
  app.use((error: unknown, request: Request, response: express.Response, next: express.NextFunction) => {
    if (error instanceof NotConfigured) {
      response.status(503).json({ error: "NOT_CONFIGURED", message: error.message });
      return;
    }
    if (error instanceof SyntaxError && "status" in error && error.status === 400) {
      response.status(400).json({ error: "INVALID_JSON", message: "Request body must be valid JSON." });
      return;
    }
    if (response.headersSent) {
      next(error);
      return;
    }
    errorHandler(error, request, response, next);
  });
  return { app, context, service, job, onrampService };
}

export function createApp(options: AppOptions) {
  return createAppRuntime(options).app;
}
