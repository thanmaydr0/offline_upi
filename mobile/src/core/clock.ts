import * as Device from "expo-device";
import * as SecureStore from "expo-secure-store";
import { CLOCK_SKEW_SECONDS } from "@offline-pay/shared";
import { z } from "zod";
import { withCoreDatabase } from "./database";
import { configInputSchema, stringifyJson } from "./schema";

const CLOCK_STATE_KEY = "offlinepay.clock-state.v1";
const CLOCK_SKEW_MS = Number(CLOCK_SKEW_SECONDS) * 1000;

const clockStateSchema = z.object({
  lastServerTimeMs: z.number().int().safe(),
  lastServerLocalMs: z.number().int().safe(),
  lastServerUptimeMs: z.number().nonnegative().finite(),
  lastSeenLocalTimestampMs: z.number().int().safe(),
  suspicious: z.boolean(),
});

type ClockState = z.infer<typeof clockStateSchema>;

function serverTimeToMs(serverTime: string | number): number {
  const milliseconds = typeof serverTime === "number"
    ? (serverTime < 1_000_000_000_000 ? serverTime * 1000 : serverTime)
    : Date.parse(serverTime);
  if (!Number.isSafeInteger(Math.trunc(milliseconds)) || milliseconds <= 0) {
    throw new Error("The server returned an invalid serverTime.");
  }
  return Math.trunc(milliseconds);
}

async function loadState(): Promise<ClockState | null> {
  const encoded = await SecureStore.getItemAsync(CLOCK_STATE_KEY);
  if (encoded === null) return null;
  const parsed: unknown = JSON.parse(encoded);
  return clockStateSchema.parse(parsed);
}

async function saveState(state: ClockState): Promise<void> {
  await SecureStore.setItemAsync(CLOCK_STATE_KEY, JSON.stringify(state), { requireAuthentication: false });
}

/** Record the server's UTC timestamp and current local/uptime baselines after a validated config response. */
export async function recordServerTime(serverTime: string | number): Promise<void> {
  const serverTimeMs = serverTimeToMs(serverTime);
  const localNow = Date.now();
  const uptimeNow = await Device.getUptimeAsync();
  const state: ClockState = {
    lastServerTimeMs: serverTimeMs,
    lastServerLocalMs: localNow,
    lastServerUptimeMs: uptimeNow,
    lastSeenLocalTimestampMs: localNow,
    // A large offset at the time of sync is still suspicious: time-zone changes do not alter UTC epoch time.
    suspicious: Math.abs(localNow - serverTimeMs) > CLOCK_SKEW_MS,
  };
  await saveState(state);
}

/**
 * Best-effort clock tamper check. Expo exposes device uptime, not a secure monotonic counter;
 * a reboot therefore fails closed until another trusted server time is recorded.
 */
export async function isClockSuspicious(): Promise<boolean> {
  try {
    const state = await loadState();
    if (!state) return true;

    const localNow = Date.now();
    const uptimeNow = await Device.getUptimeAsync();
    const movedBackwards = localNow < state.lastSeenLocalTimestampMs;
    const uptimeReset = uptimeNow < state.lastServerUptimeMs;
    const expectedLocalNow = state.lastServerLocalMs + (uptimeNow - state.lastServerUptimeMs);
    const drifted = Math.abs(localNow - expectedLocalNow) > CLOCK_SKEW_MS;
    const suspicious = state.suspicious || movedBackwards || uptimeReset || drifted;
    const nextState: ClockState = {
      ...state,
      lastSeenLocalTimestampMs: Math.max(state.lastSeenLocalTimestampMs, localNow),
      suspicious,
    };
    if (nextState.lastSeenLocalTimestampMs !== state.lastSeenLocalTimestampMs || suspicious !== state.suspicious) {
      await saveState(nextState);
    }
    return suspicious;
  } catch {
    // Missing state, malformed state, or unavailable native uptime all disable offline spending.
    return true;
  }
}

/** Server anchored time used for expiry/deadline checks; callers must separately reject suspicious clocks. */
export async function conservativeNowMs(): Promise<number> {
  try {
    const state = await loadState();
    if (!state) return Date.now();
    const uptimeNow = await Device.getUptimeAsync();
    if (uptimeNow < state.lastServerUptimeMs) return Math.max(state.lastServerTimeMs, state.lastSeenLocalTimestampMs);
    const serverDerivedNow = state.lastServerTimeMs + (uptimeNow - state.lastServerUptimeMs);
    return Math.max(serverDerivedNow, state.lastSeenLocalTimestampMs);
  } catch {
    return Date.now();
  }
}

export async function conservativeNowSeconds(): Promise<bigint> {
  return BigInt(Math.floor((await conservativeNowMs()) / 1000));
}

/** Cache validated /v1/config data and its server clock baseline for offline services. */
export async function cacheServerConfig(config: unknown): Promise<void> {
  const parsed = configInputSchema.parse(config);
  await withCoreDatabase(async (database) => {
    await database.runAsync(
      "INSERT INTO core_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      "server_config",
      stringifyJson(parsed),
    );
  });
  await recordServerTime(parsed.serverTime);
}
