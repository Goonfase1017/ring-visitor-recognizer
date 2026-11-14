import express from "express";
import { APP_NAME, CONFIG } from "./config";
import { PythonFaceEngine } from "./face";
import { encryptionEnabled } from "./secure";
import { createStore } from "./storage";
import type { AppContext } from "./app";

/**
 * Listen first (so /health and Ring's Token Exchange URL answer as soon as the process is up),
 * then open storage and mount the app. Nothing here contacts Ring at startup.
 */
const root = express();
root.disable("x-powered-by");
let ctx: AppContext | null = null;

root.get("/health", (_req, res) => res.json({ status: "ok" }));
root.use((req, res, next) => {
  if (ctx) return ctx.app(req, res, next);
  res.setHeader("Retry-After", "2");
  res.status(503).json({ error: "starting" });
});

root.listen(CONFIG.PORT, () => {
  console.log(`${APP_NAME} listening on port ${CONFIG.PORT}`);
  if (!encryptionEnabled()) console.warn("DATA_ENCRYPTION_KEY is not set: accounts and Ring links cannot be stored.");
  if (!CONFIG.RING_HMAC_SIGNATURE_KEY) console.warn("RING_HMAC_SIGNATURE_KEY is not set: account linking and webhooks are disabled.");
  if (!CONFIG.DATABASE_URL) console.warn("DATABASE_URL is not set: using encrypted local files (lost when the host's disk is reset).");
  void start();
});

async function start() {
  try {
    const store = createStore();
    await store.init();
    const { createApp } = await import("./app");
    ctx = createApp({ store, faces: new PythonFaceEngine("./model") });
    console.log(`Storage ready (${store.kind}).`);
  } catch (err) {
    console.error("Startup failed; retrying in 10 s:", (err as Error).message);
    setTimeout(() => void start(), 10_000);
    return;
  }
  const c = ctx!;
  const every = (ms: number, fn: () => Promise<unknown>) => setInterval(() => fn().catch((e) => console.error((e as Error).message)), ms).unref();
  every(60_000, () => c.linking.cleanupPending()); // unclaimed tokens > 15 min
  every(5 * 60_000, () => c.linking.completePendingIntegrations());
  every(3600_000, () => retention(c));
  every(6 * 3600_000, () => c.tokens.refreshDue()); // each link refreshed roughly daily
  setTimeout(() => void retention(c).catch(() => undefined), 5_000).unref();
  setTimeout(() => void c.tokens.refreshDue().catch(() => undefined), 30_000).unref();
}

/** Automatic deletion: arrivals + snapshots after RETENTION_DAYS, logs after AUDIT_RETENTION_DAYS. */
export async function retention(c: AppContext) {
  const store = c.repo.store;
  const cutoff = Date.now() - CONFIG.RETENTION_DAYS * 86400_000;
  const events = await store.deleteWhere("events", { createdBefore: cutoff });
  const blobs = await store.deleteBlobsWhere({ createdBefore: cutoff });
  const auditCutoff = Date.now() - CONFIG.AUDIT_RETENTION_DAYS * 86400_000;
  await store.deleteWhere("audit", { createdBefore: auditCutoff });
  await store.deleteWhere("deletionLog", { createdBefore: auditCutoff });
  await store.deleteWhere("sessions", { createdBefore: Date.now() - CONFIG.SESSION_DAYS * 86400_000 });
  await c.webhooks.sweep();
  // Biometric retention limit: templates are not kept for abandoned accounts.
  const inactiveCutoff = Date.now() - CONFIG.TEMPLATE_INACTIVITY_DAYS * 86400_000;
  for (const u of await store.find<import("./repo").User>("users", {})) {
    const lastSeen = Date.parse(u.data.lastSignInAt ?? u.data.createdAt);
    if (!u.data.recognitionConsent || !Number.isFinite(lastSeen) || lastSeen >= inactiveCutoff) continue;
    const templates = await c.repo.deleteAllVisitors(u.id);
    await c.repo.updateUser(u.id, { recognitionConsent: null });
    await c.repo.audit(u.id, "recognition_expired_inactivity", { templatesDeleted: templates });
    await c.repo.logDeletion(u.id, "templates_inactivity", { templates });
  }
  if (events || blobs) console.log(`Retention: deleted ${events} arrivals and ${blobs} snapshots older than ${CONFIG.RETENTION_DAYS} days.`);
}
