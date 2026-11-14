import express, { NextFunction, Request, Response } from "express";
import path from "path";
import { APP_NAME, APP_VERSION, CONFIG } from "./config";
import { FaceEngine } from "./face";
import {
  RateLimiter,
  SESSION_COOKIE,
  checkFormCsrf,
  clearCookie,
  clientIp,
  formCsrf,
  parseCookies,
  safeNext,
  sameOrigin,
  securityHeaders,
  setCookie,
} from "./http";
import { Linking } from "./linking";
import { EventProcessor, recognitionAllowedForState } from "./processor";
import { ArrivalEvent, RECOGNITION_CONSENT_VERSION, Repo, User } from "./repo";
import { checkLinkTime, isWellFormedNonce } from "./ring/nonce";
import { verifyWebhookSignature } from "./ring/signature";
import { TokenManager } from "./ring/tokens";
import { encryptionEnabled, hashPassword, maskEmail, randomToken, safeEqual, sha256Hex, verifyPassword } from "./secure";
import { Store, StoredDoc } from "./storage";
import { LINK_EXPIRED_MESSAGE, authPage, linkPage, linkSuccessPage, messagePage } from "./views";
import { WebhookHandler } from "./webhooks";

export const RECOGNITION_CONSENT_TEXT =
  "I want to turn on facial recognition. I understand that Visitor Recognizer will create a face template (a set of numbers describing facial geometry) for each person I enroll, store it encrypted on the Visitor Recognizer server (Render, United States), and compare faces in my Ring camera snapshots only against the people I enrolled. People I have not enrolled are shown as \"Unknown\" and no template is kept for them. I can turn this off at any time, which permanently deletes all face templates.";

export const ENROLLMENT_ATTESTATION =
  "I confirm this person has given me permission to enroll their face so this app can recognize them at my door, and that I will delete their enrollment if they ask.";

type Authed = Request & { user?: StoredDoc<User>; sessionCsrf?: string; sessionToken?: string };

export interface AppDeps {
  store: Store;
  faces: FaceEngine;
}

const DUMMY_HASH = "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$" + Buffer.alloc(64).toString("base64");
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

export function createApp({ store, faces }: AppDeps) {
  const repo = new Repo(store);
  const tokens = new TokenManager(repo);
  const linking = new Linking(repo, tokens);
  const processor = new EventProcessor(repo, tokens, faces);
  const webhooks = new WebhookHandler(repo, linking, processor);

  const loginLimiter = new RateLimiter(10, 15 * 60_000);
  const signupLimiter = new RateLimiter(10, 60 * 60_000);
  const tokenLimiter = new RateLimiter(120, 60_000);

  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1); // Render terminates TLS in one proxy hop
  app.use(securityHeaders);

  // ---------------------------------------------------------------------------------------------
  // Health: fast, no I/O.
  // ---------------------------------------------------------------------------------------------
  app.get("/health", (_req, res) => res.json({ status: "ok" }));

  // ---------------------------------------------------------------------------------------------
  // Ring webhook (raw body for HMAC). Verify, acknowledge immediately, process asynchronously.
  // ---------------------------------------------------------------------------------------------
  app.post("/ring/webhook", express.raw({ type: "*/*", limit: "1mb" }), (req, res) => {
    const key = CONFIG.RING_HMAC_SIGNATURE_KEY;
    if (!key) return res.status(503).json({ error: "webhook verification key not configured" });
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyWebhookSignature(raw, req.header("x-signature"), key)) return res.status(401).json({ error: "invalid signature" });
    let payload: any;
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      return res.status(400).json({ error: "invalid JSON" });
    }
    if (!payload?.data?.type) return res.status(400).json({ error: "missing data.type" });
    res.status(200).json({ received: true });
    setImmediate(() => webhooks.handle(payload).catch((err) => console.error("Webhook processing failed:", (err as Error).message)));
  });

  // ---------------------------------------------------------------------------------------------
  // Token Exchange URL: Ring POSTs application/x-www-form-urlencoded {code, client_id}.
  // ---------------------------------------------------------------------------------------------
  app.post(
    "/oauth/token",
    express.urlencoded({ extended: false, limit: "16kb" }),
    express.json({ limit: "16kb" }),
    async (req, res) => {
      if (!tokenLimiter.take(clientIp(req))) return res.status(429).json({ error: "rate_limited" });
      const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
      const clientId = typeof req.body?.client_id === "string" ? req.body.client_id : "";
      if (!code || code.length > 2048) return res.status(400).json({ error: "invalid_request", error_description: "code is required" });
      if (!CONFIG.RING_CLIENT_ID || !CONFIG.RING_CLIENT_SECRET || !encryptionEnabled()) {
        console.error("Token exchange not configured (RING_CLIENT_ID / RING_CLIENT_SECRET / DATA_ENCRYPTION_KEY)");
        return res.status(503).json({ error: "temporarily_unavailable" });
      }
      if (clientId && !safeEqual(clientId, CONFIG.RING_CLIENT_ID)) return res.status(400).json({ error: "invalid_client" });
      try {
        await linking.handleAuthorizationCode(code);
        return res.status(200).json({ status: "ok" });
      } catch (err) {
        const status = (err as any)?.status;
        console.error("Ring token exchange failed:", (err as Error).message, status ?? "");
        return res.status(502).json({ error: "token_exchange_failed" });
      }
    }
  );

  // Forms and JSON APIs
  app.use(express.urlencoded({ extended: false, limit: "32kb" }));
  app.use("/api", express.json({ limit: "12mb" }));

  // ---------------------------------------------------------------------------------------------
  // Sessions
  // ---------------------------------------------------------------------------------------------
  async function loadSession(req: Authed) {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (!token) return;
    const s = await repo.session(token);
    if (!s?.userId) return;
    const user = await repo.userById(s.userId);
    if (!user) return;
    req.user = user;
    req.sessionCsrf = s.data.csrf;
    req.sessionToken = token;
  }

  app.use(async (req: Authed, _res, next) => {
    try {
      await loadSession(req);
      next();
    } catch (err) {
      next(err);
    }
  });

  async function startSession(req: Request, res: Response, userId: string) {
    const token = randomToken(32);
    const expiresAt = await repo.createSession(userId, token, randomToken(24));
    setCookie(req, res, SESSION_COOKIE, token, (expiresAt - Date.now()) / 1000);
  }

  const requireUser = (req: Authed, res: Response, next: NextFunction) => {
    if (!req.user) return res.status(401).json({ error: "Sign in required" });
    next();
  };
  /** Mutating API calls need the per-session CSRF token in X-CSRF-Token. */
  const requireCsrf = (req: Authed, res: Response, next: NextFunction) => {
    const supplied = req.header("x-csrf-token") ?? "";
    if (!req.sessionCsrf || !supplied || !safeEqual(supplied, req.sessionCsrf) || !sameOrigin(req)) {
      return res.status(403).json({ error: "Invalid CSRF token" });
    }
    next();
  };

  async function authenticate(req: Request, email: string, password: string): Promise<{ user?: StoredDoc<User>; error?: string }> {
    const key = `${clientIp(req)}|${sha256Hex(email.toLowerCase())}`;
    if (!loginLimiter.take(key) || !loginLimiter.take(clientIp(req))) {
      return { error: "Too many sign-in attempts. Please wait 15 minutes and try again." };
    }
    const user = EMAIL_RE.test(email) ? await repo.userByEmail(email) : null;
    const ok = await verifyPassword(password, user?.data.passwordHash ?? DUMMY_HASH);
    if (!user || !ok) {
      await repo.audit(user?.id ?? null, "sign_in_failed", {});
      return { error: "That email and password don't match. Check them and try again." };
    }
    loginLimiter.reset(key);
    await repo.updateUser(user.id, { lastSignInAt: new Date().toISOString() });
    await repo.audit(user.id, "signed_in", {});
    return { user };
  }

  async function register(req: Request, email: string, password: string, agree: boolean): Promise<{ user?: StoredDoc<User>; error?: string }> {
    if (!signupLimiter.take(clientIp(req))) return { error: "Too many new accounts from this network. Please try again later." };
    if (!EMAIL_RE.test(email) || email.length > 254) return { error: "Enter a valid email address." };
    if (password.length < 10 || password.length > 200) return { error: "Choose a password with at least 10 characters." };
    if (!agree) return { error: "Please agree to the Terms and Privacy Policy to create an account." };
    if (!encryptionEnabled()) return { error: "Account creation is temporarily unavailable. Please try again shortly." };
    if (await repo.userByEmail(email)) return { error: "An account with this email already exists. Sign in instead." };
    const user = await repo.createUser(email, await hashPassword(password));
    await repo.audit(user.id, "account_created", {});
    return { user };
  }

  const str = (v: unknown, max = 300) => (typeof v === "string" ? v.slice(0, max) : "");

  // ---------------------------------------------------------------------------------------------
  // Account Link URL: GET /ring/link?nonce=..&time=.. (Ring redirect). Sign-in is mandatory; nonce
  // matching runs only after it succeeds.
  // ---------------------------------------------------------------------------------------------
  function linkParams(src: any): { nonce: string; time: string } | "expired" | "invalid" {
    const nonce = src?.nonce;
    const time = src?.time;
    if (!isWellFormedNonce(nonce)) return "invalid";
    const fresh = checkLinkTime(time);
    if (!fresh.ok) return fresh.reason === "invalid" ? "invalid" : "expired";
    return { nonce, time: String(time) };
  }

  const linkProblem = (res: Response, p: "expired" | "invalid") =>
    res
      .status(400)
      .send(
        p === "expired"
          ? messagePage("Link expired", LINK_EXPIRED_MESSAGE)
          : messagePage("Link not valid", "This page needs to be opened from the Ring app. Open the Ring app, go to Ring Appstore, choose Visitor Recognizer and select Get / Connect.")
      );

  app.get("/ring/link", (req: Authed, res) => {
    res.setHeader("Cache-Control", "no-store");
    const p = linkParams(req.query);
    if (typeof p === "string") return linkProblem(res, p);
    res.send(linkPage({ ...p, csrf: formCsrf(req, res), signedInEmail: req.user?.data.email }));
  });

  async function finishLink(req: Request, res: Response, user: StoredDoc<User>, nonce: string, time: string) {
    const result = await linking.claim(user.id, user.data.email, nonce, time);
    const devices = async () => (await repo.devicesForUser(user.id)).map((d) => d.data);
    switch (result.status) {
      case "linked":
        return res.send(linkSuccessPage((await devices()).filter((d) => d.accountId === result.accountId)));
      case "already_linked":
        return res.send(linkSuccessPage((await devices()).filter((d) => d.accountId === result.accountId), true));
      case "expired":
        return res.status(400).send(messagePage("Link expired", LINK_EXPIRED_MESSAGE, { href: "/app", label: "Go to dashboard" }));
      case "no_match":
        return res
          .status(409)
          .send(
            messagePage(
              "We couldn't finish connecting",
              "You're signed in, but we couldn't find the Ring authorization for this link. It may have expired or already been used. Open the Ring app, go to Ring Appstore → My Apps → Visitor Recognizer, and connect again.",
              { href: "/app", label: "Go to dashboard" }
            )
          );
      default:
        return res
          .status(502)
          .send(
            messagePage(
              "Ring didn't confirm the connection",
              "You're signed in, but Ring didn't accept the connection request. Please start the connection again from the Ring app in a few minutes. If it keeps happening, contact support.",
              { href: "/support.html", label: "Get help" }
            )
          );
    }
  }

  async function linkFormHandler(req: Authed, res: Response, mode: "signup" | "signin" | "confirm") {
    res.setHeader("Cache-Control", "no-store");
    if (!checkFormCsrf(req)) return res.status(403).send(messagePage("Session expired", "Please go back and try again."));
    const p = linkParams(req.body); // freshness re-checked on every endpoint that receives nonce/time
    if (typeof p === "string") return linkProblem(res, p);
    const email = str(req.body.email, 254).trim();
    const password = str(req.body.password, 200);
    let user: StoredDoc<User> | undefined;
    if (mode === "confirm") {
      if (!req.user) return res.status(401).send(linkPage({ ...p, csrf: formCsrf(req, res), error: "Please sign in first." }));
      user = req.user;
    } else {
      const r = mode === "signup" ? await register(req, email, password, req.body.agree === "yes") : await authenticate(req, email, password);
      if (!r.user) return res.status(mode === "signup" ? 400 : 401).send(linkPage({ ...p, csrf: formCsrf(req, res), error: r.error, email }));
      user = r.user;
      await startSession(req, res, user.id);
    }
    return finishLink(req, res, user, p.nonce, p.time);
  }

  app.post("/ring/link/signup", (req, res, next) => linkFormHandler(req, res, "signup").catch(next));
  app.post("/ring/link/signin", (req, res, next) => linkFormHandler(req, res, "signin").catch(next));
  app.post("/ring/link/confirm", (req, res, next) => linkFormHandler(req, res, "confirm").catch(next));

  // App Homepage URL. Browsers get the app (or sign-in); JSON clients get a small status document.
  app.get("/ring/config", (req: Authed, res) => {
    if (req.accepts(["html", "json"]) === "json") {
      return res.json({ app: APP_NAME, version: APP_VERSION, status: "ok", homepage: `${CONFIG.PUBLIC_APP_URL}/app` });
    }
    res.redirect(302, req.user ? "/app" : "/signin?next=/app");
  });

  // ---------------------------------------------------------------------------------------------
  // Plain sign-in / sign-up / sign-out
  // ---------------------------------------------------------------------------------------------
  app.get("/signin", (req: Authed, res) => {
    if (req.user) return res.redirect(302, safeNext(req.query.next));
    res.send(authPage("signin", { csrf: formCsrf(req, res), next: safeNext(req.query.next) }));
  });
  app.get("/signup", (req: Authed, res) => {
    if (req.user) return res.redirect(302, "/app");
    res.send(authPage("signup", { csrf: formCsrf(req, res) }));
  });
  app.post("/signin", async (req, res, next) => {
    try {
      if (!checkFormCsrf(req)) return res.status(403).send(messagePage("Session expired", "Please go back and try again."));
      const email = str(req.body.email, 254).trim();
      const r = await authenticate(req, email, str(req.body.password, 200));
      if (!r.user) return res.status(401).send(authPage("signin", { csrf: formCsrf(req, res), error: r.error, email, next: safeNext(req.body.next) }));
      await startSession(req, res, r.user.id);
      res.redirect(303, safeNext(req.body.next));
    } catch (err) {
      next(err);
    }
  });
  app.post("/signup", async (req, res, next) => {
    try {
      if (!checkFormCsrf(req)) return res.status(403).send(messagePage("Session expired", "Please go back and try again."));
      const email = str(req.body.email, 254).trim();
      const r = await register(req, email, str(req.body.password, 200), req.body.agree === "yes");
      if (!r.user) return res.status(400).send(authPage("signup", { csrf: formCsrf(req, res), error: r.error, email }));
      await startSession(req, res, r.user.id);
      res.redirect(303, "/app");
    } catch (err) {
      next(err);
    }
  });
  app.post("/signout", async (req: Authed, res) => {
    if (!checkFormCsrf(req) && !(req.sessionCsrf && safeEqual(str(req.body._csrf), req.sessionCsrf))) return res.status(403).end();
    if (req.sessionToken) await repo.deleteSession(req.sessionToken);
    clearCookie(req, res, SESSION_COOKIE);
    res.redirect(303, safeNext(req.body.next, "/"));
  });

  app.get("/app", (req: Authed, res) => {
    res.setHeader("Cache-Control", "no-store");
    if (!req.user) return res.redirect(302, "/signin?next=/app");
    res.sendFile(path.join(process.cwd(), "views", "app.html"));
  });

  // ---------------------------------------------------------------------------------------------
  // Customer API (session cookie; CSRF header on every change). Everything filtered by req.user.id.
  // ---------------------------------------------------------------------------------------------
  const api = express.Router();
  api.use(requireUser);
  api.use((req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (req.method !== "GET" && req.method !== "HEAD") return requireCsrf(req, res, next);
    next();
  });
  const uid = (req: Authed) => req.user!.id;
  const wrap = (fn: (req: Authed, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) =>
    fn(req, res).catch(next);

  api.get("/me", wrap(async (req, res) => {
    const u = req.user!.data;
    res.json({
      email: u.email,
      csrf: req.sessionCsrf,
      recognitionConsent: u.recognitionConsent,
      tutorialDone: u.tutorialDone,
      retentionDays: CONFIG.RETENTION_DAYS,
      consentText: RECOGNITION_CONSENT_TEXT,
      consentVersion: RECOGNITION_CONSENT_VERSION,
      attestationText: ENROLLMENT_ATTESTATION,
      ringManageUrl: CONFIG.RING_MANAGE_URL,
      blockedStates: CONFIG.RECOGNITION_BLOCKED_STATES,
    });
  }));

  api.post("/tutorial-done", wrap(async (req, res) => {
    await repo.updateUser(uid(req), { tutorialDone: true });
    res.json({ ok: true });
  }));

  api.get("/ring", wrap(async (req, res) => {
    const links = await repo.linksForUser(uid(req));
    const devices = await repo.devicesForUser(uid(req));
    res.json({
      links: links.map((l) => ({
        key: sha256Hex(`${uid(req)}|${l.id}`).slice(0, 16),
        ringEmail: maskEmail(l.data.email || ""),
        status: l.data.status,
        integrationStatus: l.data.integrationStatus,
        linkedAt: l.data.linkedAt,
      })),
      devices: devices.map((d) => ({
        key: sha256Hex(`${uid(req)}|${d.data.deviceId}`).slice(0, 16),
        name: d.data.name,
        online: d.data.online,
        encrypted: d.data.e2ee,
        doorbell: d.data.isDoorbell,
        recognitionAvailable: recognitionAllowedForState(d.data.state),
      })),
    });
  }));

  api.post("/ring/refresh-devices", wrap(async (req, res) => {
    let n = 0;
    for (const l of await repo.linksForUser(uid(req))) {
      if (l.data.status === "active") n += await linking.syncDevices(uid(req), l.id).catch(() => 0);
    }
    res.json({ devices: n });
  }));

  /** Local disconnect: deletes our copy of the Ring tokens and devices. Removing the app in Ring is done in the Ring app. */
  api.post("/ring/disconnect", wrap(async (req, res) => {
    const key = str(req.body?.key, 64);
    for (const l of await repo.linksForUser(uid(req))) {
      if (sha256Hex(`${uid(req)}|${l.id}`).slice(0, 16) !== key) continue;
      processor.cancel({ accountId: l.id });
      await repo.deleteLink(l.id);
      await repo.deleteDevicesForAccount(uid(req), l.id);
      await repo.audit(uid(req), "ring_disconnected_in_app", {});
      return res.json({ disconnected: true });
    }
    res.status(404).json({ error: "Not found" });
  }));

  const eventView = (id: string, e: ArrivalEvent) => ({
    id,
    at: e.at,
    device: e.deviceName,
    kind: e.kind,
    subType: e.subType ?? null,
    status: e.status,
    recognized: e.recognized.map((r) => ({ name: r.name, score: r.score })),
    unknownFaces: e.unknownFaces,
    note: e.note ?? null,
    snapshotUrl: e.snapshotId ? `/api/media/${e.snapshotId}` : null,
  });

  api.get("/events", wrap(async (req, res) => {
    res.json((await repo.events(uid(req), 200)).map((e) => eventView(e.id, e.data)));
  }));
  api.delete("/events/:id", wrap(async (req, res) => {
    if (!(await repo.deleteEvent(uid(req), String(req.params.id)))) return res.status(404).json({ error: "Not found" });
    await repo.audit(uid(req), "event_deleted", {});
    res.json({ deleted: true });
  }));
  api.get("/media/:id", wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!/^[a-f0-9]{32}$/.test(id)) return res.status(404).end();
    const bytes = await repo.snapshot(uid(req), id);
    if (!bytes) return res.status(404).end();
    res.type("image/jpeg").setHeader("Cache-Control", "private, no-store");
    res.send(bytes);
  }));

  // ----- facial recognition consent (separate, explicit, revocable) -----------------------------
  api.post("/consent", wrap(async (req, res) => {
    if (req.body?.agree !== true || req.body?.version !== RECOGNITION_CONSENT_VERSION) {
      return res.status(400).json({ error: "Tick the box to agree before turning on facial recognition." });
    }
    const consent = { grantedAt: new Date().toISOString(), version: RECOGNITION_CONSENT_VERSION };
    await repo.updateUser(uid(req), { recognitionConsent: consent });
    await repo.audit(uid(req), "recognition_consent_granted", { version: consent.version });
    res.json({ recognitionConsent: consent });
  }));

  async function stripRecognition(userId: string, visitorId?: string) {
    for (const e of await repo.events(userId, 100_000)) {
      if (!e.data.recognized.length) continue;
      if (visitorId && !e.data.recognized.some((r) => r.visitorId === visitorId)) continue;
      const remaining = visitorId ? e.data.recognized.filter((r) => r.visitorId !== visitorId) : [];
      await repo.updateEvent(userId, e.id, {
        ...e.data,
        recognized: remaining,
        status: remaining.length ? "recognized" : visitorId ? "unknown" : "logged",
        unknownFaces: visitorId ? e.data.unknownFaces + (e.data.recognized.length - remaining.length) : 0,
        note: remaining.length ? e.data.note : "Recognition result removed",
      });
    }
  }

  api.delete("/consent", wrap(async (req, res) => {
    const templates = await repo.deleteAllVisitors(uid(req));
    await stripRecognition(uid(req));
    await repo.updateUser(uid(req), { recognitionConsent: null });
    await repo.audit(uid(req), "recognition_consent_revoked", { templatesDeleted: templates });
    await repo.logDeletion(uid(req), "recognition_consent_revoked", { templates });
    res.json({ recognitionConsent: null, templatesDeleted: templates });
  }));

  // ----- enrollment ----------------------------------------------------------------------------
  api.get("/visitors", wrap(async (req, res) => {
    res.json(
      (await repo.visitors(uid(req))).map((v) => ({
        id: v.id,
        name: v.data.name,
        enrolledAt: v.data.enrolledAt,
        consentMethod: v.data.attestation.method,
        source: v.data.source,
      }))
    );
  }));

  api.post("/visitors", wrap(async (req, res) => {
    const userId = uid(req);
    if (!req.user!.data.recognitionConsent) return res.status(403).json({ error: "Turn on facial recognition first." });
    const name = str(req.body?.name, 80).trim();
    const method = str(req.body?.method, 40).trim();
    if (!name) return res.status(400).json({ error: "Enter the person's name." });
    if (req.body?.attest !== true || !["in person", "in writing", "by message", "this is me"].includes(method)) {
      return res.status(400).json({ error: "Confirm that this person agreed to be enrolled, and how they agreed." });
    }
    let image: Buffer | null = null;
    let source: "upload" | "arrival" = "upload";
    if (typeof req.body?.imageData === "string") {
      const m = /^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/.exec(req.body.imageData);
      if (!m) return res.status(400).json({ error: "Upload a JPEG, PNG or WebP photo." });
      image = Buffer.from(m[2], "base64");
    } else if (typeof req.body?.eventId === "string") {
      const ev = await repo.event(userId, req.body.eventId); // only this user's own arrivals
      if (!ev?.data.snapshotId) return res.status(404).json({ error: "Arrival snapshot not found." });
      image = await repo.snapshot(userId, ev.data.snapshotId);
      source = "arrival";
    }
    if (!image || image.length > 8 * 1024 * 1024) return res.status(400).json({ error: "Add a photo of the person (up to 8 MB)." });

    let result;
    try {
      result = await faces.process(image, { zones: [], embed: true });
    } catch (err) {
      console.error("Enrollment processing failed:", (err as Error).message);
      return res.status(503).json({ error: "Face processing is temporarily unavailable. Please try again." });
    }
    if (!result.decodable) return res.status(400).json({ error: "We couldn't read that image." });
    if (result.faces.length !== 1 || !result.faces[0].embedding) {
      return res.status(422).json({ error: result.faces.length ? "This photo shows more than one face. Use a photo with only this person." : "No face found. Use a clear, front-facing photo." });
    }
    const now = new Date().toISOString();
    // Only the template is stored; the photo itself is discarded after this request.
    const id = await repo.addVisitor(userId, {
      name,
      template: result.faces[0].embedding,
      enrolledAt: now,
      attestation: { method, statement: ENROLLMENT_ATTESTATION, at: now },
      source,
    });
    await repo.audit(userId, "face_enrolled", { visitorId: id, method, source });
    res.status(201).json({ id, name, enrolledAt: now });
  }));

  api.delete("/visitors/:id", wrap(async (req, res) => {
    const id = String(req.params.id);
    if (!(await repo.deleteVisitor(uid(req), id))) return res.status(404).json({ error: "Not found" });
    await stripRecognition(uid(req), id);
    await repo.audit(uid(req), "face_deleted", { visitorId: id });
    await repo.logDeletion(uid(req), "enrolled_face", { templates: 1 });
    res.json({ deleted: true, message: "The face template was permanently deleted." });
  }));

  // ----- transparency + data rights -------------------------------------------------------------
  api.get("/activity", wrap(async (req, res) => {
    res.json((await repo.auditFor(uid(req), 200)).map((a) => ({ at: a.data.at, kind: a.data.kind })));
  }));

  api.get("/export", wrap(async (req, res) => {
    const userId = uid(req);
    await repo.audit(userId, "data_exported", {});
    res.setHeader("Content-Disposition", "attachment; filename=visitor-recognizer-export.json");
    res.json({
      exportedAt: new Date().toISOString(),
      account: { email: req.user!.data.email, createdAt: req.user!.data.createdAt, recognitionConsent: req.user!.data.recognitionConsent },
      ringConnections: (await repo.linksForUser(userId)).map((l) => ({ ringEmail: maskEmail(l.data.email), linkedAt: l.data.linkedAt })),
      devices: (await repo.devicesForUser(userId)).map((d) => ({ name: d.data.name })),
      enrolledPeople: (await repo.visitors(userId)).map((v) => ({ name: v.data.name, enrolledAt: v.data.enrolledAt, consentMethod: v.data.attestation.method })),
      arrivals: (await repo.events(userId, 100_000)).map((e) => eventView(e.id, e.data)),
      activity: (await repo.auditFor(userId, 100_000)).map((a) => a.data),
      note: "Face templates are not included in exports.",
    });
  }));

  api.post("/delete-data", wrap(async (req, res) => {
    if (req.body?.confirm !== "DELETE") return res.status(400).json({ error: "Type DELETE to confirm." });
    const userId = uid(req);
    for (const l of await repo.linksForUser(userId)) processor.cancel({ accountId: l.id });
    const counts = await repo.eraseUserData(userId, false);
    await repo.logDeletion(userId, "all_data", counts);
    await repo.audit(userId, "all_data_deleted", counts);
    res.json({ deleted: true, counts });
  }));

  api.post("/delete-account", wrap(async (req, res) => {
    if (req.body?.confirm !== "DELETE") return res.status(400).json({ error: "Type DELETE to confirm." });
    const userId = uid(req);
    if (!(await verifyPassword(str(req.body?.password, 200), req.user!.data.passwordHash))) {
      return res.status(401).json({ error: "Password is incorrect." });
    }
    for (const l of await repo.linksForUser(userId)) processor.cancel({ accountId: l.id });
    const counts = await repo.eraseUserData(userId, true);
    await repo.logDeletion(userId, "account", counts);
    clearCookie(req, res, SESSION_COOKIE);
    res.json({ deleted: true, counts });
  }));

  app.use("/api", api);

  // ---------------------------------------------------------------------------------------------
  // Operator-only status (no personal data). Bearer ADMIN_TOKEN.
  // ---------------------------------------------------------------------------------------------
  app.get("/ops/status", async (req, res) => {
    const supplied = (req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
    if (!CONFIG.ADMIN_TOKEN || !supplied || !safeEqual(sha256Hex(supplied), sha256Hex(CONFIG.ADMIN_TOKEN))) {
      return res.status(401).json({ error: "unauthorized" });
    }
    res.json({
      storage: store.kind,
      encryptionAtRest: encryptionEnabled(),
      users: await store.count("users"),
      ringLinks: await store.count("ringLinks"),
      unclaimedTokens: await store.count("pendingTokens"),
      queuedEvents: processor.pending,
      retentionDays: CONFIG.RETENTION_DAYS,
    });
  });

  // ---------------------------------------------------------------------------------------------
  // Public website (listing URLs): /, /privacy.html, /terms.html, /support.html, /security.html
  // ---------------------------------------------------------------------------------------------
  const legacy: Record<string, string> = {
    "/ring-visitor-recognizer": "/",
    "/ring-visitor-recognizer/privacy": "/privacy.html",
    "/ring-visitor-recognizer/terms": "/terms.html",
    "/ring-visitor-recognizer/support": "/support.html",
    "/website.html": "/",
    "/privacy": "/privacy.html",
    "/terms": "/terms.html",
    "/support": "/support.html",
    "/security": "/security.html",
  };
  for (const [from, to] of Object.entries(legacy)) app.get(from, (_req, res) => res.redirect(301, to));
  app.use(express.static(path.join(process.cwd(), "public"), { index: "index.html", extensions: ["html"] }));

  app.use((_req, res) => res.status(404).send(messagePage("Page not found", "That page doesn't exist.", { href: "/", label: "Home" })));
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    console.error("Unhandled error:", err.message);
    if (res.headersSent) return;
    if (req.path.startsWith("/api/")) return res.status(500).json({ error: "Something went wrong. Please try again." });
    res.status(500).send(messagePage("Something went wrong", "Please try again. If the problem continues, contact support."));
  });

  return { app, repo, tokens, linking, processor, webhooks };
}

export type AppContext = ReturnType<typeof createApp>;
