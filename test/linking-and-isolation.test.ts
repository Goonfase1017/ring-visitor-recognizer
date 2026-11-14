import { HMAC_KEY } from "./env";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { Browser, MockRing, hiddenValue, startApp } from "./helpers";
import { computeNonce } from "../src/ring/nonce";
import { signBody } from "../src/ring/signature";

const ring = new MockRing();
let app: Awaited<ReturnType<typeof startApp>>;

const A = { accountId: "ava1.ring.account.AAA", email: "ann@example.com", code: "c-ann", access: "acc-ann", refresh: "ref-ann", devices: [{ id: "ava1.ring.device.ANN1", name: "Ann Front Door" }], image: "FACES:alice" };
const B = { accountId: "ava1.ring.account.BBB", email: "ben@example.com", code: "c-ben", access: "acc-ben", refresh: "ref-ben", devices: [{ id: "ava1.ring.device.BEN1", name: "Ben Porch" }], image: "FACES:alice" };

before(async () => {
  await ring.start();
  app = await startApp();
  ring.accounts.push(A, B);
});
after(async () => {
  await app.close();
  await ring.stop();
});

async function webhook(payload: unknown, sig?: string) {
  const body = Buffer.from(JSON.stringify(payload));
  return fetch(`${app.base}/ring/webhook`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Signature": sig ?? signBody(body, HMAC_KEY) },
    body,
  });
}
const event = (acct: string, type: string, source: string, extra: Record<string, unknown> = {}) => ({
  meta: { version: "1.1", time: new Date().toISOString(), request_id: `${Math.random()}`, account_id: acct },
  data: { id: `${source}_${type}_${Date.now()}`, type, attributes: { source, source_type: "devices", timestamp: Date.now(), ...extra } },
});

async function linkViaRing(browser: Browser, acct: typeof A, partnerEmail: string) {
  assert.equal((await fetch(`${app.base}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `code=${acct.code}&client_id=test-client` })).status, 200);
  const time = String(Date.now());
  const nonce = computeNonce(time, acct.accountId, HMAC_KEY);
  const page = await browser.get(`/ring/link?nonce=${nonce}&time=${time}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Create your Visitor Recognizer account/);
  assert.match(page.text, /Sign in/);
  // Nothing is matched or claimed before sign-in.
  assert.ok(!ring.requests.some((r) => r.path === "/v1/accounts/me/app-integrations" && r.headers.authorization === `Bearer ${acct.access}`));
  assert.ok((await app.ctx.repo.pendingTokens()).some((p) => p.id === acct.accountId));
  const res = await browser.form("/ring/link/signup", {
    _csrf: hiddenValue(page.text, "_csrf"),
    nonce: hiddenValue(page.text, "nonce"),
    time: hiddenValue(page.text, "time"),
    email: partnerEmail,
    password: "correct horse battery",
    agree: "yes",
  });
  return res;
}

test("account link: sign-up, nonce match, POST then PATCH completed, success page with devices", async () => {
  const ann = new Browser(app.base);
  const res = await linkViaRing(ann, A, "ann.partner@example.com");
  assert.equal(res.status, 200, res.text);
  assert.match(res.text, /Account linked successfully/);
  assert.match(res.text, /Ann Front Door/);
  assert.match(res.text, /Online/);
  assert.ok(!res.text.includes("ava1.ring.device"), "device ids never shown");

  const calls = ring.requests.filter((r) => r.path === "/v1/accounts/me/app-integrations");
  assert.deepEqual(calls.map((c) => c.method), ["POST", "PATCH"]);
  const postBody = JSON.parse(calls[0].body);
  assert.equal(postBody.account_identifier, "a***r@example.com");
  assert.match(postBody.nonce, /^[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(JSON.parse(calls[1].body), { status: "completed" });
  for (const c of calls) {
    assert.equal(c.headers["user-agent"], "VisitorRecognizer/1.0");
    assert.ok(c.headers["hardware_id"]);
  }
  const link = await app.ctx.repo.linkByAccount(A.accountId);
  assert.equal(link?.data.integrationStatus, "completed");
  assert.equal((await app.ctx.repo.pendingTokens()).length, 0);
});

test("link page rejects stale, future and malformed time on GET and POST", async () => {
  const b = new Browser(app.base);
  const old = String(Date.now() - 601_000);
  const r1 = await b.get(`/ring/link?nonce=${computeNonce(old, A.accountId, HMAC_KEY)}&time=${old}`);
  assert.equal(r1.status, 400);
  assert.match(r1.text, /expired/);
  const fut = String(Date.now() + 60_000);
  assert.equal((await b.get(`/ring/link?nonce=${computeNonce(fut, A.accountId, HMAC_KEY)}&time=${fut}`)).status, 400);
  assert.equal((await b.get(`/ring/link?nonce=abc&time=${Date.now()}`)).status, 400);
  // POST with a fresh page but expired time in the form
  const now = String(Date.now());
  const page = await b.get(`/ring/link?nonce=${computeNonce(now, A.accountId, HMAC_KEY)}&time=${now}`);
  const r2 = await b.form("/ring/link/signin", { _csrf: hiddenValue(page.text, "_csrf"), nonce: hiddenValue(page.text, "nonce"), time: old, email: "x@example.com", password: "whatever12" });
  assert.equal(r2.status, 400);
});

test("form posts without the CSRF token are refused", async () => {
  const b = new Browser(app.base);
  const now = String(Date.now());
  await b.get(`/ring/link?nonce=${computeNonce(now, A.accountId, HMAC_KEY)}&time=${now}`);
  const r = await b.form("/ring/link/signup", { nonce: computeNonce(now, A.accountId, HMAC_KEY), time: now, email: "c@example.com", password: "long-enough-pass", agree: "yes" });
  assert.equal(r.status, 403);
});

test("a nonce for no unclaimed token does not link anything", async () => {
  const b = new Browser(app.base);
  const now = String(Date.now());
  const page = await b.get(`/ring/link?nonce=${computeNonce(now, "ava1.ring.account.NOPE", HMAC_KEY)}&time=${now}`);
  const r = await b.form("/ring/link/signup", { _csrf: hiddenValue(page.text, "_csrf"), nonce: hiddenValue(page.text, "nonce"), time: now, email: "nolink@example.com", password: "long-enough-pass", agree: "yes" });
  assert.equal(r.status, 409);
  assert.match(r.text, /couldn&#39;t find the Ring authorization|couldn't find the Ring authorization/);
});

test("per-user isolation: templates, events, snapshots and deletes never cross accounts", async () => {
  const ann = new Browser(app.base);
  await ann.form("/signin", { _csrf: hiddenValue((await ann.get("/signin")).text, "_csrf"), email: "ann.partner@example.com", password: "correct horse battery" });
  const ben = new Browser(app.base);
  assert.equal((await linkViaRing(ben, B, "ben.partner@example.com")).status, 200);

  // Ann turns on recognition and enrolls Alice. Ben does not enroll anyone.
  assert.equal((await ann.api("POST", "/visitors", { name: "Alice", method: "in person", attest: true, imageData: "data:image/jpeg;base64," + Buffer.from("FACES:alice").toString("base64") })).status, 403, "enrollment requires consent");
  assert.equal((await ann.api("POST", "/consent", { agree: false, version: "2026-11-14" })).status, 400);
  assert.equal((await ann.api("POST", "/consent", { agree: true, version: "2026-11-14" })).status, 200);
  assert.equal((await ann.api("POST", "/visitors", { name: "Alice", method: "in person", attest: false, imageData: "data:image/jpeg;base64," + Buffer.from("FACES:alice").toString("base64") })).status, 400, "attestation required");
  assert.equal((await ann.api("POST", "/visitors", { name: "Group", method: "in person", attest: true, imageData: "data:image/jpeg;base64," + Buffer.from("FACES:alice,bob").toString("base64") })).status, 422, "one face only");
  const enrolled = await ann.api("POST", "/visitors", { name: "Alice", method: "in person", attest: true, imageData: "data:image/jpeg;base64," + Buffer.from("FACES:alice").toString("base64") });
  assert.equal(enrolled.status, 201);

  // Alice walks up to BOTH doors.
  assert.equal((await webhook(event(A.accountId, "button_press", A.devices[0].id))).status, 200);
  assert.equal((await webhook(event(B.accountId, "button_press", B.devices[0].id))).status, 200);
  await new Promise((r) => setTimeout(r, 50));
  await app.ctx.processor.idle();

  const annEvents = (await ann.api("GET", "/events")).json;
  const benEvents = (await ben.api("GET", "/events")).json;
  assert.equal(annEvents.length, 1);
  assert.equal(benEvents.length, 1);
  assert.equal(annEvents[0].status, "recognized");
  assert.deepEqual(annEvents[0].recognized.map((r: any) => r.name), ["Alice"]);
  // Ben never enrolled anyone and has no consent: no recognition, no face processing for him.
  assert.equal(benEvents[0].status, "logged");
  assert.deepEqual(benEvents[0].recognized, []);
  assert.equal(benEvents[0].device, "Ben Porch");

  // Ben turns on recognition but enrolls nobody: Alice is still never identified at his door.
  await ben.api("POST", "/consent", { agree: true, version: "2026-11-14" });
  await ben.api("POST", "/visitors", { name: "Carol", method: "in person", attest: true, imageData: "data:image/jpeg;base64," + Buffer.from("FACES:carol").toString("base64") });
  await webhook(event(B.accountId, "button_press", B.devices[0].id));
  await new Promise((r) => setTimeout(r, 50));
  await app.ctx.processor.idle();
  const benLatest = (await ben.api("GET", "/events")).json[0];
  assert.equal(benLatest.status, "unknown");
  assert.equal(benLatest.unknownFaces, 1);

  // Lists are scoped
  assert.deepEqual((await ann.api("GET", "/visitors")).json.map((v: any) => v.name), ["Alice"]);
  assert.deepEqual((await ben.api("GET", "/visitors")).json.map((v: any) => v.name), ["Carol"]);

  // Ben cannot read Ann's snapshot or delete her visitor or event
  const annSnap = annEvents[0].snapshotUrl.replace("/api", "");
  assert.equal((await ann.api("GET", annSnap)).status, 200);
  assert.equal((await ben.api("GET", annSnap)).status, 404);
  assert.equal((await ben.api("DELETE", `/visitors/${enrolled.json.id}`)).status, 404);
  assert.equal((await ben.api("DELETE", `/events/${annEvents[0].id}`)).status, 404);
  assert.equal((await ben.api("POST", "/visitors", { name: "x", method: "in person", attest: true, eventId: annEvents[0].id })).status, 404);
  assert.equal((await ann.api("GET", "/visitors")).json.length, 1);

  // Unauthenticated access is refused
  assert.equal((await fetch(`${app.base}/api/events`)).status, 401);
  // Missing CSRF header is refused
  const noCsrf = await fetch(`${app.base}/api/consent`, { method: "DELETE", headers: { cookie: `vr_session=${ann.cookies.get("vr_session")}` } });
  assert.equal(noCsrf.status, 403);

  // Ann deletes Alice: template gone and her name stripped from past arrivals
  const del = await ann.api("DELETE", `/visitors/${enrolled.json.id}`);
  assert.equal(del.status, 200);
  assert.equal((await ann.api("GET", "/visitors")).json.length, 0);
  const after = (await ann.api("GET", "/events")).json[0];
  assert.deepEqual(after.recognized, []);

  // Revoking consent deletes Ben's templates
  const rev = await ben.api("DELETE", "/consent");
  assert.equal(rev.json.templatesDeleted, 1);
  assert.equal((await ben.api("GET", "/visitors")).json.length, 0);

  // Activity log is per user
  const kinds = (await ann.api("GET", "/activity")).json.map((a: any) => a.kind);
  assert.ok(kinds.includes("face_deleted") && kinds.includes("recognition_consent_granted"));
  assert.ok(!kinds.includes("recognition_consent_revoked"));
});

test("webhook: bad signature 401, dedupe on request_id, device_removed and app_integration_removed", async () => {
  // button_press is always logged (motion within 15 s of a press on the same camera is folded into it)
  const p = event(A.accountId, "button_press", A.devices[0].id);
  assert.equal((await webhook(p, "sha256=" + "0".repeat(64))).status, 401);
  assert.equal((await webhook(p, "")).status, 401);

  const before = (await app.ctx.repo.events((await app.ctx.repo.linkByAccount(A.accountId))!.userId!)).length;
  assert.equal((await webhook(p)).status, 200);
  assert.equal((await webhook(p)).status, 200); // retry of the same request_id
  await new Promise((r) => setTimeout(r, 50));
  await app.ctx.processor.idle();
  const userId = (await app.ctx.repo.linkByAccount(A.accountId))!.userId!;
  assert.equal((await app.ctx.repo.events(userId)).length, before + 1);

  // device_removed: device and its arrivals are cleaned up
  await webhook(event(A.accountId, "device_removed", A.devices[0].id));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await app.ctx.repo.device(userId, A.devices[0].id), null);
  assert.equal((await app.ctx.repo.events(userId)).length, 0);

  // app_integration_removed: tokens deleted, further events ignored
  await webhook({ meta: { version: "1.1", request_id: "rm-1", account_id: A.accountId }, data: { id: "x", type: "app_integration_removed", attributes: { source: A.accountId, source_type: "users", timestamp: Date.now() } } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await app.ctx.repo.linkByAccount(A.accountId), null);
  const n = ring.requests.length;
  await webhook(event(A.accountId, "button_press", A.devices[0].id));
  await new Promise((r) => setTimeout(r, 50));
  await app.ctx.processor.idle();
  assert.equal(ring.requests.length, n, "no Ring calls after removal");
});

test("encrypted (TAKE/E2EE) and unreadable media are logged gracefully", async () => {
  const ben = await app.ctx.repo.linkByAccount(B.accountId);
  const userId = ben!.userId!;
  B.image = "\x00\x01encrypted-bytes";
  await webhook(event(B.accountId, "button_press", B.devices[0].id));
  await new Promise((r) => setTimeout(r, 50));
  await app.ctx.processor.idle();
  const latest = (await app.ctx.repo.events(userId))[0];
  assert.equal(latest.data.status, "encrypted");
  assert.equal(latest.data.snapshotId, undefined);
});

test("token refresh persists the new refresh token (old one is invalidated)", async () => {
  const link = await app.ctx.repo.linkByAccount(B.accountId);
  await app.ctx.tokens.refresh(B.accountId);
  const after = await app.ctx.repo.linkByAccount(B.accountId);
  assert.notEqual(after!.data.refreshToken, link!.data.refreshToken);
  assert.equal(after!.data.refreshToken, B.refresh);
  const form = new URLSearchParams(ring.requests.filter((r) => r.path === "/oauth/token").pop()!.body);
  assert.equal(form.get("grant_type"), "refresh_token");
});

test("delete all my data and delete account", async () => {
  const ben = new Browser(app.base);
  await ben.form("/signin", { _csrf: hiddenValue((await ben.get("/signin")).text, "_csrf"), email: "ben.partner@example.com", password: "correct horse battery" });
  assert.equal((await ben.api("POST", "/delete-data", { confirm: "nope" })).status, 400);
  const r = await ben.api("POST", "/delete-data", { confirm: "DELETE" });
  assert.equal(r.status, 200);
  assert.equal((await ben.api("GET", "/events")).json.length, 0);
  assert.equal(await app.ctx.repo.linkByAccount(B.accountId), null);
  assert.equal((await ben.api("POST", "/delete-account", { confirm: "DELETE", password: "wrong" })).status, 401);
  assert.equal((await ben.api("POST", "/delete-account", { confirm: "DELETE", password: "correct horse battery" })).status, 200);
  assert.equal(await app.ctx.repo.userByEmail("ben.partner@example.com"), null);
  assert.ok((await app.store.count("deletionLog")) >= 2, "deletion requests are logged");
});
