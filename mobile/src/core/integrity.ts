import * as Device from "expo-device";
import * as LocalAuthentication from "expo-local-authentication";
import { SecurityLevel } from "expo-local-authentication";
import type { IntegrityReport } from "@offline-pay/shared";
import { isClockSuspicious } from "./clock";

export type CoreIntegrityReport = IntegrityReport & {
  debug: boolean;
  clockSuspicious: boolean;
  score: number;
};

let developmentOverride = false;

export class OfflineIntegrityError extends Error {
  readonly code = "OFFLINE_INTEGRITY_BLOCKED";

  constructor(message: string) {
    super(message);
    this.name = "OfflineIntegrityError";
  }
}

export async function hasDeviceAuthenticationEnrolled(): Promise<boolean> {
  try {
    // SecurityLevel.SECRET represents a PIN/pattern/passcode; biometric levels are also accepted.
    return (await LocalAuthentication.getEnrolledLevelAsync()) !== SecurityLevel.NONE;
  } catch {
    return false;
  }
}

export async function getIntegrityReport(): Promise<CoreIntegrityReport> {
  let rooted = true;
  try {
    rooted = await Device.isRootedExperimentalAsync();
  } catch {
    // Root detection is experimental. If it is unavailable, fail closed for offline use.
  }

  let isDevice = false;
  try {
    isDevice = Device.isDevice;
  } catch {
    // Missing device information is not treated as a real device.
  }

  const debug = __DEV__;
  const clockSuspicious = await isClockSuspicious();
  let score = 100;
  if (rooted) score -= 60;
  if (!isDevice) score -= 50;
  if (debug) score -= 15;
  if (clockSuspicious) score -= 25;

  return {
    rooted,
    isDevice,
    debug,
    clockSuspicious,
    score: Math.max(0, score),
  };
}

/** Development override exists only in a __DEV__ bundle and never bypasses the key/clock/ledger checks. */
export function setDevelopmentIntegrityOverride(enabled: boolean): void {
  if (!__DEV__) throw new Error("The integrity override is available only in development builds.");
  developmentOverride = enabled;
}

export function isDevelopmentIntegrityOverrideActive(): boolean {
  return developmentOverride && __DEV__;
}

export async function assertOfflineIntegrity(): Promise<CoreIntegrityReport> {
  const report = await getIntegrityReport();
  if (!(await hasDeviceAuthenticationEnrolled())) {
    throw new OfflineIntegrityError("Offline spending requires an enrolled biometric or device credential.");
  }
  if ((report.rooted || !report.isDevice) && !(developmentOverride && __DEV__)) {
    throw new OfflineIntegrityError(
      report.rooted ? "Offline spending is disabled on a rooted device." : "Offline spending requires a real device.",
    );
  }
  if (report.debug && !(developmentOverride && __DEV__)) {
    throw new OfflineIntegrityError("Offline spending is disabled in a debuggable build.");
  }
  if (report.clockSuspicious) {
    throw new OfflineIntegrityError("Offline spending is disabled until the device clock is verified online.");
  }
  return report;
}

export async function isDeviceCredentialEnrolled(): Promise<boolean> {
  return hasDeviceAuthenticationEnrolled();
}
