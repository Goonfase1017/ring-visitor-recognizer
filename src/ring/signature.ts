import { createHmac, timingSafeEqual } from "crypto";

/**
 * Webhook signature: header `X-Signature: sha256=<hex HMAC-SHA256(key, raw body)>`.
 * Must be computed over the raw request bytes, before JSON parsing.
 */
export function signBody(rawBody: Buffer, key: string): string {
  return `sha256=${createHmac("sha256", Buffer.from(key, "utf8")).update(rawBody).digest("hex")}`;
}

export function verifyWebhookSignature(rawBody: Buffer, header: string | undefined, key: string): boolean {
  if (!header || !key) return false;
  const received = header.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(received)) return false;
  const expected = createHmac("sha256", Buffer.from(key, "utf8")).update(rawBody).digest();
  return timingSafeEqual(expected, Buffer.from(received, "hex"));
}
