import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { signBody, verifyWebhookSignature } from "../src/ring/signature";

test("webhook signature is sha256=<hex HMAC of raw body>", () => {
  const body = Buffer.from('{"a":1}');
  // python: hmac.new(b"test-hmac-key", b'{"a":1}', hashlib.sha256).hexdigest()
  assert.equal(signBody(body, "test-hmac-key"), "sha256=e14175543a97b7777733abfb3f75816d72e0c18d8ed888b2f172fc2f823d4d33");
  assert.ok(verifyWebhookSignature(body, "sha256=e14175543a97b7777733abfb3f75816d72e0c18d8ed888b2f172fc2f823d4d33", "test-hmac-key"));
  assert.ok(verifyWebhookSignature(body, "e14175543a97b7777733abfb3f75816d72e0c18d8ed888b2f172fc2f823d4d33", "test-hmac-key"));
});

test("webhook signature rejects tampering, wrong key, re-serialised JSON, and junk", () => {
  const body = Buffer.from('{"a": 1}');
  const sig = signBody(body, "k");
  assert.ok(verifyWebhookSignature(body, sig, "k"));
  assert.ok(!verifyWebhookSignature(Buffer.from('{"a":1}'), sig, "k"));
  assert.ok(!verifyWebhookSignature(body, sig, "k2"));
  assert.ok(!verifyWebhookSignature(body, undefined, "k"));
  assert.ok(!verifyWebhookSignature(body, "sha256=zz", "k"));
  assert.ok(!verifyWebhookSignature(body, sig, ""));
});
