import { randomUUID } from "crypto";
import { CONFIG } from "./config";
import { blindIndex, sha256Hex } from "./secure";
import { Store, StoredDoc } from "./storage";

// ---------------------------------------------------------------------------
// Data model. Every record that belongs to a customer carries their partner userId, and every
// read below filters on it: there is no API that returns another user's visitors, templates,
// events, snapshots or audit records.
// ---------------------------------------------------------------------------
export interface RecognitionConsent {
  grantedAt: string;
  version: string;
}
export interface User {
  email: string;
  passwordHash: string;
  createdAt: string;
  recognitionConsent: RecognitionConsent | null;
  tutorialDone: boolean;
  lastSignInAt?: string;
}
export interface Session {
  csrf: string;
  expiresAt: number;
}
export interface RingTokens {
  accountId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email: string;
  scope?: string;
}
export interface PendingToken extends RingTokens {
  receivedAt: number;
  /** Partner user for whom Ring already accepted the POST app-integrations (only the PATCH is left). */
  confirmedBy?: string;
}
export interface RingLink extends RingTokens {
  linkedAt: string;
  refreshedAt: number;
  status: "active" | "needs_relink";
  integrationStatus: "awaiting" | "completed";
  subscription?: { type: string; subType?: string; at: string };
}
export interface Device {
  accountId: string;
  deviceId: string;
  name: string;
  online: boolean | null;
  e2ee: boolean;
  privacyZones: { x: number; y: number }[][];
  state: string | null;
  isDoorbell: boolean;
  componentIds: string[];
  updatedAt: string;
}
export interface Visitor {
  name: string;
  template: number[];
  enrolledAt: string;
  attestation: { method: string; statement: string; at: string };
  source: "upload" | "arrival";
}
export type EventStatus =
  | "recognized" // at least one enrolled person matched
  | "unknown" // faces seen, none enrolled (shown as "Unknown")
  | "no_face"
  | "logged" // recognition off or not available: arrival logged with snapshot only
  | "encrypted" // TAKE/E2EE: video unreadable by partner apps
  | "unavailable"; // snapshot could not be retrieved
export interface ArrivalEvent {
  accountId: string;
  deviceId: string;
  deviceName: string;
  kind: "button_press" | "motion_detected";
  subType?: string;
  at: string;
  status: EventStatus;
  recognized: { visitorId: string; name: string; score: number }[];
  unknownFaces: number;
  snapshotId?: string;
  note?: string;
}
export interface AuditEntry {
  at: string;
  kind: string;
  detail?: Record<string, unknown>;
}

export const RECOGNITION_CONSENT_VERSION = "2026-11-14";

export class Repo {
  constructor(public store: Store) {}

  // ----- users -------------------------------------------------------------
  emailKey = (email: string) => blindIndex(`email:${email.trim().toLowerCase()}`);

  async createUser(email: string, passwordHash: string): Promise<StoredDoc<User>> {
    const id = randomUUID();
    const data: User = {
      email: email.trim().toLowerCase(),
      passwordHash,
      createdAt: new Date().toISOString(),
      recognitionConsent: null,
      tutorialDone: false,
      lastSignInAt: new Date().toISOString(),
    };
    await this.store.put("users", id, { userId: id, lookup: this.emailKey(email), createdAt: Date.now() }, data);
    return { id, userId: id, lookup: this.emailKey(email), createdAt: Date.now(), data };
  }
  async userByEmail(email: string) {
    return (await this.store.find<User>("users", { lookup: this.emailKey(email) }, 1))[0] ?? null;
  }
  userById = (id: string) => this.store.get<User>("users", id);
  async updateUser(id: string, patch: Partial<User>) {
    const u = await this.userById(id);
    if (!u) return null;
    const data = { ...u.data, ...patch };
    await this.store.put("users", id, { userId: id, lookup: u.lookup, createdAt: u.createdAt }, data);
    return data;
  }

  // ----- sessions ----------------------------------------------------------
  async createSession(userId: string, token: string, csrf: string) {
    const expiresAt = Date.now() + CONFIG.SESSION_DAYS * 86400_000;
    await this.store.put<Session>("sessions", sha256Hex(token), { userId, createdAt: Date.now() }, { csrf, expiresAt });
    return expiresAt;
  }
  async session(token: string) {
    const s = await this.store.get<Session>("sessions", sha256Hex(token));
    if (!s || s.data.expiresAt < Date.now() || !s.userId) return null;
    return s;
  }
  deleteSession = (token: string) => this.store.delete("sessions", sha256Hex(token));

  // ----- Ring tokens -------------------------------------------------------
  /** Newest pair wins: a re-link replaces any earlier unclaimed pair for the same Ring account. */
  async savePending(t: RingTokens) {
    const data: PendingToken = { ...t, receivedAt: Date.now() };
    await this.store.put("pendingTokens", t.accountId, { userId: null, createdAt: Date.now() }, data);
  }
  async markPendingConfirmed(accountId: string, userId: string) {
    const p = await this.store.get<PendingToken>("pendingTokens", accountId);
    if (!p) return;
    await this.store.put("pendingTokens", accountId, { userId: null, createdAt: p.createdAt }, { ...p.data, confirmedBy: userId });
  }
  pendingTokens = () => this.store.find<PendingToken>("pendingTokens", { userId: null });
  deletePending = (accountId: string) => this.store.delete("pendingTokens", accountId);

  async saveLink(userId: string, link: RingLink) {
    const prev = await this.store.get<RingLink>("ringLinks", link.accountId);
    await this.store.put("ringLinks", link.accountId, { userId, lookup: link.accountId, createdAt: prev?.createdAt ?? Date.now() }, link);
    return prev;
  }
  linkByAccount = (accountId: string) => this.store.get<RingLink>("ringLinks", accountId);
  linksForUser = (userId: string) => this.store.find<RingLink>("ringLinks", { userId });
  allLinks = () => this.store.find<RingLink>("ringLinks", {});
  deleteLink = (accountId: string) => this.store.delete("ringLinks", accountId);

  // ----- devices -----------------------------------------------------------
  private deviceDocId = (userId: string, deviceId: string) => sha256Hex(`${userId}|${deviceId}`);
  async putDevice(userId: string, d: Device) {
    const id = this.deviceDocId(userId, d.deviceId);
    const prev = await this.store.get<Device>("devices", id);
    await this.store.put("devices", id, { userId, lookup: d.accountId, createdAt: prev?.createdAt ?? Date.now() }, d);
  }
  async device(userId: string, deviceId: string) {
    const d = await this.store.get<Device>("devices", this.deviceDocId(userId, deviceId));
    return d && d.userId === userId ? d : null;
  }
  devicesForUser = (userId: string) => this.store.find<Device>("devices", { userId });
  deleteDevice = (userId: string, deviceId: string) => this.store.delete("devices", this.deviceDocId(userId, deviceId));
  async deleteDevicesForAccount(userId: string, accountId: string) {
    let n = 0;
    for (const d of await this.store.find<Device>("devices", { userId, lookup: accountId })) {
      await this.store.delete("devices", d.id);
      n++;
    }
    return n;
  }

  // ----- enrolled visitors (face templates) --------------------------------
  async addVisitor(userId: string, v: Visitor) {
    const id = randomUUID();
    await this.store.put("visitors", id, { userId, createdAt: Date.now() }, v);
    return id;
  }
  visitors = (userId: string) => this.store.find<Visitor>("visitors", { userId });
  async deleteVisitor(userId: string, id: string) {
    const v = await this.store.get<Visitor>("visitors", id);
    if (!v || v.userId !== userId) return false; // never touch another user's record
    return this.store.delete("visitors", id);
  }
  deleteAllVisitors = (userId: string) => this.store.deleteWhere("visitors", { userId });

  // ----- events + snapshots -------------------------------------------------
  async addEvent(userId: string, e: ArrivalEvent) {
    const id = randomUUID();
    await this.store.put("events", id, { userId, lookup: e.deviceId, createdAt: Date.parse(e.at) || Date.now() }, e);
    return id;
  }
  events = (userId: string, limit = 200) => this.store.find<ArrivalEvent>("events", { userId }, limit);
  async event(userId: string, id: string) {
    const e = await this.store.get<ArrivalEvent>("events", id);
    return e && e.userId === userId ? e : null;
  }
  async updateEvent(userId: string, id: string, data: ArrivalEvent) {
    const e = await this.event(userId, id);
    if (!e) return;
    await this.store.put("events", id, { userId, lookup: e.lookup, createdAt: e.createdAt }, data);
  }
  async deleteEvent(userId: string, id: string) {
    const e = await this.event(userId, id);
    if (!e) return false;
    if (e.data.snapshotId) await this.store.deleteBlob(e.data.snapshotId);
    return this.store.delete("events", id);
  }
  async deleteEventsForDevice(userId: string, deviceId: string) {
    let n = 0;
    for (const e of await this.store.find<ArrivalEvent>("events", { userId, lookup: deviceId })) {
      if (e.data.snapshotId) await this.store.deleteBlob(e.data.snapshotId);
      await this.store.delete("events", e.id);
      n++;
    }
    return n;
  }
  async putSnapshot(userId: string, bytes: Buffer) {
    const id = randomUUID().replace(/-/g, "");
    await this.store.putBlob(id, userId, bytes);
    return id;
  }
  snapshot = (userId: string, id: string) => this.store.getBlob(id, userId);

  // ----- audit (per user, visible to that user) -----------------------------
  async audit(userId: string | null, kind: string, detail?: Record<string, unknown>) {
    try {
      await this.store.put<AuditEntry>("audit", randomUUID(), { userId, createdAt: Date.now() }, {
        at: new Date().toISOString(),
        kind,
        detail,
      });
    } catch (err) {
      console.error("audit write failed", (err as Error).message);
    }
  }
  auditFor = (userId: string, limit = 200) => this.store.find<AuditEntry>("audit", { userId }, limit);

  /** Compliance log of deletion requests (4.1.3). Kept after account deletion, pseudonymised. */
  async logDeletion(userId: string, scope: string, counts: Record<string, number>) {
    await this.store.put("deletionLog", randomUUID(), { userId: null, lookup: blindIndex(`user:${userId}`), createdAt: Date.now() }, {
      at: new Date().toISOString(),
      scope,
      counts,
    });
  }

  // ----- erase --------------------------------------------------------------
  /** Deletes all data held for this user except (optionally) the account itself. */
  async eraseUserData(userId: string, includeAccount: boolean) {
    const counts: Record<string, number> = {};
    counts.visitors = await this.store.deleteWhere("visitors", { userId });
    counts.events = await this.store.deleteWhere("events", { userId });
    counts.snapshots = await this.store.deleteBlobsWhere({ userId });
    counts.devices = await this.store.deleteWhere("devices", { userId });
    counts.ringLinks = await this.store.deleteWhere("ringLinks", { userId });
    counts.activityLog = await this.store.deleteWhere("audit", { userId });
    if (includeAccount) {
      counts.sessions = await this.store.deleteWhere("sessions", { userId });
      counts.account = (await this.store.delete("users", userId)) ? 1 : 0;
    } else {
      await this.updateUser(userId, { recognitionConsent: null });
    }
    return counts;
  }
}
