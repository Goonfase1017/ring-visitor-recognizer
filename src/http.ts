import type { NextFunction, Request, Response } from "express";
import { CONFIG } from "./config";
import { randomToken, safeEqual } from "./secure";

export const SESSION_COOKIE = "vr_session";
export const CSRF_COOKIE = "vr_csrf";

export function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch { /* ignore malformed */ }
  }
  return out;
}

export function setCookie(req: Request, res: Response, name: string, value: string, maxAgeSeconds?: number) {
  const parts = [`${name}=${encodeURIComponent(value)}`, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (req.secure || CONFIG.IS_PRODUCTION) parts.push("Secure");
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(maxAgeSeconds)}`);
  res.append("Set-Cookie", parts.join("; "));
}

export const clearCookie = (req: Request, res: Response, name: string) => setCookie(req, res, name, "", 0);

/** Double-submit CSRF token for HTML forms (pre-login and logged-in). */
export function formCsrf(req: Request, res: Response): string {
  const existing = parseCookies(req)[CSRF_COOKIE];
  if (existing && /^[A-Za-z0-9_-]{30,}$/.test(existing)) return existing;
  const token = randomToken(24);
  setCookie(req, res, CSRF_COOKIE, token, 7200);
  return token;
}

export function checkFormCsrf(req: Request): boolean {
  const cookie = parseCookies(req)[CSRF_COOKIE];
  const field = typeof req.body?._csrf === "string" ? req.body._csrf : "";
  return Boolean(cookie && field && safeEqual(cookie, field)) && sameOrigin(req);
}

/**
 * If the browser sent a real Origin, it must be this site. Absent or "null" Origin (privacy settings,
 * in-app browsers) is allowed; the CSRF token is the primary protection.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.header("origin");
  if (!origin || origin === "null") return true;
  try {
    const o = new URL(origin);
    if (o.origin === new URL(CONFIG.PUBLIC_APP_URL).origin) return true;
    return o.host === req.get("host");
  } catch {
    return false;
  }
}

/** Fixed-window in-memory rate limiter (single instance). */
export class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private max: number, private windowMs: number) {}
  take(key: string): boolean {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      if (this.hits.size > 50_000) for (const [k, v] of this.hits) if (v.reset < now) this.hits.delete(k);
      return true;
    }
    h.n++;
    return h.n <= this.max;
  }
  reset(key: string) {
    this.hits.delete(key);
  }
}

export function securityHeaders(req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin"); // the link page URL carries a nonce: never send it to other sites
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'"
  );
  if (CONFIG.IS_PRODUCTION) res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  next();
}

export const safeNext = (n: unknown, fallback = "/app"): string =>
  typeof n === "string" && /^\/(?!\/)[\w\-./?=&%]*$/.test(n) && !n.includes("\\") ? n : fallback;

export const clientIp = (req: Request) => req.ip ?? "unknown";
