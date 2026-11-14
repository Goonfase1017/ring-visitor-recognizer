import "./env";
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import path from "path";
import { MockRing, startApp } from "./helpers";
import { CONFIG } from "../src/config";

const ring = new MockRing();
let app: Awaited<ReturnType<typeof startApp>>;

before(async () => {
  await ring.start();
  app = await startApp();
  ring.accounts.push(
    { accountId: "ava1.ring.account.A", email: "alice.owner@example.com", code: "code-A", access: "access-A", refresh: "refresh-A", devices: [], image: "" },
    { accountId: "ava1.ring.account.J", email: "json.owner@example.com", code: "code-J", access: "access-J", refresh: "refresh-J", devices: [], image: "" }
  );
});
after(async () => {
  await app.close();
  await ring.stop();
});

const post = (body: string, type = "application/x-www-form-urlencoded") =>
  fetch(`${app.base}/oauth/token`, { method: "POST", headers: { "Content-Type": type }, body });

test("form-encoded code from Ring: exchange, users/me, store unclaimed, then 200", async () => {
  const res = await post("code=code-A&client_id=test-client");
  assert.equal(res.status, 200);

  const tokenCall = ring.requests.find((r) => r.path === "/oauth/token")!;
  const form = new URLSearchParams(tokenCall.body);
  assert.equal(tokenCall.headers["content-type"], "application/x-www-form-urlencoded");
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("code"), "code-A");
  assert.equal(form.get("client_id"), "test-client");
  assert.equal(form.get("client_secret"), "test-secret");

  const me = ring.requests.find((r) => r.path === "/v1/users/me")!;
  assert.equal(me.headers.authorization, "Bearer access-A");
  for (const r of [tokenCall, me]) {
    assert.equal(r.headers["user-agent"], "VisitorRecognizer/1.0");
    assert.match(String(r.headers["hardware_id"]), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  }

  const pending = await app.ctx.repo.pendingTokens();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].data.accountId, "ava1.ring.account.A");
  assert.equal(pending[0].userId, null);
  assert.equal(pending[0].data.refreshToken, "refresh-A");

  // encrypted at rest: tokens and email never appear in the data file
  let raw: Buffer;
  if (app.store.kind === "file") {
    await (app.store as any).writing;
    raw = readFileSync(path.join(CONFIG.DATA_DIR, "store.enc"));
  } else {
    const { Client } = await import("pg");
    const c = new Client({ connectionString: process.env.TEST_DATABASE_URL });
    await c.connect();
    const r = await c.query("select string_agg(encode(data, 'escape'), '') as all from vr_docs");
    await c.end();
    raw = Buffer.from(String(r.rows[0].all ?? ""));
  }
  assert.ok(raw.length > 0);
  assert.ok(!raw.includes("access-A") && !raw.includes("refresh-A") && !raw.includes("alice.owner"));
});

test("duplicate delivery of the same code is idempotent (no second exchange)", async () => {
  const before = ring.requests.filter((r) => r.path === "/oauth/token").length;
  const res = await post("code=code-A&client_id=test-client");
  assert.equal(res.status, 200);
  assert.equal(ring.requests.filter((r) => r.path === "/oauth/token").length, before);
});

test("JSON body is also accepted", async () => {
  const res = await post(JSON.stringify({ code: "code-J", client_id: "test-client" }), "application/json");
  assert.equal(res.status, 200);
  assert.ok((await app.ctx.repo.pendingTokens()).some((p) => p.data.accountId === "ava1.ring.account.J"));
});

test("failures return non-2xx and store nothing", async () => {
  const n = (await app.ctx.repo.pendingTokens()).length;
  assert.equal((await post("code=bogus&client_id=test-client")).status, 502);
  assert.equal((await post("client_id=test-client")).status, 400);
  assert.equal((await post("code=x&client_id=someone-else")).status, 400);
  assert.equal((await app.ctx.repo.pendingTokens()).length, n);
});

test("unclaimed tokens older than 15 minutes are cleaned up", async () => {
  const p = (await app.ctx.repo.pendingTokens())[0];
  await app.store.put("pendingTokens", p.id, { userId: null, createdAt: p.createdAt }, { ...p.data, receivedAt: Date.now() - 16 * 60_000 });
  const removed = await app.ctx.linking.cleanupPending();
  assert.equal(removed, 1);
  assert.equal(await app.ctx.repo.store.get("pendingTokens", p.id), null);
});
