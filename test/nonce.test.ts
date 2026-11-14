import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkLinkTime, computeNonce, isWellFormedNonce, nonceMatches } from "../src/ring/nonce";

test("nonce matches Ring's reference algorithm (HMAC-SHA256, URL-safe base64, no padding)", () => {
  // Expected value computed with Ring's documented Python:
  // base64.urlsafe_b64encode(hmac.new(key.encode(), f"{time}:{account_id}".encode(), sha256).digest()).rstrip(b"=")
  const n = computeNonce("1771130906289", "ava1.ring.account.XXXYYY", "test-hmac-key");
  assert.equal(n, "qexVypp7hnEZKz7jsI96n5DEp_jrbDeSKXSYWP5KHHE");
  assert.match(n, /^[A-Za-z0-9_-]+$/);
  assert.ok(!n.includes("="));
  assert.ok(isWellFormedNonce(n));
});

test("nonce comparison is exact and bound to time and account", () => {
  const n = computeNonce("1771130906289", "acct-1", "k");
  assert.ok(nonceMatches(n, "1771130906289", "acct-1", "k"));
  assert.ok(!nonceMatches(n, "1771130906290", "acct-1", "k"));
  assert.ok(!nonceMatches(n, "1771130906289", "acct-2", "k"));
  assert.ok(!nonceMatches(n, "1771130906289", "acct-1", "other"));
  assert.ok(!nonceMatches(n.slice(0, -1), "1771130906289", "acct-1", "k"));
});

test("link time freshness: milliseconds, 600 s window, nothing from the future", () => {
  const now = 1_800_000_000_000;
  assert.deepEqual(checkLinkTime(String(now - 599_000), now), { ok: true, timeMs: now - 599_000 });
  assert.deepEqual(checkLinkTime(String(now - 600_000), now), { ok: true, timeMs: now - 600_000 });
  assert.deepEqual(checkLinkTime(String(now - 601_000), now), { ok: false, reason: "expired" });
  assert.deepEqual(checkLinkTime(String(now + 1000), now), { ok: false, reason: "future" });
  assert.deepEqual(checkLinkTime("abc", now), { ok: false, reason: "invalid" });
  assert.deepEqual(checkLinkTime(undefined, now), { ok: false, reason: "invalid" });
  // seconds instead of ms looks 50 years old -> expired, never accepted
  assert.equal(checkLinkTime(String(Math.floor(now / 1000)), now).ok, false);
});
