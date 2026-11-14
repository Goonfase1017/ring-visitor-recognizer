import express from "express";
(global as any).self = global;
import { RingClient } from "./ringClient";
import { FaceRecognizer } from "./faceRecognition";
import { VisitorStore } from "./knownVisitors";
import { CONFIG } from "./config";
import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { publishNotification } from "./snsPublisher";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { APP_NAME } from "./config";
import { audit, auditMiddleware, encryptionEnabled, readEncrypted, requireAdmin, writeEncrypted } from "./secure";
import { CONSENT_STATEMENT } from "./knownVisitors";

const app = express();
app.set("trust proxy", true);
app.use(auditMiddleware);

app.post("/ring/webhook", express.raw({ type: "*/*", limit: "2mb" }), async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from("");
  const signatureHeaders = [
    req.header("x-ring-signature"),
    req.header("ring-signature"),
    req.header("x-amz-content-sha256"),
  ].filter((value): value is string => Boolean(value));

  if (CONFIG.RING_HMAC_SIGNATURE_KEY) {
    const expected = createHmac("sha256", CONFIG.RING_HMAC_SIGNATURE_KEY).update(rawBody).digest("hex");
    let valid = false;
    for (const header of signatureHeaders) {
      const supplied = header.replace(/^sha256=/i, "").trim();
      if (/^[a-f0-9]{64}$/i.test(supplied)) {
        const suppliedBuffer = Buffer.from(supplied, "hex");
        const expectedBuffer = Buffer.from(expected, "hex");
        if (suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer)) valid = true;
      } else {
        try {
          const suppliedBuffer = Buffer.from(supplied, "base64");
          const expectedBuffer = createHmac("sha256", CONFIG.RING_HMAC_SIGNATURE_KEY).update(rawBody).digest();
          if (suppliedBuffer.length === expectedBuffer.length && timingSafeEqual(expectedBuffer, suppliedBuffer)) valid = true;
        } catch { /* Try the remaining supported header formats. */ }
      }
    }
    if (!valid) return res.status(401).json({ error: "Invalid Ring webhook signature" });
  }

  void audit({ kind: "ring_webhook", signatureVerified: Boolean(CONFIG.RING_HMAC_SIGNATURE_KEY) });
  let event: any = {};
  try { event = rawBody.length ? JSON.parse(rawBody.toString("utf8")) : {}; } catch { event = {}; }
  console.log("Ring webhook received:", event.type ?? event.event ?? "unknown-event");
  await publishNotification({
    type: "ring-webhook",
    event: event.type ?? event.event ?? "unknown",
    message: "Ring account integration event received",
    timestamp: new Date().toISOString(),
  }).catch((err) => console.error("Unable to publish webhook notification:", err));
  res.status(200).json({ received: true });
});

app.use(express.json({ limit: "15mb" }));
// Serve static UI files from /public (e.g., index.html)
app.use(express.static("public"));

app.get("/ring-visitor-recognizer", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "website.html"));
});
app.get("/ring-visitor-recognizer/privacy", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "privacy.html"));
});
app.get("/ring-visitor-recognizer/terms", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "terms.html"));
});
app.get("/ring-visitor-recognizer/support", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "support.html"));
});

app.get("/ring/config", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "website.html"));
});

app.get("/ring/link", (req, res) => {
  const state = typeof req.query.state === "string" ? req.query.state : randomUUID();
  if (!CONFIG.RING_OAUTH_AUTHORIZE_URL) {
    void fs.mkdir(CONFIG.DATA_DIR, { recursive: true }).then(() =>
      fs.writeFile(path.join(CONFIG.DATA_DIR, "account-link.json"), JSON.stringify({ initiatedAt: new Date().toISOString(), status: "ring_link_requested", state }, null, 2))
    );
    return res.redirect("/ring/config?account_link=requested");
  }
  const redirectUri = `${CONFIG.PUBLIC_APP_URL}/oauth/callback`;
  const authorizeUrl = new URL(CONFIG.RING_OAUTH_AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", CONFIG.RING_CLIENT_ID);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);
  res.redirect(authorizeUrl.toString());
});

app.get("/oauth/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  if (!code) return res.redirect("/ring/config?account_link=error");

  if (CONFIG.RING_OAUTH_TOKEN_URL) {
    try {
      const response = await fetch(CONFIG.RING_OAUTH_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: `${CONFIG.PUBLIC_APP_URL}/oauth/callback`,
          client_id: CONFIG.RING_CLIENT_ID,
          client_secret: CONFIG.RING_CLIENT_SECRET,
          state,
        }),
      });
      if (!response.ok) throw new Error(`Token exchange returned HTTP ${response.status}`);
      await fs.mkdir(CONFIG.DATA_DIR, { recursive: true });
      await fs.writeFile(path.join(CONFIG.DATA_DIR, "account-link.json"), JSON.stringify({ linkedAt: new Date().toISOString(), status: "linked" }, null, 2));
      return res.redirect("/ring/config?account_link=success");
    } catch (err) {
      console.error("Ring OAuth callback failed:", err);
      return res.redirect("/ring/config?account_link=error");
    }
  }
  await fs.mkdir(CONFIG.DATA_DIR, { recursive: true });
  await fs.writeFile(path.join(CONFIG.DATA_DIR, "account-link.json"), JSON.stringify({ linkedAt: new Date().toISOString(), status: "code_received", state }, null, 2));
  res.redirect("/ring/config?account_link=success");
});

app.post("/oauth/token", express.json({ limit: "2mb" }), async (req, res) => {
  const code = typeof req.body?.code === "string" ? req.body.code : "";
  if (!code) return res.status(400).json({ error: "authorization code is required" });
  if (!CONFIG.RING_OAUTH_TOKEN_URL) return res.status(503).json({ error: "Token exchange URL is not configured" });

  try {
    const response = await fetch(CONFIG.RING_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ ...req.body, client_id: CONFIG.RING_CLIENT_ID, client_secret: CONFIG.RING_CLIENT_SECRET }),
    });
    const body = await response.text();
    res.status(response.status).type("application/json").send(body);
  } catch (err) {
    console.error("Ring token exchange failed:", err);
    res.status(502).json({ error: "Token exchange failed" });
  }
});

// -------------------------------------------------
// Core components
// -------------------------------------------------
const ring = new RingClient();
const recognizer = new FaceRecognizer("./model");
const store = new VisitorStore();

interface EventRecord {
  timestamp: string;
  type: "motion" | "ding";
  name?: string;
  score?: number;
  unknown: boolean;
  eventId?: string;
  snapshotUrl?: string;
  registeredPhotoUrl?: string;
}
const recentEvents: EventRecord[] = [];
const MEDIA_ID = /^\/media\/([a-f0-9-]{36})$/;

function mediaFile(mediaUrl: string): string | null {
  const m = MEDIA_ID.exec(mediaUrl);
  return m ? path.join(CONFIG.MEDIA_DIR, `${m[1]}.enc`) : null;
}

async function deleteMedia(mediaUrl?: string) {
  const file = mediaUrl ? mediaFile(mediaUrl) : null;
  if (file) await fs.unlink(file).catch(() => undefined);
}

/** Encrypt an image (temp file path or http URL) into the media store; removes temp files. */
async function saveSnapshot(source: string): Promise<string | null> {
  try {
    let bytes: Buffer;
    if (/^https?:\/\//.test(source)) {
      const response = await fetch(source);
      if (!response.ok) return null;
      bytes = Buffer.from(await response.arrayBuffer());
    } else {
      bytes = await fs.readFile(source);
    }
    const id = randomUUID();
    await writeEncrypted(path.join(CONFIG.MEDIA_DIR, `${id}.enc`), bytes);
    return `/media/${id}`;
  } catch (err) {
    console.warn("Unable to save snapshot:", err);
    return null;
  }
}

async function tempFileFrom(bytes: Buffer): Promise<string> {
  const file = path.join(os.tmpdir(), `vr-${randomUUID()}.jpg`);
  await fs.writeFile(file, bytes, { mode: 0o600 });
  return file;
}

async function removeTemp(file?: string) {
  if (file && file.startsWith(os.tmpdir())) await fs.unlink(file).catch(() => undefined);
}

async function loadEvents() {
  try {
    const stored = JSON.parse((await readEncrypted(CONFIG.EVENT_DB_PATH)).toString("utf8")) as EventRecord[];
    recentEvents.splice(0, recentEvents.length, ...stored.slice(0, 500));
  } catch {
    recentEvents.splice(0, recentEvents.length);
  }
}

async function saveEvents() {
  await writeEncrypted(CONFIG.EVENT_DB_PATH, JSON.stringify(recentEvents));
}

function addEvent(rec: EventRecord) {
  recentEvents.unshift(rec);
  while (recentEvents.length > 500) {
    const dropped = recentEvents.pop();
    void deleteMedia(dropped?.snapshotUrl);
  }
  saveEvents().catch((err) => console.error("Unable to persist recognition event:", err));
}

// -------------------------------------------------
// 30-day automatic retention
// -------------------------------------------------
async function enforceRetention() {
  const cutoff = Date.now() - CONFIG.RETENTION_DAYS * 86400_000;
  let removed = 0;
  for (let i = recentEvents.length - 1; i >= 0; i--) {
    if (Date.parse(recentEvents[i].timestamp) < cutoff) {
      await deleteMedia(recentEvents[i].snapshotUrl);
      recentEvents.splice(i, 1);
      removed++;
    }
  }
  if (removed) await saveEvents();

  // Remove any media file older than the window that no visitor or event still references.
  const referenced = new Set<string>();
  for (const e of recentEvents) if (e.snapshotUrl) referenced.add(e.snapshotUrl);
  for (const v of store.getAll()) if (v.photoPath) referenced.add(v.photoPath);
  let orphans = 0;
  try {
    for (const name of await fs.readdir(CONFIG.MEDIA_DIR)) {
      const file = path.join(CONFIG.MEDIA_DIR, name);
      const url = `/media/${name.replace(/\.enc$/, "")}`;
      const stat = await fs.stat(file);
      if (!referenced.has(url) && stat.mtimeMs < cutoff) {
        await fs.unlink(file);
        orphans++;
      }
    }
  } catch { /* media dir may not exist yet */ }

  // Trim the audit log to its retention window.
  try {
    const auditCutoff = Date.now() - CONFIG.AUDIT_RETENTION_DAYS * 86400_000;
    const lines = (await fs.readFile(CONFIG.AUDIT_LOG_PATH, "utf8")).split("\n").filter(Boolean);
    const kept = lines.filter((l) => { try { return Date.parse(JSON.parse(l).at) >= auditCutoff; } catch { return false; } });
    if (kept.length !== lines.length) await fs.writeFile(CONFIG.AUDIT_LOG_PATH, kept.join("\n") + (kept.length ? "\n" : ""), { mode: 0o600 });
  } catch { /* no audit log yet */ }

  await audit({ kind: "retention_sweep", eventsRemoved: removed, orphanMediaRemoved: orphans, retentionDays: CONFIG.RETENTION_DAYS });
}

// -------------------------------------------------
// Recognition pipeline (runs on the app's server)
// -------------------------------------------------
let lastFaceCaptureAt = 0;
let automaticCaptureInProgress = false;

const handleEvent = async (type: "motion" | "ding", source: "ring" | "poll" | "manual" = "ring") => {
  let snapshotSource: string | undefined;
  try {
    snapshotSource = await ring.requestSnapshot();
    const faceResult = await recognizer.embed(snapshotSource);
    if (!faceResult.faceDetected || !faceResult.embedding) return;

    const now = Date.now();
    if (source !== "manual" && now - lastFaceCaptureAt < 15000) return;
    lastFaceCaptureAt = now;
    const match = store.findBestMatch(faceResult.embedding);
    const snapshotPath = await saveSnapshot(snapshotSource);
    const timestamp = new Date().toISOString();

    if (match) {
      await publishNotification({
        type: "recognition", event: type, name: match.visitor.name, score: match.score,
        message: `${match.visitor.name} has arrived`, timestamp,
      }).catch((err) => console.error("Notification failed:", err));
      addEvent({ timestamp, type, name: match.visitor.name, score: match.score, unknown: false, eventId: randomUUID(), snapshotUrl: snapshotPath ?? undefined, registeredPhotoUrl: match.visitor.photoPath ?? undefined });
    } else {
      await publishNotification({
        type: "recognition", event: type, unknown: true, visitorStatus: "unregistered",
        message: "A new unregistered visitor has arrived", timestamp,
      }).catch((err) => console.error("Notification failed:", err));
      addEvent({ timestamp, type, unknown: true, eventId: randomUUID(), snapshotUrl: snapshotPath ?? undefined });
    }
  } catch (err) {
    console.error(`Error handling ${type}:`, err);
  } finally {
    await removeTemp(snapshotSource);
  }
};

// -------------------------------------------------
// Owner-only REST API (Bearer ADMIN_TOKEN, audited)
// -------------------------------------------------
app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/ring/status", requireAdmin, (_req, res) => res.json({
  ...ring.getStatus(),
  automaticMonitoring: ring.getStatus().connected,
  pollIntervalSeconds: 3,
  duplicateCooldownSeconds: 15,
  encryptionAtRest: encryptionEnabled(),
  retentionDays: CONFIG.RETENTION_DAYS,
}));

app.post("/ring/capture", requireAdmin, async (_req, res) => {
  await handleEvent("motion", "manual");
  res.json({ success: true, message: "Manual snapshot capture checked for a human face" });
});

app.get("/media/:id", requireAdmin, async (req, res) => {
  const file = mediaFile(`/media/${req.params.id}`);
  if (!file) return res.status(404).end();
  try {
    res.type("image/jpeg").set("Cache-Control", "no-store").send(await readEncrypted(file));
  } catch {
    res.status(404).end();
  }
});

app.get("/consent/statement", (_req, res) => res.json({ statement: CONSENT_STATEMENT }));

app.get("/visitors", requireAdmin, (_req, res) => res.json(store.list()));

app.post("/visitors", requireAdmin, async (req, res) => {
  const { name, imageUrl, imageData, consent } = req.body ?? {};
  if (!name || (!imageUrl && !imageData)) {
    return res.status(400).json({ error: "`name` and an image upload or `imageUrl` are required" });
  }
  if (!consent || consent.confirmed !== true || typeof consent.method !== "string" || !consent.method.trim()) {
    return res.status(400).json({ error: "Visitor consent must be confirmed (consent.confirmed = true and consent.method) before a face template is created" });
  }
  let temp: string | undefined;
  try {
    if (imageData) {
      const match = /^data:(image\/[^;]+);base64,(.+)$/.exec(imageData);
      if (!match) return res.status(400).json({ error: "Invalid image upload" });
      temp = await tempFileFrom(Buffer.from(match[2], "base64"));
    } else if (typeof imageUrl === "string" && mediaFile(imageUrl)) {
      temp = await tempFileFrom(await readEncrypted(mediaFile(imageUrl)!));
    } else if (typeof imageUrl === "string" && /^https:\/\//.test(imageUrl)) {
      const response = await fetch(imageUrl);
      if (!response.ok) return res.status(400).json({ error: "Unable to download image" });
      temp = await tempFileFrom(Buffer.from(await response.arrayBuffer()));
    } else {
      return res.status(400).json({ error: "Unsupported image source" });
    }

    const faceResult = await recognizer.embed(temp);
    if (!faceResult.faceDetected || !faceResult.embedding) {
      return res.status(422).json({ error: "No human face detected in the provided photo" });
    }
    const photoPath = await saveSnapshot(temp);
    const now = new Date().toISOString();
    const visitor = {
      id: randomUUID(), name: String(name).slice(0, 100), embedding: Array.from(faceResult.embedding), optOut: false,
      photoPath: photoPath ?? undefined, createdAt: now,
      consent: { confirmedAt: now, method: String(consent.method).slice(0, 60), statement: CONSENT_STATEMENT },
    };
    store.add(visitor);
    await store.save();
    await audit({ kind: "visitor_registered", visitorId: visitor.id, consentMethod: visitor.consent.method });
    const { embedding, ...publicVisitor } = visitor;
    res.status(201).json(publicVisitor);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Failed to process image" });
  } finally {
    await removeTemp(temp);
  }
});

app.delete("/visitors/:id", requireAdmin, async (req, res) => {
  const visitor = store.delete(req.params.id);
  if (!visitor) return res.status(404).json({ error: "Visitor not found" });
  await store.save();
  await deleteMedia(visitor.photoPath);
  // Also erase arrival events linked to this visitor.
  for (let i = recentEvents.length - 1; i >= 0; i--) {
    if (!recentEvents[i].unknown && recentEvents[i].registeredPhotoUrl === visitor.photoPath) {
      await deleteMedia(recentEvents[i].snapshotUrl);
      recentEvents.splice(i, 1);
    }
  }
  await saveEvents();
  await audit({ kind: "visitor_deleted", visitorId: visitor.id });
  res.status(204).send();
});

// Opt-out / consent withdrawal: deletes the face template and photo immediately; matching skips the record.
app.patch("/visitors/:id/optout", requireAdmin, async (req, res) => {
  if (req.body?.optOut !== true) {
    return res.status(409).json({ error: "Opt-out cannot be reversed. Register the visitor again with fresh consent." });
  }
  const before = store.optOut(req.params.id);
  if (!before) return res.status(404).json({ error: "Visitor not found" });
  await store.save();
  await deleteMedia(before.photoPath);
  await audit({ kind: "visitor_opt_out", visitorId: req.params.id });
  res.status(200).json({ success: true, faceTemplateDeleted: true });
});

app.get("/events", requireAdmin, (_req, res) => res.json(recentEvents));

app.delete("/events/:eventId", requireAdmin, async (req, res) => {
  const index = recentEvents.findIndex((event) => event.eventId === req.params.eventId);
  if (index === -1) return res.status(404).json({ error: "Recognition event not found" });
  const [deletedEvent] = recentEvents.splice(index, 1);
  await saveEvents();
  await deleteMedia(deletedEvent.snapshotUrl);
  await audit({ kind: "event_deleted", eventId: deletedEvent.eventId });
  res.status(204).send();
});

// Owner data export (names, consent records, events; face templates excluded unless ?includeTemplates=true)
app.get("/privacy/export", requireAdmin, async (req, res) => {
  const includeTemplates = req.query.includeTemplates === "true";
  res.set("Content-Disposition", "attachment; filename=visitor-data-export.json").json({
    exportedAt: new Date().toISOString(),
    app: APP_NAME,
    retentionDays: CONFIG.RETENTION_DAYS,
    visitors: includeTemplates ? store.getAll() : store.list(),
    events: recentEvents,
  });
});

// Owner erase-all
app.delete("/privacy/all", requireAdmin, async (_req, res) => {
  for (const v of store.getAll()) { store.delete(v.id); await deleteMedia(v.photoPath); }
  for (const e of recentEvents) await deleteMedia(e.snapshotUrl);
  recentEvents.splice(0, recentEvents.length);
  await store.save();
  await saveEvents();
  await audit({ kind: "erase_all" });
  res.status(204).send();
});

app.get("/audit", requireAdmin, async (_req, res) => {
  try {
    const lines = (await fs.readFile(CONFIG.AUDIT_LOG_PATH, "utf8")).split("\n").filter(Boolean).slice(-500);
    res.json(lines.map((l) => JSON.parse(l)));
  } catch {
    res.json([]);
  }
});

// -------------------------------------------------
// Start: listen immediately so Ring account linking never waits on startup work.
// -------------------------------------------------
app.listen(CONFIG.PORT, () => {
  console.log(`${APP_NAME} listening on port ${CONFIG.PORT}`);
  if (!encryptionEnabled()) console.warn("DATA_ENCRYPTION_KEY is not set: personal data cannot be stored.");
  if (!CONFIG.ADMIN_TOKEN) console.warn("ADMIN_TOKEN is not set: owner API is locked.");
});

async function start() {
  await store.load();
  await loadEvents();
  await enforceRetention().catch((err) => console.error("Retention sweep failed:", err));
  setInterval(() => enforceRetention().catch((err) => console.error("Retention sweep failed:", err)), 3600_000);
  try {
    await ring.init();
    console.log("Ring integration connected.");
  } catch (err) {
    console.warn("Ring integration unavailable; the web API will still run:", err);
    return;
  }
  ring.on("motion", () => handleEvent("motion", "ring"));
  ring.on("ding", () => handleEvent("ding", "ring"));
  setInterval(async () => {
    if (automaticCaptureInProgress) return;
    automaticCaptureInProgress = true;
    try { await handleEvent("motion", "poll"); } finally { automaticCaptureInProgress = false; }
  }, 3000);
}

start().catch((e) => console.error("Startup error:", e));
