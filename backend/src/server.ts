import { createAppRuntime } from "./app.js";
import { loadEnv } from "./env.js";
import { logger } from './logger.js';

const env = loadEnv();
const { app, context, job, onrampService } = createAppRuntime({ env });
const stopReconciliation = job.start();
const reconciliationTimer = setInterval(() => {
  void onrampService.processPending().catch(() => logger.error({ event: 'onramp_reconciliation_failed' }));
}, 5000);
reconciliationTimer.unref();
const server = app.listen(env.PORT, () => {
  process.stdout.write(`OfflinePay backend listening on port ${env.PORT}\n`);
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  if (stopping) return;
  stopping = true;
  clearInterval(reconciliationTimer);
  stopReconciliation();
  server.close(() => { context.db.close(); });
});
