import "./env";
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStore } from "./helpers";

test(`storage backend contract (${process.env.TEST_DATABASE_URL ? "postgres" : "file"})`, async () => {
  const s = await makeStore();
  await s.put("visitors", "v1", { userId: "u1", createdAt: 1000 }, { name: "A", template: [1, 2] });
  await s.put("visitors", "v2", { userId: "u2", createdAt: 2000 }, { name: "B", template: [3] });
  await s.put("pendingTokens", "acct", { userId: null, createdAt: 3000 }, { t: 1 });
  await s.put("users", "u1", { userId: "u1", lookup: "idx-1", createdAt: 1 }, { email: "x" });

  assert.deepEqual((await s.get<any>("visitors", "v1"))?.data, { name: "A", template: [1, 2] });
  assert.deepEqual((await s.find("visitors", { userId: "u1" })).map((d) => d.id), ["v1"]);
  assert.deepEqual((await s.find("visitors", {})).map((d) => d.id), ["v2", "v1"]); // newest first
  assert.deepEqual((await s.find("pendingTokens", { userId: null })).map((d) => d.id), ["acct"]);
  assert.equal((await s.find("users", { lookup: "idx-1" }))[0].id, "u1");
  assert.equal(await s.count("visitors", { createdBefore: 1500 }), 1);

  // upsert keeps one row
  await s.put("visitors", "v1", { userId: "u1", createdAt: 1000 }, { name: "A2", template: [] });
  assert.equal(await s.count("visitors", { userId: "u1" }), 1);
  assert.equal((await s.get<any>("visitors", "v1"))?.data.name, "A2");

  await s.putBlob("blob0001aaaa", "u1", Buffer.from("jpeg-bytes"));
  assert.equal((await s.getBlob("blob0001aaaa", "u1"))?.toString(), "jpeg-bytes");
  assert.equal(await s.getBlob("blob0001aaaa", "u2"), null, "blobs are owner-scoped");
  assert.equal(await s.deleteBlobsWhere({ userId: "u2" }), 0);
  assert.equal(await s.deleteBlobsWhere({ userId: "u1" }), 1);
  assert.equal(await s.getBlob("blob0001aaaa", "u1"), null);

  assert.equal(await s.deleteWhere("visitors", { userId: "u2" }), 1);
  assert.equal(await s.delete("visitors", "v1"), true);
  assert.equal(await s.delete("visitors", "v1"), false);
  assert.equal(await s.count("visitors"), 0);
  await s.close();
});
