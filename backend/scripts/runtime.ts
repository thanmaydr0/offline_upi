import { createAppRuntime } from '../src/app.js';
import type { BackendEnv } from '../src/env.js';

/** Demo scripts and integration tests use the same routes as the normal server. */
export function createSettlementApp(env: BackendEnv) {
  return createAppRuntime({ env });
}
