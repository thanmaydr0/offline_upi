import { createApp } from "./app.js";
import { loadEnv } from "./env.js";
import type { OnrampService } from './services/onramp.js';

const env = loadEnv();
const app = createApp({ env });
const onrampService = app.locals.onrampService as OnrampService;
const reconciliationTimer = setInterval(() => { void onrampService.processPending(); }, 5000);
reconciliationTimer.unref();
app.listen(env.PORT, () => {
  process.stdout.write(`OfflinePay backend listening on port ${env.PORT}\n`);
});
