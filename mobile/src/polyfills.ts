import "fast-text-encoding";
import { Buffer } from "buffer";
import { getRandomValues } from "expo-crypto";

declare global {
  var Buffer: typeof import("buffer").Buffer;
}

if (typeof globalThis.Buffer === "undefined") globalThis.Buffer = Buffer;

if (typeof globalThis.crypto === "undefined") {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues },
  });
} else if (!globalThis.crypto.getRandomValues) {
  Object.defineProperty(globalThis.crypto, "getRandomValues", { configurable: true, value: getRandomValues });
}
