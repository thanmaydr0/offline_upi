import { createApp } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
const app = createApp({ env });
app.listen(env.PORT, () => {
  process.stdout.write(`OfflinePay backend listening on port ${env.PORT}\n`);
});
