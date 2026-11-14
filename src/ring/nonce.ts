import { createHmac, timingSafeEqual } from "crypto";

export const NONCE_WINDOW_SECONDS = 600;

/**
 * Ring account-linking nonce: HMAC-SHA256(K_hmac, "<time>:<account_id>"), URL-safe Base64 without
 * padding (RFC 4648 §5). The key is used as its UTF-8 bytes, exactly as in Ring's reference code.
 */
export function computeNonce(time: string, accountId: string, hmacKey: string): string {
  return createHmac("sha256", Buffer.from(hmacKey, "utf8")).update(`${time}:${accountId}`, "utf8").digest("base64url");
}

export function nonceMatches(received: string, time: string, accountId: string, hmacKey: string): boolean {
  const expected = Buffer.from(computeNonce(time, accountId, hmacKey), "utf8");
  const got = Buffer.from(received, "utf8");
  if (expected.length !== got.length) return false;
  return timingSafeEqual(expected, got);
}

export type FreshnessResult = { ok: true; timeMs: number } | { ok: false; reason: "invalid" | "expired" | "future" };

/** `time` is Unix epoch milliseconds. Reject anything older than 600 s or in the future. */
export function checkLinkTime(time: unknown, now = Date.now()): FreshnessResult {
  if (typeof time !== "string" || !/^\d{10,16}$/.test(time)) return { ok: false, reason: "invalid" };
  const timeMs = Number(time);
  const deltaSeconds = (now - timeMs) / 1000;
  if (deltaSeconds < 0) return { ok: false, reason: "future" };
  if (deltaSeconds > NONCE_WINDOW_SECONDS) return { ok: false, reason: "expired" };
  return { ok: true, timeMs };
}

export const isWellFormedNonce = (n: unknown): n is string => typeof n === "string" && /^[A-Za-z0-9_-]{32,128}$/.test(n);
