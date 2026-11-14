import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "crypto";
import { promises as fs } from "fs";
import path from "path";
import type { Request, Response, NextFunction } from "express";
import { CONFIG } from "./config";

/**
 * Application-level encryption at rest (AES-256-GCM).
 * Every stored visitor record, face embedding, event record, and photo is encrypted
 * with DATA_ENCRYPTION_KEY before it is written to the service's data directory.
 * File layout: "AOI1" magic (4 bytes) | IV (12 bytes) | auth tag (16 bytes) | ciphertext.
 */
const MAGIC = Buffer.from("AOI1");

function key(): Buffer | null {
  const raw = CONFIG.DATA_ENCRYPTION_KEY;
  if (!raw) return null;
  // Accept base64 or hex; anything else is hashed to 32 bytes.
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  const b64 = Buffer.from(raw, "base64");
  if (b64.length === 32) return b64;
  return createHash("sha256").update(raw).digest();
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
  if (data.subarray(0, 4).equals(MAGIC)) {
    const k = key();
    if (!k) throw new Error("DATA_ENCRYPTION_KEY is required to read encrypted data.");
    const iv = data.subarray(4, 16);
    const tag = data.subarray(16, 32);
    const decipher = createDecipheriv("aes-256-gcm", k, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data.subarray(32)), decipher.final()]);
  }
  return data; // legacy plaintext file written before encryption was added; re-encrypted on next save
}

export async function writeEncrypted(file: string, plain: Buffer | string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, encrypt(Buffer.isBuffer(plain) ? plain : Buffer.from(plain, "utf8")), { mode: 0o600 });
  await fs.rename(tmp, file);
}

export async function readEncrypted(file: string): Promise<Buffer> {
  return decrypt(await fs.readFile(file));
}

// ---------------------------------------------------------------------------
// Audit log: append-only JSON lines of every administrative/API access event.
// ---------------------------------------------------------------------------
export async function audit(entry: Record<string, unknown>) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n";
  try {
    await fs.mkdir(path.dirname(CONFIG.AUDIT_LOG_PATH), { recursive: true });
    await fs.appendFile(CONFIG.AUDIT_LOG_PATH, line, { mode: 0o600 });
  } catch (err) {
    console.error("Unable to write audit log:", err);
  }
}

export function auditMiddleware(req: Request, res: Response, next: NextFunction) {
  if (req.path === "/health") return next();
  const started = Date.now();
  res.on("finish", () => {
    void audit({
      kind: "api_access",
      method: req.method,
      path: req.path,
      status: res.statusCode,
      actor: (res.locals.actor as string) ?? "anonymous",
      ip: req.ip,
      ms: Date.now() - started,
    });
  });
  next();
}

// ---------------------------------------------------------------------------
// Admin authentication: every API that reads or changes personal data requires
// the owner's ADMIN_TOKEN as "Authorization: Bearer <token>".
// ---------------------------------------------------------------------------
export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const expected = CONFIG.ADMIN_TOKEN;
  const header = req.header("authorization") ?? "";
  const supplied = header.replace(/^Bearer\s+/i, "").trim();
  if (!expected) {
    res.locals.actor = "denied:no-admin-token-configured";
    return res.status(503).json({ error: "ADMIN_TOKEN is not configured on the server" });
  }
  const a = createHash("sha256").update(supplied).digest();
  const b = createHash("sha256").update(expected).digest();
  if (!supplied || !timingSafeEqual(a, b)) {
    res.locals.actor = "denied:invalid-token";
    return res.status(401).json({ error: "Owner authentication required" });
  }
  res.locals.actor = "owner";
  next();
}
