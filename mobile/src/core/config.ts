import { z } from "zod";
import { withCoreDatabase } from "./database";
import { parseJson, stringifyJson } from "./schema";

export const DEFAULT_MAX_SINGLE_OFFLINE_PAYMENT_PAISE = 200_000;
export const DEFAULT_MAX_OFFLINE_SPEND_24H_PAISE = 500_000;

const integerLimitSchema = z.number().int().positive().safe();
const cachedConfigSchema = z.object({
  limits: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

export type OfflineLimits = {
  maxSinglePaymentPaise: number;
  maxSpend24hPaise: number;
};

export async function readCachedServerConfig(): Promise<unknown | null> {
  return withCoreDatabase(async (database) => {
    const row = await database.getFirstAsync<{ value: string }>(
      "SELECT value FROM core_meta WHERE key = ?",
      "server_config",
    );
    if (!row) return null;
    return parseJson<unknown>(row.value);
  });
}

function firstLimit(config: Record<string, unknown>, keys: string[], fallback: number): number {
  for (const key of keys) {
    if (key in config) return integerLimitSchema.parse(config[key]);
  }
  return fallback;
}

export async function getOfflineLimits(): Promise<OfflineLimits> {
  const cached = await readCachedServerConfig();
  if (cached === null) {
    return {
      maxSinglePaymentPaise: DEFAULT_MAX_SINGLE_OFFLINE_PAYMENT_PAISE,
      maxSpend24hPaise: DEFAULT_MAX_OFFLINE_SPEND_24H_PAISE,
    };
  }

  const parsed = cachedConfigSchema.parse(cached);
  const source = parsed.limits ?? {};
  return {
    maxSinglePaymentPaise: firstLimit(source, [
      "MAX_SINGLE_OFFLINE_PAYMENT_PAISE",
      "maxSingleOfflinePaymentPaise",
      "maxSinglePaymentPaise",
    ], DEFAULT_MAX_SINGLE_OFFLINE_PAYMENT_PAISE),
    maxSpend24hPaise: firstLimit(source, [
      "MAX_OFFLINE_SPEND_24H_PAISE",
      "maxOfflineSpend24hPaise",
      "maxSpend24hPaise",
    ], DEFAULT_MAX_OFFLINE_SPEND_24H_PAISE),
  };
}

/** Test helper for injected config values without calling the network layer. */
export async function writeCachedConfigForTests(config: unknown): Promise<void> {
  await withCoreDatabase(async (database) => {
    await database.runAsync(
      "INSERT INTO core_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      "server_config",
      stringifyJson(config),
    );
  });
}
