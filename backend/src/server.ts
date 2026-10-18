import { app } from "./app.js";
import { loadEnv } from "./env.js";

const env = loadEnv();
app.listen(env.PORT, () => {
  process.stdout.write(`OfflinePay backend listening on port ${env.PORT}\n`);
});
