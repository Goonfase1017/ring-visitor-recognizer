// Imported first by every test file: configures the environment before any app module loads.
import { mkdtempSync } from "fs";
import os from "os";
import path from "path";

export const MOCK_PORT = 41000 + Math.floor(Math.random() * 2000);
export const HMAC_KEY = "test-hmac-key";
process.env.NODE_ENV = "test";
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), "vr-test-"));
process.env.DATA_ENCRYPTION_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
process.env.RING_CLIENT_ID = "test-client";
process.env.RING_CLIENT_SECRET = "test-secret";
process.env.RING_HMAC_SIGNATURE_KEY = HMAC_KEY;
process.env.RING_OAUTH_URL_OVERRIDE = `http://127.0.0.1:${MOCK_PORT}/oauth/token`;
process.env.RING_API_URL_OVERRIDE = `http://127.0.0.1:${MOCK_PORT}`;
process.env.SNAPSHOT_RETRY_DELAYS_MS = "0,0";
process.env.ADMIN_TOKEN = "ops-token";
delete process.env.DATABASE_URL;
