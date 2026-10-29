import express from "express";
(global as any).self = global;
import { RingClient } from "./ringClient";
import { FaceRecognizer } from "./faceRecognition";
import { VisitorStore } from "./knownVisitors";
import { CONFIG } from "./config";
import { createHmac, randomUUID, timingSafeEqual } from "crypto";
import { publishNotification } from "./snsPublisher";
import { promises as fs } from "fs";
import path from "path";

const app = express();

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
    return res.status(503).send(`<!doctype html><html><body style="font-family:sans-serif;padding:2rem"><h1>Ring account linking is preparing</h1><p>The Ring OAuth authorization URL is not configured yet. This endpoint is ready for the console configuration.</p><p>State: ${state.replace(/[<>]/g, "")}</p></body></html>`);
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
      await fs.mkdir("data", { recursive: true });
      await fs.writeFile("data/account-link.json", JSON.stringify({ linkedAt: new Date().toISOString(), status: "linked" }, null, 2));
      return res.redirect("/ring/config?account_link=success");
    } catch (err) {
      console.error("Ring OAuth callback failed:", err);
      return res.redirect("/ring/config?account_link=error");
    }
  }
  await fs.mkdir("data", { recursive: true });
  await fs.writeFile("data/account-link.json", JSON.stringify({ linkedAt: new Date().toISOString(), status: "code_received", state }, null, 2));
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

// In‑memory recent recognition events (max 20)
interface EventRecord {
  timestamp: string;
  type: "motion" | "ding";
  name?: string; // recognized name
  score?: number;
  unknown: boolean;
  eventId?: string;
  snapshotUrl?: string;
  registeredPhotoUrl?: string;
}
const recentEvents: EventRecord[] = [];

async function saveSnapshot(snapshotUrl: string): Promise<string | null> {
  try {
    const response = await fetch(snapshotUrl);
    if (!response.ok) return null;
    const snapshotId = randomUUID();
    const directory = "public/snapshots";
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(`${directory}/${snapshotId}.jpg`, Buffer.from(await response.arrayBuffer()));
    return `/snapshots/${snapshotId}.jpg`;
  } catch (err) {
    console.warn("Unable to save Ring snapshot:", err);
    return null;
  }
}

async function loadEvents() {
  try {
    const raw = await fs.readFile(CONFIG.EVENT_DB_PATH, "utf-8");
    const stored = JSON.parse(raw) as EventRecord[];
    recentEvents.splice(0, recentEvents.length, ...stored.slice(0, 500));
  } catch {
    await fs.mkdir(require("path").dirname(CONFIG.EVENT_DB_PATH), { recursive: true });
  }
}

async function saveEvents() {
  await fs.mkdir(require("path").dirname(CONFIG.EVENT_DB_PATH), { recursive: true });
  await fs.writeFile(CONFIG.EVENT_DB_PATH, JSON.stringify(recentEvents, null, 2));
}

function addEvent(rec: EventRecord) {
  recentEvents.unshift(rec);
  if (recentEvents.length > 500) recentEvents.pop();
  saveEvents().catch((err) => console.error("Unable to persist recognition event:", err));
}

// -------------------------------------------------
// Initialise
// -------------------------------------------------
async function start() {
  await store.load();
  await loadEvents();
  try {
    await ring.init();
    console.log("Ring integration connected.");
  } catch (err) {
    console.warn("Ring integration unavailable; the web API will still run:", err);
  }

  let lastFaceCaptureAt = 0;
  let automaticCaptureInProgress = false;

  const handleEvent = async (type: "motion" | "ding", source: "ring" | "poll" | "manual" = "ring") => {
    try {
      const snapshotUrl = await ring.requestSnapshot();
      const faceResult = await recognizer.embed(snapshotUrl);
      if (!faceResult.faceDetected || !faceResult.embedding) {
        console.log(`[${type}] Ignored: no human face detected in snapshot`);
        return;
      }

      const now = Date.now();
      if (source !== "manual" && now - lastFaceCaptureAt < 15000) {
        return;
      }
      lastFaceCaptureAt = now;
      const embedding = faceResult.embedding;
      const match = store.findBestMatch(embedding);
      const bestCandidate = store.findBestMatchWithScore(embedding);
      if (bestCandidate && !match) {
        console.log(`[${type}] Best registered match: ${bestCandidate.visitor.name} (score ${bestCandidate.score.toFixed(2)}, threshold ${CONFIG.RECOGNITION_THRESHOLD})`);
      }

      if (match) {
        console.log(`[${type}] Recognized ${match.visitor.name} (score ${match.score.toFixed(2)})`);
        const snapshotPath = await saveSnapshot(snapshotUrl);
        const payload = {
          type: "recognition",
          event: type,
          name: match.visitor.name,
          score: match.score,
          snapshotUrl: snapshotPath ?? undefined,
          arrivalPhotoUrl: snapshotPath ?? undefined,
          registeredPhotoUrl: match.visitor.photoPath ?? undefined,
          message: `${match.visitor.name} has arrived`,
          timestamp: new Date().toISOString(),
        };
        await publishNotification(payload);
        addEvent({ timestamp: payload.timestamp, type, name: match.visitor.name, score: match.score, unknown: false, snapshotUrl: snapshotPath ?? undefined, registeredPhotoUrl: match.visitor.photoPath ?? undefined });
      } else {
        console.log(`[${type}] Unknown visitor`);
        const snapshotPath = await saveSnapshot(snapshotUrl);
        const payload = {
          type: "recognition",
          event: type,
          unknown: true,
          visitorStatus: "unregistered",
          message: "A new unregistered visitor has arrived",
          snapshotUrl: snapshotPath ?? undefined,
          timestamp: new Date().toISOString(),
        };
        await publishNotification(payload);
        addEvent({
          timestamp: payload.timestamp,
          type,
          unknown: true,
          eventId: randomUUID(),
          snapshotUrl: snapshotPath ?? undefined,
        });
      }
    } catch (err) {
      console.error(`Error handling ${type}:`, err);
    }
  };

  ring.on("motion", () => handleEvent("motion", "ring"));
  ring.on("ding", () => handleEvent("ding", "ring"));

  if (ring.getStatus().connected) {
    console.log("Starting automatic human-face snapshot monitoring (every 3 seconds).");
    setInterval(async () => {
      if (automaticCaptureInProgress) return;
      automaticCaptureInProgress = true;
      try {
        await handleEvent("motion", "poll");
      } finally {
        automaticCaptureInProgress = false;
      }
    }, 3000);
  }

  // -------------------------------------------------
  // REST API (visitors & privacy)
  // -------------------------------------------------
  app.get("/ring/status", (_req, res) => res.json({ ...ring.getStatus(), automaticMonitoring: ring.getStatus().connected, pollIntervalSeconds: 3, duplicateCooldownSeconds: 15 }));

  app.post("/ring/capture", async (_req, res) => {
    try {
      await handleEvent("motion", "manual");
      res.json({ success: true, message: "Manual snapshot capture checked for a human face" });
    } catch (err) {
      res.status(500).json({ success: false, error: String(err) });
    }
  });

  app.get("/visitors", (_req, res) => res.json(store.getAll()));

  app.post("/visitors", async (req, res) => {
    const { name, imageUrl, imageData } = req.body;
    if (!name || (!imageUrl && !imageData)) {
      return res.status(400).json({ error: "`name` and an image upload or `imageUrl` are required" });
    }
    try {
      let photoPath: string | null = null;
      let sourceUrl = imageUrl as string | undefined;

      if (imageData) {
        const match = /^data:(image\/[^;]+);base64,(.+)$/.exec(imageData);
        if (!match) return res.status(400).json({ error: "Invalid image upload" });
        const uploadId = randomUUID();
        const directory = "public/snapshots";
        await fs.mkdir(directory, { recursive: true });
        photoPath = `/snapshots/${uploadId}.jpg`;
        await fs.writeFile(`public${photoPath}`, Buffer.from(match[2], "base64"));
        sourceUrl = `http://localhost:${CONFIG.PORT}${photoPath}`;
      } else if (sourceUrl?.startsWith("/")) {
        sourceUrl = `http://localhost:${CONFIG.PORT}${sourceUrl}`;
      }

      const faceResult = await recognizer.embed(sourceUrl as string);
      if (!faceResult.faceDetected || !faceResult.embedding) {
        return res.status(422).json({ error: "No human face detected in the provided photo" });
      }
      photoPath ??= await saveSnapshot(sourceUrl as string);
      const visitor = { id: randomUUID(), name, embedding: Array.from(faceResult.embedding), optOut: false, photoPath: photoPath ?? undefined };
      store.add(visitor);
      await store.save();
      res.status(201).json(visitor);
    } catch (e) {
      console.error(e);
      res.status(500).json({ error: "Failed to process image" });
    }
  });

  // Privacy: delete visitor (GDPR erase)
  app.delete("/visitors/:id", async (req, res) => {
    const visitor = store.getAll().find((item) => item.id === req.params.id);
    const deleted = store.delete(req.params.id);
    if (deleted) {
      await store.save();
      if (visitor?.photoPath?.startsWith("/snapshots/")) {
        try {
          await fs.unlink(`public${visitor.photoPath}`);
        } catch {
          // The visitor record may outlive a photo file; deletion is still successful.
        }
      }
      res.status(204).send();
    } else {
      res.status(404).json({ error: "Visitor not found" });
    }
  });

  // Privacy: opt‑out flag toggle
  app.patch("/visitors/:id/optout", async (req, res) => {
    const { optOut } = req.body;
    if (typeof optOut !== "boolean") {
      return res.status(400).json({ error: "`optOut` boolean required" });
    }
    const updated = store.updateOptOut(req.params.id, optOut);
    if (updated) {
      await store.save();
      res.status(200).json({ success: true });
    } else {
      res.status(404).json({ error: "Visitor not found" });
    }
  });

  // Recent recognition events (for UI)
  app.get("/events", (_req, res) => res.json(recentEvents));

  app.delete("/events/:eventId", async (req, res) => {
    const index = recentEvents.findIndex((event) => event.eventId === req.params.eventId);
    if (index === -1) {
      return res.status(404).json({ error: "Recognition event not found" });
    }

    const [deletedEvent] = recentEvents.splice(index, 1);
    await saveEvents();

    if (deletedEvent.snapshotUrl?.startsWith("/snapshots/") && !deletedEvent.snapshotUrl.includes("..")) {
      try {
        await fs.unlink(`public${deletedEvent.snapshotUrl}`);
      } catch {
        // The event can be erased even if its snapshot has already been removed.
      }
    }

    res.status(204).send();
  });

  // Health check
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  app.listen(CONFIG.PORT, () => {
    console.log(`Visitor Recognizer listening on http://localhost:${CONFIG.PORT}`);
    console.log(`Open http://localhost:${CONFIG.PORT}/ (static UI)`);
  });
}

start().catch((e) => {
  console.error("Fatal error during startup:", e);
  process.exit(1);
});
