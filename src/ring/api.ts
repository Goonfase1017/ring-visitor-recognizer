import { CONFIG } from "../config";
import { hardwareId } from "../secure";

/** Thin client for the official Ring OAuth endpoint and Amazon Vision API. */
export class RingApiError extends Error {
  constructor(public status: number, message: string, public body?: string) {
    super(message);
  }
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type?: string;
  scope?: string;
}

export interface RingUser {
  accountId: string;
  email: string;
  firstName?: string;
}

export interface RingDeviceInfo {
  deviceId: string;
  name: string;
  online: boolean | null;
  e2ee: boolean;
  privacyZones: { x: number; y: number }[][];
  state: string | null;
  isDoorbell: boolean;
  componentIds: string[];
}

function headers(accountId: string | undefined, extra: Record<string, string> = {}) {
  return {
    "User-Agent": CONFIG.RING_USER_AGENT,
    Hardware_Id: hardwareId(accountId),
    Accept: "application/json",
    ...extra,
  };
}

async function call(url: string, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(init.timeoutMs ?? CONFIG.RING_HTTP_TIMEOUT_MS) });
  return res;
}

async function expectOk(res: Response, what: string) {
  if (res.ok) return;
  const body = await res.text().catch(() => "");
  throw new RingApiError(res.status, `${what} failed with HTTP ${res.status}`, body.slice(0, 500));
}

async function tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
  const res = await call(CONFIG.RING_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: headers(undefined, { "Content-Type": "application/x-www-form-urlencoded" }),
    body: new URLSearchParams(form).toString(),
  });
  await expectOk(res, `token request (${form.grant_type})`);
  const json = (await res.json()) as TokenResponse;
  if (!json.access_token || !json.refresh_token) throw new RingApiError(502, "token response missing tokens");
  return json;
}

export const exchangeCode = (code: string) =>
  tokenRequest({
    grant_type: "authorization_code",
    client_id: CONFIG.RING_CLIENT_ID,
    client_secret: CONFIG.RING_CLIENT_SECRET,
    code,
  });

/** Each refresh returns a new refresh token and invalidates the old one: callers must persist it. */
export const refreshTokens = (refreshToken: string) =>
  tokenRequest({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: CONFIG.RING_CLIENT_ID,
    client_secret: CONFIG.RING_CLIENT_SECRET,
  });

export async function getMe(accessToken: string, accountIdHint?: string): Promise<RingUser> {
  const res = await call(`${CONFIG.RING_API_BASE}/v1/users/me`, {
    headers: headers(accountIdHint, { Authorization: `Bearer ${accessToken}` }),
  });
  await expectOk(res, "GET /v1/users/me");
  const json = (await res.json()) as any;
  const accountId = json?.data?.id;
  if (typeof accountId !== "string" || !accountId) throw new RingApiError(502, "users/me response missing data.id");
  return {
    accountId,
    email: String(json?.data?.attributes?.email ?? ""),
    firstName: json?.data?.attributes?.first_name,
  };
}

export async function confirmIntegration(accessToken: string, accountId: string, nonce: string, accountIdentifier: string) {
  const res = await call(`${CONFIG.RING_API_BASE}/v1/accounts/me/app-integrations`, {
    method: "POST",
    headers: headers(accountId, { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }),
    body: JSON.stringify({ account_identifier: accountIdentifier, nonce }),
  });
  await expectOk(res, "POST /v1/accounts/me/app-integrations");
  const json = (await res.json().catch(() => ({}))) as any;
  return String(json?.data?.attributes?.status ?? "awaiting");
}

export async function setIntegrationStatus(accessToken: string, accountId: string, status: "completed" | "awaiting", accountIdentifier?: string) {
  const res = await call(`${CONFIG.RING_API_BASE}/v1/accounts/me/app-integrations`, {
    method: "PATCH",
    headers: headers(accountId, { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }),
    body: JSON.stringify(accountIdentifier ? { account_identifier: accountIdentifier, status } : { status }),
  });
  await expectOk(res, "PATCH /v1/accounts/me/app-integrations");
  const json = (await res.json().catch(() => ({}))) as any;
  return String(json?.data?.attributes?.status ?? status);
}

export async function listDevices(accessToken: string, accountId: string): Promise<RingDeviceInfo[]> {
  const res = await call(`${CONFIG.RING_API_BASE}/v1/devices?include=status,configurations,capabilities,location`, {
    headers: headers(accountId, { Authorization: `Bearer ${accessToken}` }),
  });
  await expectOk(res, "GET /v1/devices");
  const json = (await res.json()) as any;
  const included = new Map<string, any>();
  for (const inc of Array.isArray(json?.included) ? json.included : []) included.set(`${inc.type}|${inc.id}`, inc.attributes ?? {});
  const rel = (d: any, name: string) => {
    const r = d?.relationships?.[name]?.data;
    return r ? included.get(`${r.type}|${r.id}`) : undefined;
  };
  return (Array.isArray(json?.data) ? json.data : []).map((d: any) => {
    const status = rel(d, "status");
    const conf = rel(d, "configurations");
    const caps = rel(d, "capabilities");
    const loc = rel(d, "location");
    const zones = conf?.image_enhancements?.privacy_zones;
    const items = caps?.components?.items;
    return {
      deviceId: String(d.id),
      name: String(d?.attributes?.name ?? "Camera"),
      online: typeof status?.online === "boolean" ? status.online : null,
      e2ee: conf?.e2e_encryption?.enabled === true,
      privacyZones: Array.isArray(zones) ? zones.map((z: any) => (Array.isArray(z?.vertices) ? z.vertices : [])) : [],
      state: loc?.country === "US" && typeof loc?.state === "string" ? loc.state.toUpperCase() : null,
      isDoorbell: Boolean(caps?.button_press),
      componentIds: Array.isArray(items) ? items.map((i: any) => String(i?.component_id ?? i?.id)).filter(Boolean) : [],
    } satisfies RingDeviceInfo;
  });
}

export type SnapshotResult =
  | { ok: true; bytes: Buffer; contentType: string }
  | { ok: false; status: number; retryable: boolean; code?: string };

/** POST /media/image/download (303 → pre-signed URL; fetch follows it) for the frame at `timestampMs`. */
export async function downloadSnapshot(
  accessToken: string,
  accountId: string,
  deviceId: string,
  timestampMs: number,
  componentId?: string
): Promise<SnapshotResult> {
  const body: Record<string, unknown> = {
    type: "at_timestamp",
    timestamp: Math.min(timestampMs, Date.now()),
    image_options: { format: "jpeg" }, // full resolution keeps Ring's watermark small
  };
  if (componentId) body.components = [{ component_id: componentId }];
  const res = await call(`${CONFIG.RING_API_BASE}/v1/devices/${encodeURIComponent(deviceId)}/media/image/download`, {
    method: "POST",
    headers: headers(accountId, { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" }),
    body: JSON.stringify(body),
    redirect: "follow",
    timeoutMs: 20_000,
  });
  if (res.status === 401) throw new RingApiError(401, "snapshot request unauthorized");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let code: string | undefined;
    try { code = JSON.parse(text)?.errors?.[0]?.code; } catch { /* not json */ }
    return { ok: false, status: res.status, code, retryable: [425, 416, 500, 503, 429].includes(res.status) };
  }
  return { ok: true, bytes: Buffer.from(await res.arrayBuffer()), contentType: res.headers.get("content-type") ?? "" };
}
