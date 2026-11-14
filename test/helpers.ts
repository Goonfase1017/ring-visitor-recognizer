import { MOCK_PORT } from "./env";
import http from "http";
import { AddressInfo } from "net";
import { createApp } from "../src/app";
import { FaceEngine, FaceResult } from "../src/face";
import { FileStore } from "../src/storage/fileStore";
import { PgStore } from "../src/storage/pgStore";
import { Store } from "../src/storage";
import { CONFIG } from "../src/config";

/** Fake face engine: the "image" is text such as "FACES:alice,bob" so tests control what is seen. */
export const VECTORS: Record<string, number[]> = {
  alice: [1, 0, 0, 0],
  bob: [0, 1, 0, 0],
  carol: [0, 0, 1, 0],
  stranger: [0, 0, 0, 1],
};
export class FakeFaces implements FaceEngine {
  calls: { embed: boolean }[] = [];
  async process(image: Buffer, opts: { embed: boolean }): Promise<FaceResult> {
    this.calls.push({ embed: opts.embed });
    const s = image.toString("utf8");
    if (!s.startsWith("FACES:")) return { decodable: false, maskedJpeg: null, faces: [] };
    const names = s.slice(6).split(",").filter(Boolean);
    return {
      decodable: true,
      maskedJpeg: image,
      faces: names.map((n) => ({ box: [0, 0, 10, 10], embedding: opts.embed ? VECTORS[n] ?? [0.5, 0.5, 0.5, 0.5] : null })),
    };
  }
}

export interface RingAccount {
  accountId: string;
  email: string;
  code: string;
  access: string;
  refresh: string;
  devices: { id: string; name: string; e2ee?: boolean; state?: string }[];
  /** Snapshot body served for this account's devices */
  image: string;
}

/** Local stand-in for oauth.ring.com + api.amazonvision.com that records every request. */
export class MockRing {
  requests: { method: string; path: string; headers: http.IncomingHttpHeaders; body: string }[] = [];
  accounts: RingAccount[] = [];
  server!: http.Server;

  byToken(auth?: string) {
    const t = (auth ?? "").replace(/^Bearer /, "");
    return this.accounts.find((a) => a.access === t);
  }

  start() {
    this.server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        const url = new URL(req.url ?? "/", "http://x");
        this.requests.push({ method: req.method ?? "", path: url.pathname, headers: req.headers, body });
        const json = (status: number, v: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(v)); };
        if (url.pathname === "/oauth/token") {
          const f = new URLSearchParams(body);
          if (f.get("client_id") !== "test-client" || f.get("client_secret") !== "test-secret") return json(401, { error: "invalid_client" });
          if (f.get("grant_type") === "authorization_code") {
            const a = this.accounts.find((x) => x.code === f.get("code"));
            if (!a) return json(400, { error: "invalid_grant" });
            a.code = `used-${a.code}`; // single use
            return json(200, { access_token: a.access, refresh_token: a.refresh, expires_in: 14400, token_type: "Bearer", scope: "ava.devices" });
          }
          if (f.get("grant_type") === "refresh_token") {
            const a = this.accounts.find((x) => x.refresh === f.get("refresh_token"));
            if (!a) return json(400, { error: "invalid_grant" });
            a.access = `${a.access}-r`;
            a.refresh = `${a.refresh}-r`;
            return json(200, { access_token: a.access, refresh_token: a.refresh, expires_in: 14400, token_type: "Bearer" });
          }
          return json(400, { error: "unsupported_grant_type" });
        }
        if (url.pathname === "/download/img") {
          const a = this.accounts.find((x) => x.accountId === url.searchParams.get("acct"));
          res.writeHead(200, { "Content-Type": "image/jpeg" });
          return res.end(a?.image ?? "");
        }
        const a = this.byToken(req.headers.authorization);
        if (!a) return json(401, { errors: [{ status: "401", code: "UNAUTHORIZED" }] });
        if (url.pathname === "/v1/users/me") return json(200, { data: { type: "users", id: a.accountId, attributes: { email: a.email, first_name: "T" } } });
        if (url.pathname === "/v1/accounts/me/app-integrations" && req.method === "POST") {
          return json(200, { data: { type: "app-integrations", id: "ava1.ring.client.x", attributes: { status: "awaiting" } }, meta: {} });
        }
        if (url.pathname === "/v1/accounts/me/app-integrations" && req.method === "PATCH") {
          return json(200, { data: { type: "app-integrations", id: "ava1.ring.client.x", attributes: { status: JSON.parse(body).status } }, meta: {} });
        }
        if (url.pathname === "/v1/devices") {
          return json(200, {
            data: a.devices.map((d) => ({
              type: "devices", id: d.id, attributes: { name: d.name },
              relationships: {
                status: { data: { type: "device-status", id: `${d.id}.status` } },
                configurations: { data: { type: "device-configurations", id: `${d.id}.conf` } },
                capabilities: { data: { type: "device-capabilities", id: `${d.id}.caps` } },
                location: { data: { type: "locations", id: `${d.id}.loc` } },
              },
            })),
            included: a.devices.flatMap((d) => [
              { type: "device-status", id: `${d.id}.status`, attributes: { online: true } },
              { type: "device-configurations", id: `${d.id}.conf`, attributes: { e2e_encryption: { enabled: Boolean(d.e2ee) }, image_enhancements: { privacy_zones: [] } } },
              { type: "device-capabilities", id: `${d.id}.caps`, attributes: { button_press: {} } },
              { type: "locations", id: `${d.id}.loc`, attributes: { country: "US", state: d.state ?? "CA" } },
            ]),
          });
        }
        const m = /^\/v1\/devices\/([^/]+)\/media\/image\/download$/.exec(url.pathname);
        if (m && req.method === "POST") {
          res.writeHead(303, { Location: `http://127.0.0.1:${MOCK_PORT}/download/img?acct=${encodeURIComponent(a.accountId)}` });
          return res.end();
        }
        json(404, { errors: [{ status: "404" }] });
      });
    });
    return new Promise<void>((r) => this.server.listen(MOCK_PORT, "127.0.0.1", () => r()));
  }
  stop() {
    return new Promise<void>((r) => this.server.close(() => r()));
  }
}

/** FileStore by default; set TEST_DATABASE_URL to run the same suite against Postgres. */
export async function makeStore(): Promise<Store> {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    const s = new FileStore(CONFIG.DATA_DIR);
    await s.init();
    return s;
  }
  const s = new PgStore(url, false);
  await s.init();
  const { Client } = await import("pg");
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query("truncate vr_docs; truncate vr_blobs;");
  await c.end();
  return s;
}

export async function startApp() {
  const store = await makeStore();
  const faces = new FakeFaces();
  const ctx = createApp({ store, faces });
  const server = await new Promise<http.Server>((r) => { const s = ctx.app.listen(0, "127.0.0.1", () => r(s)); });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { ctx, store, faces, server, base, close: async () => { await new Promise<void>((r) => server.close(() => r())); await store.close(); } };
}

/** Minimal cookie-jar browser for form flows. */
export class Browser {
  cookies = new Map<string, string>();
  constructor(public base: string) {}
  private absorb(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const [pair] = c.split(";");
      const i = pair.indexOf("=");
      const v = pair.slice(i + 1);
      if (/Max-Age=0/.test(c) || !v) this.cookies.delete(pair.slice(0, i));
      else this.cookies.set(pair.slice(0, i), decodeURIComponent(v));
    }
  }
  private cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; ");
  }
  async get(p: string) {
    const res = await fetch(this.base + p, { headers: { cookie: this.cookieHeader() }, redirect: "manual" });
    this.absorb(res);
    return { status: res.status, text: await res.text(), headers: res.headers };
  }
  async form(p: string, fields: Record<string, string>) {
    const res = await fetch(this.base + p, {
      method: "POST",
      redirect: "manual",
      headers: { cookie: this.cookieHeader(), "Content-Type": "application/x-www-form-urlencoded", Origin: this.base },
      body: new URLSearchParams(fields).toString(),
    });
    this.absorb(res);
    return { status: res.status, text: await res.text(), headers: res.headers };
  }
  csrf?: string;
  async api(method: string, p: string, body?: unknown) {
    if (!this.csrf) {
      const me = await fetch(this.base + "/api/me", { headers: { cookie: this.cookieHeader() } });
      this.csrf = (await me.json()).csrf;
    }
    const res = await fetch(this.base + "/api" + p, {
      method,
      headers: { cookie: this.cookieHeader(), "Content-Type": "application/json", "X-CSRF-Token": this.csrf ?? "", Origin: this.base },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* binary */ }
    return { status: res.status, json, text };
  }
}

export const hiddenValue = (html: string, name: string) => new RegExp(`name="${name}" value="([^"]*)"`).exec(html)?.[1] ?? "";
