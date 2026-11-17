import * as dotenv from "dotenv";

dotenv.config();

const env = process.env;
const isProduction = env.NODE_ENV === "production";

export const APP_NAME = env.APP_NAME || "Visitor Recognizer";
export const APP_VERSION = "1.0.0";

/** Builds the config from the current environment. Tests call loadConfig() after setting env vars. */
export function loadConfig() {
  return {
    NODE_ENV: env.NODE_ENV ?? "development",
    IS_PRODUCTION: isProduction,
    PORT: Number(env.PORT) || 3000,
    PUBLIC_APP_URL: (env.PUBLIC_APP_URL || "https://ring-visitor-recognizer.onrender.com").replace(/\/$/, ""),

    // Ring Partner API credentials (Ring Developer Portal)
    RING_CLIENT_ID: env.RING_CLIENT_ID ?? "",
    RING_CLIENT_SECRET: env.RING_CLIENT_SECRET ?? "",
    RING_HMAC_SIGNATURE_KEY: env.RING_HMAC_SIGNATURE_KEY ?? "",
    // Official endpoints. The overrides exist only so automated tests can point at a local mock;
    // they are ignored when NODE_ENV=production.
    RING_OAUTH_TOKEN_URL:
      (!isProduction && env.RING_OAUTH_URL_OVERRIDE) || "https://oauth.ring.com/oauth/token",
    RING_API_BASE: ((!isProduction && env.RING_API_URL_OVERRIDE) || "https://api.amazonvision.com").replace(/\/$/, ""),
    RING_USER_AGENT: env.RING_USER_AGENT || `VisitorRecognizer/${APP_VERSION.split(".").slice(0, 2).join(".")}`,
    RING_HTTP_TIMEOUT_MS: Number(env.RING_HTTP_TIMEOUT_MS) || 8000,
    RING_MANAGE_URL: "https://account.ring.com/account/integrations",

    SUPPORT_EMAIL: env.SUPPORT_EMAIL || "mussadrammeh@protonmail.com",

    // Security
    ADMIN_TOKEN: env.ADMIN_TOKEN ?? "",
    DATA_ENCRYPTION_KEY: env.DATA_ENCRYPTION_KEY ?? "",
    SESSION_DAYS: Number(env.SESSION_DAYS) || 14,

    // Storage: Postgres when DATABASE_URL is set, otherwise encrypted local files.
    // Connection strings never contain whitespace; strip any pasted/wrapped spaces or newlines.
    DATABASE_URL: (env.DATABASE_URL ?? "").replace(/\s+/g, ""),
    DATABASE_SSL: env.DATABASE_SSL === "true",
    DATA_DIR: env.DATA_DIR || "./data",

    // Retention
    RETENTION_DAYS: Number(env.RETENTION_DAYS) || 30,
    AUDIT_RETENTION_DAYS: Number(env.AUDIT_RETENTION_DAYS) || 365,
    // Face templates of an account nobody has signed in to for this long are deleted automatically.
    TEMPLATE_INACTIVITY_DAYS: Number(env.TEMPLATE_INACTIVITY_DAYS) || 365,
    UNCLAIMED_TOKEN_TTL_MINUTES: Number(env.UNCLAIMED_TOKEN_TTL_MINUTES) || 15,

    // Recognition
    RECOGNITION_THRESHOLD: Number(env.RECOGNITION_THRESHOLD) || 0.75,
    // Facial recognition is not offered for cameras Ring reports in these US states (biometric laws
    // that require the enrolled person's own written release). Arrival log still works there.
    RECOGNITION_BLOCKED_STATES: (env.RECOGNITION_BLOCKED_STATES ?? "IL,TX,WA")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
    PYTHON_BIN: env.PYTHON_BIN || (process.platform === "win32" ? "py" : "python3"),
    // Delay schedule (ms) for fetching the snapshot after a webhook: recordings need time to finish.
    SNAPSHOT_RETRY_DELAYS_MS: (env.SNAPSHOT_RETRY_DELAYS_MS ?? "4000,8000,15000,30000")
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0),
  };
}

export type Config = ReturnType<typeof loadConfig>;
export const CONFIG: Config = loadConfig();
