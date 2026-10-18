import { Decoder, Encoder } from "cbor-x";
import { QR_FRAME_LIMIT, QR_PREFIX } from "./constants";

const encoder = new Encoder({ useRecords: false, variableMapSize: true });
const decoder = new Decoder({ useRecords: false, mapsAsObjects: true });

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error("Invalid base64url payload");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function encodePayload(value: unknown): string {
  return QR_PREFIX + toBase64Url(encoder.encode(value));
}

export function decodePayload<T>(encoded: string): T {
  if (!encoded.startsWith(QR_PREFIX)) throw new Error("Unsupported QR prefix");
  return decoder.decode(fromBase64Url(encoded.slice(QR_PREFIX.length))) as T;
}

export function splitFrames(encoded: string, chunkSize = QR_FRAME_LIMIT): string[] {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) throw new Error("chunkSize must be positive");
  const payload = encoded.startsWith(QR_PREFIX) ? encoded.slice(QR_PREFIX.length) : encoded;
  const complete = encoded.startsWith(QR_PREFIX) ? encoded : QR_PREFIX + encoded;
  if (complete.length <= chunkSize) return [complete];
  let count = 2;
  let capacity = chunkSize;
  while (true) {
    capacity = chunkSize - `${QR_PREFIX}${count}/${count}:`.length;
    if (capacity < 1) throw new Error("chunkSize is too small for frame headers");
    const nextCount = Math.ceil(payload.length / capacity);
    if (nextCount === count) break;
    count = nextCount;
  }
  const chunks: string[] = [];
  for (let i = 0; i < payload.length; i += capacity) chunks.push(payload.slice(i, i + capacity));
  return chunks.map((chunk, index) => `${QR_PREFIX}${index + 1}/${chunks.length}:${chunk}`);
}

export function reassembleFrames(frames: readonly string[]): string {
  if (frames.length === 0) throw new Error("No frames provided");
  if (frames[0]?.startsWith(QR_PREFIX) && !/^OPAY1:\d+\/\d+:/.test(frames[0])) {
    if (frames.length !== 1) throw new Error("Cannot mix complete payload and frames");
    return frames[0];
  }
  const parts = new Map<number, string>();
  let total: number | undefined;
  for (const frame of frames) {
    const match = /^OPAY1:(\d+)\/(\d+):([A-Za-z0-9_-]*)$/.exec(frame);
    if (!match) throw new Error("Invalid frame");
    const index = Number(match[1]);
    const count = Number(match[2]);
    if (count < 1 || index < 1 || index > count || (total !== undefined && total !== count)) throw new Error("Inconsistent frame set");
    total = count;
    const old = parts.get(index);
    if (old !== undefined && old !== match[3]) throw new Error("Conflicting duplicate frame");
    parts.set(index, match[3] ?? "");
  }
  if (total === undefined || parts.size !== total) throw new Error("Incomplete frame set");
  let payload = "";
  for (let index = 1; index <= total; index += 1) {
    const part = parts.get(index);
    if (part === undefined) throw new Error("Incomplete frame set");
    payload += part;
  }
  return QR_PREFIX + payload;
}
