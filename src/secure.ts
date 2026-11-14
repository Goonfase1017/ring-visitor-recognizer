import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from "crypto";
import { promisify } from "util";
import { CONFIG } from "./config";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

/**
 * Application-level encryption at rest (AES-256-GCM) with DATA_ENCRYPTION_KEY.
 * Layout: "AOI1" magic (4 bytes) | IV (12 bytes) | auth tag (16 bytes) | ciphertext.
 */
const MAGIC = Buffer.from("AOI1");

let cachedKey: { raw: string; key: Buffer } | null = null;
function key(): Buffer | null {
  const raw = process.env.DATA_ENCRYPTION_KEY ?? CONFIG.DATA_ENCRYPTION_KEY;
  if (!raw) return null;
  if (cachedKey && cachedKey.raw === raw) return cachedKey.key;
  let k: Buffer;
  if (/^[a-f0-9]{64}$/i.test(raw)) k = Buffer.from(raw, "hex");
  else {
    const b64 = Buffer.from(raw, "base64");
    k = b64.length === 32 ? b64 : createHash("sha256").update(raw).digest();
  }
  cachedKey = { raw, key: k };
  return k;
}

export function encryptionEnabled(): boolean {
  return key() !== null;
}

export function encrypt(plain: Buffer): Buffer {
  const k = key();
  if (!k) throw new Error("DATA_ENCRYPTION_KEY is not configured; refusing to store personal data unencrypted.");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", k, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decrypt(data: Buffer): Buffer {
  if (!data.subarray(0, 4).equals(MAGIC)) throw new Error("Data is not in the encrypted format");
  const k = key();
  if (!k) throw new Error("DATA_ENCRYPTION_KEY is required to read encrypted data.");
  const decipher = createDecipheriv("aes-256-gcm", k, data.subarray(4, 16));
  decipher.setAuthTag(data.subarray(16, 32));
  return Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]);
}

export const encryptJson = (value: unknown): Buffer => encrypt(Buffer.from(JSON.stringify(value), "utf8"));
export const decryptJson = <T>(data: Buffer): T => JSON.parse(decrypt(data).toString("utf8")) as T;

/** Sub-key derived from the master key for a given purpose (blind indexes, hardware ids). */
function derived(purpose: string): Buffer {
  const k = key() ?? Buffer.from(CONFIG.RING_HMAC_SIGNATURE_KEY || "visitor-recognizer-dev");
  return createHmac("sha256", k).update(`vr:${purpose}`).digest();
}

/** Deterministic keyed lookup value, so emails can be found without storing them in clear text. */
export function blindIndex(value: string): string {
  return createHmac("sha256", derived("blind-index")).update(value).digest("hex");
}

/**
 * Stable UUID for Ring's required Hardware_Id header: one per Ring account (user + this system),
 * or one install-level id before the Ring Account ID is known (code exchange and /v1/users/me).
 */
export function hardwareId(ringAccountId?: string): string {
  const h = createHmac("sha256", derived("hardware-id")).update(ringAccountId ?? "install").digest();
  h[6] = (h[6] & 0x0f) | 0x50; // version 5 (name based)
  h[8] = (h[8] & 0x3f) | 0x80; // RFC 4122 variant
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString("base64url");
export const sha256Hex = (s: string): string => createHash("sha256").update(s).digest("hex");

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) {
    timingSafeEqual(x, x); // keep timing roughly uniform
    return false;
  }
  return timingSafeEqual(x, y);
}

// ---------------------------------------------------------------------------
// Passwords: scrypt (N=2^15, r=8, p=1), 16-byte salt, 64-byte hash.
// ---------------------------------------------------------------------------
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${hash.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, "base64");
  const actual = await scrypt(password, Buffer.from(saltB64, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** u***r@example.com — the form Ring shows the customer as the linked partner account. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return "***";
  const masked = local.length <= 2 ? `${local[0] ?? ""}***` : `${local[0]}***${local[local.length - 1]}`;
  return `${masked}@${domain}`;
}

export function escapeHtml(s: unknown): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string
  );
}
