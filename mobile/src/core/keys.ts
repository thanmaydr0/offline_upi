import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import type { Address, Hex, Payment } from "@offline-pay/shared";
import { PAYMENT_TYPES } from "@offline-pay/shared";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import { conservativeNowSeconds, isClockSuspicious } from "./clock";
import { readCachedServerConfig } from "./config";
import { assertLedgerHealthy } from "./ledger";
import { assertOfflineIntegrity, getIntegrityReport, hasDeviceAuthenticationEnrolled, type CoreIntegrityReport } from "./integrity";
import { parsePayment } from "./schema";
import type { KeyService as KeyServiceInterface } from "../services/types";

const PRIVATE_KEY_STORE = "offlinepay.device-private-key.v1";
const KEY_PRESENT_STORE = "offlinepay.device-key-present.v1";
const ADDRESS_STORE = "offlinepay.device-address.v1";
const AUTH_OPTIONS: SecureStore.SecureStoreOptions = {
  requireAuthentication: true,
  authenticationPrompt: "Authorize an offline payment",
};
const HEX_PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

export type KeyState = "UNINITIALIZED" | "READY" | "NOT_ENROLLED" | "KEY_INVALIDATED";

export class KeyServiceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "KeyServiceError";
  }
}

export class KeyInvalidatedError extends KeyServiceError {
  constructor() {
    super("KEY_INVALIDATED", "The device signing key was invalidated after a biometric or device security change. Re-enrollment is required.");
    this.name = "KeyInvalidatedError";
  }
}

const signingConfigSchema = z.object({
  chainId: z.number().int().positive().safe(),
  vaultAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform((address) => address as Address),
});

function toHex(bytes: Uint8Array): Hex {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}` as Hex;
}

function fromHex(hex: Hex): Uint8Array {
  const bytes = new Uint8Array((hex.length - 2) / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(2 + index * 2, 4 + index * 2), 16);
  }
  return bytes;
}

async function generateValidPrivateKey(): Promise<{ hex: Hex; address: Address }> {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const randomBytes = await Crypto.getRandomBytesAsync(32);
    const hex = toHex(randomBytes);
    try {
      const address = privateKeyToAccount(hex).address;
      return { hex, address };
    } catch {
      // A uniformly random scalar can very rarely be outside secp256k1's valid range; retry.
    } finally {
      randomBytes.fill(0);
    }
  }
  throw new Error("Secure randomness did not produce a valid secp256k1 private key.");
}

function isInvalidationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /invalidat|biometric.*changed|authentication.*key/i.test(message);
}

export class DeviceKeyService implements KeyServiceInterface {
  private state: KeyState = "UNINITIALIZED";

  async init(): Promise<{ address: Address }> {
    if (this.state === "KEY_INVALIDATED") throw new KeyInvalidatedError();

    const present = await SecureStore.getItemAsync(KEY_PRESENT_STORE);
    if (present === "invalidated") {
      this.state = "KEY_INVALIDATED";
      throw new KeyInvalidatedError();
    }
    if (!(await hasDeviceAuthenticationEnrolled())) {
      if (present === "1") {
        await this.setInvalidated();
        throw new KeyInvalidatedError();
      }
      this.state = "NOT_ENROLLED";
      throw new KeyServiceError("AUTH_NOT_ENROLLED", "Enroll a biometric or device credential before enabling offline mode.");
    }

    if (present === "1") {
      const address = await SecureStore.getItemAsync(ADDRESS_STORE);
      if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        await this.setInvalidated();
        throw new KeyInvalidatedError();
      }
      this.state = "READY";
      return { address: address as Address };
    }

    const generated = await generateValidPrivateKey();
    try {
      // Expo SecureStore protects it at rest with Android Keystore-backed encryption or the iOS Keychain
      // and requires OS authentication to retrieve it. This is not a StrongBox/hardware secp256k1 key:
      // the scalar is copied into JavaScript memory to sign.
      await SecureStore.setItemAsync(PRIVATE_KEY_STORE, generated.hex, AUTH_OPTIONS);
      await SecureStore.setItemAsync(ADDRESS_STORE, generated.address, { requireAuthentication: false });
      await SecureStore.setItemAsync(KEY_PRESENT_STORE, "1", { requireAuthentication: false });
      this.state = "READY";
      return { address: generated.address };
    } catch (error) {
      this.state = isInvalidationError(error) ? "KEY_INVALIDATED" : "UNINITIALIZED";
      if (this.state === "KEY_INVALIDATED") throw new KeyInvalidatedError();
      throw error;
    }
  }

  async getAddress(): Promise<Address> {
    if (this.state === "KEY_INVALIDATED") throw new KeyInvalidatedError();
    const address = await SecureStore.getItemAsync(ADDRESS_STORE);
    if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
      throw new KeyServiceError("KEY_NOT_INITIALIZED", "Initialize the device signing key before requesting its address.");
    }
    return address as Address;
  }

  async getKeyState(): Promise<KeyState> {
    if (this.state === "KEY_INVALIDATED" || this.state === "NOT_ENROLLED") return this.state;
    if (this.state === "READY") return this.state;
    try {
      const marker = await SecureStore.getItemAsync(KEY_PRESENT_STORE);
      if (marker === "invalidated") return "KEY_INVALIDATED";
      return marker === "1" ? "READY" : "UNINITIALIZED";
    } catch {
      return "UNINITIALIZED";
    }
  }

  async signPayments(payments: Payment[], reason: string): Promise<Hex[]> {
    if (payments.length === 0) return [];
    const { address } = await this.init();
    await assertOfflineIntegrity();
    await assertLedgerHealthy();
    if (await isClockSuspicious()) {
      throw new KeyServiceError("CLOCK_SUSPICIOUS", "Payment signing is disabled until the device clock is verified online.");
    }

    const parsedPayments = payments.map((payment) => parsePayment(payment));
    const now = await conservativeNowSeconds();
    for (const payment of parsedPayments) {
      if (payment.device.toLowerCase() !== address.toLowerCase()) {
        throw new KeyServiceError("DEVICE_MISMATCH", "A payment does not belong to this device key.");
      }
      if (payment.deadline <= now) {
        throw new KeyServiceError("PAYMENT_EXPIRED", "A payment deadline has passed according to verified device time.");
      }
    }

    let encodedKey: string | null;
    try {
      // This single protected-item read is the sole auth operation for the whole batch.
      encodedKey = await SecureStore.getItemAsync(PRIVATE_KEY_STORE, {
        ...AUTH_OPTIONS,
        authenticationPrompt: reason.trim() || "Authorize an offline payment",
      });
    } catch (error) {
      if (isInvalidationError(error)) {
        await this.setInvalidated();
        throw new KeyInvalidatedError();
      }
      throw new KeyServiceError("AUTHENTICATION_REQUIRED", "Device authentication did not authorize this signing batch.");
    }

    if (encodedKey === null) {
      await this.setInvalidated();
      throw new KeyInvalidatedError();
    }
    if (!HEX_PRIVATE_KEY.test(encodedKey)) {
      await this.setInvalidated();
      throw new KeyInvalidatedError();
    }

    const keyBuffer = fromHex(encodedKey as Hex);
    // SecureStore returns a JS string and viem creates its own account copy. Filling this buffer is
    // best effort only; JavaScript strings, native copies, and garbage-collected objects cannot be erased reliably.
    encodedKey = null;
    try {
      const account = privateKeyToAccount(toHex(keyBuffer));
      if (account.address.toLowerCase() !== address.toLowerCase()) {
        await this.setInvalidated();
        throw new KeyInvalidatedError();
      }
      const rawConfig = await readCachedServerConfig();
      if (rawConfig === null) throw new KeyServiceError("CONFIG_REQUIRED", "Sync server configuration before signing payments.");
      const { chainId, vaultAddress } = signingConfigSchema.parse(rawConfig);
      const signatures: Hex[] = [];
      for (const payment of parsedPayments) {
        signatures.push(await account.signTypedData({
          domain: { name: "OfflineVault", version: "1", chainId, verifyingContract: vaultAddress },
          types: PAYMENT_TYPES,
          primaryType: "Payment",
          message: payment,
        }));
      }
      return signatures;
    } finally {
      keyBuffer.fill(0);
    }
  }

  private async setInvalidated(): Promise<void> {
    this.state = "KEY_INVALIDATED";
    try {
      await SecureStore.setItemAsync(KEY_PRESENT_STORE, "invalidated", { requireAuthentication: false });
    } catch {
      // The in-memory state remains invalidated even if the diagnostic marker cannot be persisted.
    }
  }

  async integrity(): Promise<CoreIntegrityReport> {
    return getIntegrityReport();
  }
}

export const keyService = new DeviceKeyService();
