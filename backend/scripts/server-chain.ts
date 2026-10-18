import { loadEnv } from '../src/env.js';
import { createSettlementApp } from './runtime.js';

const runtime = createSettlementApp(loadEnv());
const stop = runtime.job.start();
const server = runtime.app.listen(runtime.context.env.PORT, () => console.log(`Settlement backend listening on ${runtime.context.env.PORT}`));
for (const signal of ['SIGTERM', 'SIGINT'] as const) process.once(signal, () => { stop(); server.close(() => { runtime.context.db.close(); process.exit(0); }); });
