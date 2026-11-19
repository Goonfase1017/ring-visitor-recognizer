import { HMAC_KEY } from "./env";
import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { Browser, MockRing, hiddenValue, startApp } from "./helpers";
import { computeNonce } from "../src/ring/nonce";
import { signBody } from "../src/ring/signature";
import { completionRetry } from "../src/linking";
import { listDevices, parseRetryAfter, rateLimitDelayMs, rateLimitPolicy } from "../src/ring/api";

const ring = new MockRing();
let app: Awaited<ReturnType<typeof startApp>>;

const mk = (k: string) => ({
  accountId: `ava1.ring.account.${k}`,
  email: `${k.toLowerCase()}@example.com`,
  code: `c-${k}`,
  access: `acc-${k}`,
  refresh: `ref-${k}`,
  devices: [{ id: `ava1.ring.device.${k}1`, name: `${k} Door` }],
  image: "FACES:alice",
});
const P = mk("PAT"); // PATCH-failure account
const Q = mk("QQQ"); // second Ring account for the one-account rule
const W = mk("WWW"); // webhook account
const R = mk("RRR"); // rate-limit account

const sleeps: number[] = [];
before(async () => {
  await ring.start();
  app = await startApp();
  ring.accounts.push(P, Q, W, R);
  completionRetry.delaysMs = [1, 1];
  rateLimitPolicy.sleep = async (ms) => { sleeps.push(ms); };
});
after(async () => {
  await app.close();
  await ring.stop();
});
beforeEach(() => { sleeps.length = 0; ring.failPatch = 0; ring.rateLimits = []; });

async function exchange(acct: typeof P) {
  const r = await fetch(`${app.base}/oauth/token`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: `code=${acct.code}&client_id=test-client` });
  assert.equal(r.status, 200);
}
function linkUrl(acct: typeof P) {
  const time = String(Date.now());
  return `/ring/link?nonce=${computeNonce(time, acct.accountId, HMAC_KEY)}&time=${time}`;
}
const appIntegrationCalls = (acct: typeof P, method: string) =>
  ring.requests.filter((r) => r.path === "/v1/accounts/me/app-integrations" && r.method === method && r.headers.authorization === `Bearer ${acct.access}`);

const pat = new Browser("");

test("AUTH-09: a failed PATCH completed is retried inline; if it still fails no success page and nothing is linked", async () => {
  pat.base = app.base;
  await exchange(P);
  const url = linkUrl(P);
  const page = await pat.get(url);
  ring.failPatch = 99;
  const res = await pat.form("/ring/link/signup", {
    _csrf: hiddenValue(page.text, "_csrf"), nonce: hiddenValue(page.text, "nonce"), time: hiddenValue(page.text, "time"),
    email: "pat.partner@example.com", password: "correct horse battery", agree: "yes",
  });
  assert.equal(res.status, 502);
  assert.doesNotMatch(res.text, /Account linked/);
  assert.match(res.text, /not connected yet/);
  assert.match(res.text, /Try again/);
  assert.equal(appIntegrationCalls(P, "PATCH").length, 3, "1 attempt + 2 inline retries");
  assert.equal(await app.ctx.repo.linkByAccount(P.accountId), null, "link is not treated as complete");
  assert.ok((await app.ctx.repo.pendingTokens()).some((p) => p.id === P.accountId), "token stays unclaimed for a retry");

  // Ring recovers; the customer selects Try again: only the PATCH is repeated, then success.
  ring.failPatch = 0;
  const retry = await pat.form("/ring/link/confirm", {
    _csrf: hiddenValue(res.text, "_csrf"), nonce: hiddenValue(res.text, "nonce"), time: hiddenValue(res.text, "time"),
  });
  assert.equal(retry.status, 200, retry.text);
  assert.match(retry.text, /Account linked successfully/);
  assert.equal(appIntegrationCalls(P, "POST").length, 1, "POST is not repeated after it succeeded");
  const link = await app.ctx.repo.linkByAccount(P.accountId);
  assert.equal(link?.data.integrationStatus, "completed");
  assert.equal((await app.ctx.repo.pendingTokens()).some((p) => p.id === P.accountId), false);

  // UX-07: reopening the link page while signed in shows "Already connected" first.
  const again = await pat.get(url);
  assert.equal(again.status, 200);
  assert.match(again.text, /already connected/i);
  assert.doesNotMatch(again.text, /Connect to this account/);
});

test("AUTH-09: one transient PATCH failure is absorbed by the inline retry", async () => {
  const b = new Browser(app.base);
  await exchange(W);
  const page = await b.get(linkUrl(W));
  ring.failPatch = 1;
  const res = await b.form("/ring/link/signup", {
    _csrf: hiddenValue(page.text, "_csrf"), nonce: hiddenValue(page.text, "nonce"), time: hiddenValue(page.text, "time"),
    email: "will.partner@example.com", password: "correct horse battery", agree: "yes",
  });
  assert.equal(res.status, 200, res.text);
  assert.match(res.text, /Account linked successfully/);
  assert.equal(appIntegrationCalls(W, "PATCH").length, 2);
});

test("POL-10: an account with a Ring account linked cannot link a second, different Ring account", async () => {
  await exchange(Q);
  const url = linkUrl(Q);
  const page = await pat.get(url); // pat is signed in and already holds Ring account P
  assert.equal(page.status, 409);
  assert.match(page.text, /already connected to a different Ring account/);
  assert.match(page.text, /Stop using this Ring account here/);
  assert.doesNotMatch(page.text, /Connect to this account/);

  // Even a direct form post is refused before anything is sent to Ring.
  const u = new URL(app.base + url);
  const res = await pat.form("/ring/link/confirm", { _csrf: hiddenValue(page.text, "_csrf"), nonce: u.searchParams.get("nonce")!, time: u.searchParams.get("time")! });
  assert.equal(res.status, 409);
  assert.doesNotMatch(res.text, /Account linked/);
  assert.equal(appIntegrationCalls(Q, "POST").length, 0);
  assert.equal(await app.ctx.repo.linkByAccount(Q.accountId), null);
  const user = await app.ctx.repo.userByEmail("pat.partner@example.com");
  assert.deepEqual((await app.ctx.repo.linksForUser(user!.id)).map((l) => l.id), [P.accountId]);

  // A different Visitor Recognizer account can link that Ring account.
  const other = new Browser(app.base);
  const p2 = await other.get(url);
  const ok = await other.form("/ring/link/signup", {
    _csrf: hiddenValue(p2.text, "_csrf"), nonce: hiddenValue(p2.text, "nonce"), time: hiddenValue(p2.text, "time"),
    email: "quinn.partner@example.com", password: "correct horse battery", agree: "yes",
  });
  assert.equal(ok.status, 200, ok.text);
  assert.match(ok.text, /Account linked successfully/);
});

test("API-03: Retry-After parsing and exponential backoff with jitter from 1 s", () => {
  assert.equal(parseRetryAfter("3"), 3000);
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter("soon"), null);
  const now = Date.now();
  assert.equal(parseRetryAfter(new Date(now + 5000).toUTCString(), now) !== null, true);
  const rnd = rateLimitPolicy.random;
  try {
    rateLimitPolicy.random = () => 1;
    assert.deepEqual([0, 1, 2, 3].map((a) => rateLimitDelayMs(a, null)), [1000, 2000, 4000, 8000]);
    rateLimitPolicy.random = () => 0;
    assert.deepEqual([0, 1, 2].map((a) => rateLimitDelayMs(a, null)), [500, 1000, 2000]);
    // Retry-After is a floor: never retry sooner than Ring asked
    assert.equal(rateLimitDelayMs(0, "7"), 7000);
    assert.equal(rateLimitDelayMs(5, "1") >= 1000, true);
  } finally {
    rateLimitPolicy.random = rnd;
  }
});

test("API-03: a 429 from Ring is retried honoring Retry-After, then succeeds", async () => {
  ring.rateLimits = [{ path: "/v1/devices", count: 2, retryAfter: "2" }];
  const list = await listDevices(R.access, R.accountId);
  assert.equal(list.length, 1);
  assert.equal(sleeps.length, 2);
  assert.ok(sleeps.every((ms) => ms >= 2000), `waited ${sleeps}`);

  sleeps.length = 0;
  ring.rateLimits = [{ path: "/v1/devices", count: 3 }];
  const rnd = rateLimitPolicy.random;
  rateLimitPolicy.random = () => 1;
  try {
    assert.equal((await listDevices(R.access, R.accountId)).length, 1);
  } finally {
    rateLimitPolicy.random = rnd;
  }
  assert.deepEqual(sleeps, [1000, 2000, 4000], "exponential from 1 s without a hint");

  // Gives up after maxRetries and reports the 429.
  ring.rateLimits = [{ path: "/v1/devices", count: 99 }];
  await assert.rejects(listDevices(R.access, R.accountId), (e: any) => e.status === 429);
});

const webhookEvent = (acct: string, source: string, id: string) => ({
  meta: { version: "1.1", time: new Date().toISOString(), request_id: id, account_id: acct },
  data: { id: `${source}_button_press_${id}`, type: "button_press", attributes: { source, source_type: "devices", timestamp: Date.now() } },
});

test("WH-05: an event that fails mid-processing is not marked processed and is processed on redelivery", async () => {
  const link = await app.ctx.repo.linkByAccount(W.accountId);
  const userId = link!.userId!;
  const repo = app.ctx.repo;
  const original = repo.linkByAccount;
  const before = (await repo.events(userId)).length;
  app.ctx.webhooks.retryDelaysMs = []; // no in-process retry for this part
  let failures = 1;
  repo.linkByAccount = (async (id: string) => {
    if (failures > 0) { failures--; throw new Error("database unavailable"); }
    return original(id);
  }) as typeof repo.linkByAccount;
  try {
    const payload = webhookEvent(W.accountId, W.devices[0].id, "req-fail-1");
    // The HTTP response is still an immediate 200.
    const body = Buffer.from(JSON.stringify(payload));
    const t0 = Date.now();
    const http = await fetch(`${app.base}/ring/webhook`, { method: "POST", headers: { "Content-Type": "application/json", "X-Signature": signBody(body, HMAC_KEY) }, body });
    assert.equal(http.status, 200);
    assert.ok(Date.now() - t0 < 5000);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(await repo.store.get("webhookSeen", "req-fail-1"), null, "failed event is not recorded as seen");

    // Ring redelivers the same request_id: it is processed this time.
    await app.ctx.webhooks.handle(payload);
    await app.ctx.processor.idle();
    assert.equal((await repo.events(userId)).length, before + 1);
    assert.ok(await repo.store.get("webhookSeen", "req-fail-1"), "recorded after success");

    // A further duplicate of a successful event is skipped.
    await app.ctx.webhooks.handle(payload);
    await app.ctx.processor.idle();
    assert.equal((await repo.events(userId)).length, before + 1);
  } finally {
    repo.linkByAccount = original;
  }
});

test("WH-05: a transient failure is retried in the background with backoff", async () => {
  const userId = (await app.ctx.repo.linkByAccount(W.accountId))!.userId!;
  const repo = app.ctx.repo;
  const original = repo.linkByAccount;
  const before = (await repo.events(userId)).length;
  app.ctx.webhooks.retryDelaysMs = [1, 1];
  let failures = 1;
  repo.linkByAccount = (async (id: string) => {
    if (failures > 0) { failures--; throw new Error("database unavailable"); }
    return original(id);
  }) as typeof repo.linkByAccount;
  try {
    await app.ctx.webhooks.handle(webhookEvent(W.accountId, W.devices[0].id, "req-fail-2"));
    await new Promise((r) => setTimeout(r, 20));
    await app.ctx.processor.idle();
  } finally {
    repo.linkByAccount = original;
  }
  assert.equal((await repo.events(userId)).length, before + 1);
  assert.ok(await repo.store.get("webhookSeen", "req-fail-2"));
});
