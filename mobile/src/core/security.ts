import * as LocalAuthentication from "expo-local-authentication";
import { SecurityLevel } from "expo-local-authentication";
import type { IntegrityReport } from "@offline-pay/shared";
import { isClockSuspicious } from "./clock";
import { assertLedgerHealthy, ledgerService } from "./ledger";
import { keyService, type KeyState } from "./keys";
import { getIntegrityReport, isDevelopmentIntegrityOverrideActive, type CoreIntegrityReport } from "./integrity";

export type SecurityStatus = {
  biometricsEnrolled: boolean;
  authenticationEnrolled: boolean;
  integrity: CoreIntegrityReport & IntegrityReport;
  integrityScore: number;
  keyState: KeyState;
  ledgerOk: boolean;
  clockOk: boolean;
  offlineEnabled: boolean;
};

export async function getSecurityStatus(): Promise<SecurityStatus> {
  const [integrity, biometricsEnrolled, authLevel, keyState, chain, clockSuspicious] = await Promise.all([
    getIntegrityReport(),
    LocalAuthentication.isEnrolledAsync().catch(() => false),
    LocalAuthentication.getEnrolledLevelAsync().catch(() => SecurityLevel.NONE),
    keyService.getKeyState().catch(() => "UNINITIALIZED" as const),
    ledgerService.verifyChain().catch(() => ({ ok: false })),
    isClockSuspicious(),
  ]);
  const ledgerOk = chain.ok;
  const clockOk = !clockSuspicious;
  const integrityOk = (!integrity.rooted && integrity.isDevice && !integrity.debug) || isDevelopmentIntegrityOverrideActive();
  const offlineEnabled = biometricsEnrolled || authLevel !== SecurityLevel.NONE
    ? integrityOk && clockOk && ledgerOk && keyState === "READY"
    : false;
  return {
    biometricsEnrolled,
    authenticationEnrolled: authLevel !== SecurityLevel.NONE,
    integrity,
    integrityScore: integrity.score,
    keyState,
    ledgerOk,
    clockOk,
    offlineEnabled,
  };
}

export async function verifyLedgerForSecurityScreen(): Promise<{ ok: boolean; brokenAt?: bigint }> {
  const result = await ledgerService.verifyChain();
  if (!result.ok) {
    try {
      await assertLedgerHealthy();
    } catch {
      // Caller receives the explicit failure result for display.
    }
  }
  return result;
}
