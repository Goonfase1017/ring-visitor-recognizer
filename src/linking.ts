import { CONFIG } from "./config";
import { Repo, RingLink } from "./repo";
import { RingApiError, confirmIntegration, exchangeCode, getMe, listDevices, setIntegrationStatus } from "./ring/api";
import { checkLinkTime, nonceMatches } from "./ring/nonce";
import { TokenManager } from "./ring/tokens";
import { maskEmail, sha256Hex } from "./secure";

export type ClaimResult =
  | { status: "linked"; accountId: string; integrationStatus: string; deviceCount: number | null }
  | { status: "already_linked"; accountId: string }
  | { status: "expired" }
  | { status: "no_match" }
  | { status: "other_ring_account_linked" }
  | { status: "completion_failed"; httpStatus: number }
  | { status: "ring_error"; httpStatus: number };

export type LinkPageState =
  | { status: "already_linked"; accountId: string }
  | { status: "other_ring_account_linked" }
  | { status: "ready" };

/** Inline retry schedule for the final PATCH status=completed (exported so tests can shorten it). */
export const completionRetry = {
  delaysMs: [500, 1500],
  sleep: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
  random: Math.random,
};

/**
 * One-way account linking (Ring Partner API "Token Exchange Flow" + "Nonce Validation" steps 1-7).
 */
export class Linking {
  /** code hash -> outcome, so a duplicate delivery of the same code is answered without a second exchange. */
  private codes = new Map<string, { at: number; p: Promise<string> }>();

  constructor(private repo: Repo, private tokens: TokenManager) {}

  /**
   * Token Exchange URL handler body: exchange code -> GET /v1/users/me -> store as UNCLAIMED.
   * Resolves only when all three succeeded; any failure rejects (caller returns non-2xx).
   */
  handleAuthorizationCode(code: string): Promise<string> {
    const key = sha256Hex(code);
    for (const [k, v] of this.codes) if (Date.now() - v.at > 5 * 60_000) this.codes.delete(k);
    const existing = this.codes.get(key);
    if (existing) return existing.p;
    const p = (async () => {
      const t = await exchangeCode(code);
      const me = await getMe(t.access_token);
      await this.repo.savePending({
        accountId: me.accountId,
        accessToken: t.access_token,
        refreshToken: t.refresh_token,
        expiresAt: Date.now() + (t.expires_in || 14400) * 1000,
        email: me.email,
        scope: t.scope,
      });
      return me.accountId;
    })();
    this.codes.set(key, { at: Date.now(), p });
    p.catch(() => this.codes.delete(key)); // a failed attempt must not be cached as success
    return p;
  }

  /** Remove unclaimed tokens older than the TTL (Ring recommends 10-15 minutes). */
  async cleanupPending() {
    const cutoff = Date.now() - CONFIG.UNCLAIMED_TOKEN_TTL_MINUTES * 60_000;
    let n = 0;
    for (const p of await this.repo.pendingTokens()) {
      if (p.data.receivedAt < cutoff) {
        await this.repo.deletePending(p.id);
        n++;
      }
    }
    return n;
  }

  /** Finds an unclaimed token whose Ring account ID matches the nonce (constant work over all of them). */
  private async matchPending(nonce: string, time: string, key: string) {
    const ttlCutoff = Date.now() - CONFIG.UNCLAIMED_TOKEN_TTL_MINUTES * 60_000;
    let match = null as Awaited<ReturnType<Repo["pendingTokens"]>>[number] | null;
    for (const p of await this.repo.pendingTokens()) {
      if (p.data.receivedAt < ttlCutoff) continue;
      if (nonceMatches(nonce, time, p.data.accountId, key)) match = p; // keep iterating: constant work
    }
    return match;
  }

  /**
   * Read-only check for the Account Link page when the customer is already signed in, so a revisit
   * after a completed link shows "Already linked" first (UX-07) and a second Ring account is refused
   * up front (one Ring account per Visitor Recognizer account). Claims nothing.
   */
  async linkPageState(userId: string, nonce: string, time: string): Promise<LinkPageState> {
    const key = CONFIG.RING_HMAC_SIGNATURE_KEY;
    if (!key || !checkLinkTime(time).ok) return { status: "ready" };
    const match = await this.matchPending(nonce, time, key);
    const links = await this.repo.linksForUser(userId);
    if (!match) {
      for (const l of links) {
        if (nonceMatches(nonce, time, l.data.accountId, key)) return { status: "already_linked", accountId: l.data.accountId };
      }
      return { status: "ready" };
    }
    if (links.some((l) => l.data.accountId !== match.data.accountId)) return { status: "other_ring_account_linked" };
    return { status: "ready" };
  }

  /**
   * Runs ONLY after the partner user is signed in. Matches the nonce against every unclaimed token
   * (constant-time), then POST + PATCH app-integrations, and claims the token for this user only
   * once Ring has accepted both. Each Visitor Recognizer account holds at most ONE Ring account.
   */
  async claim(userId: string, userEmail: string, nonce: string, time: string): Promise<ClaimResult> {
    if (!checkLinkTime(time).ok) return { status: "expired" };
    const key = CONFIG.RING_HMAC_SIGNATURE_KEY;
    if (!key) return { status: "ring_error", httpStatus: 500 };

    const match = await this.matchPending(nonce, time, key);
    const existing = await this.repo.linksForUser(userId);

    if (!match) {
      // Revisit after a completed link: the nonce belongs to a Ring account this user already holds.
      for (const l of existing) {
        if (nonceMatches(nonce, time, l.data.accountId, key)) return { status: "already_linked", accountId: l.data.accountId };
      }
      return { status: "no_match" };
    }

    const t = match.data;
    // One Ring account per Visitor Recognizer account: enrollments and matching never span Ring accounts.
    if (existing.some((l) => l.data.accountId !== t.accountId)) {
      await this.repo.audit(userId, "ring_link_refused_second_account", {});
      return { status: "other_ring_account_linked" };
    }

    const identifier = maskEmail(userEmail);
    if (t.confirmedBy !== userId) {
      try {
        await confirmIntegration(t.accessToken, t.accountId, nonce, identifier); // -> "awaiting"
      } catch (err) {
        const status = err instanceof RingApiError ? err.status : 502;
        await this.repo.audit(userId, "ring_link_failed", { step: "confirm", httpStatus: status });
        return { status: "ring_error", httpStatus: status };
      }
      // Remember that the POST succeeded so a retry from the error page only repeats the PATCH.
      await this.repo.markPendingConfirmed(t.accountId, userId);
    }

    // Final step: PATCH status=completed. Retried inline with short backoff; if Ring still doesn't
    // accept it the link is NOT complete: the token stays unclaimed and the customer gets a retry page.
    let integrationStatus = "";
    let lastStatus = 502;
    for (let attempt = 0; attempt <= completionRetry.delaysMs.length; attempt++) {
      if (attempt > 0) {
        const d = completionRetry.delaysMs[attempt - 1];
        await completionRetry.sleep(d / 2 + completionRetry.random() * d);
      }
      try {
        integrationStatus = await setIntegrationStatus(t.accessToken, t.accountId, "completed");
        break;
      } catch (err) {
        lastStatus = err instanceof RingApiError ? err.status : 502;
        console.warn(`PATCH app-integrations failed (attempt ${attempt + 1}):`, (err as Error).message);
      }
    }
    if (integrationStatus !== "completed") {
      await this.repo.audit(userId, "ring_link_failed", { step: "complete", httpStatus: lastStatus });
      return { status: "completion_failed", httpStatus: lastStatus };
    }

    const link: RingLink = {
      accountId: t.accountId,
      accessToken: t.accessToken,
      refreshToken: t.refreshToken,
      expiresAt: t.expiresAt,
      email: t.email,
      scope: t.scope,
      linkedAt: new Date().toISOString(),
      refreshedAt: Date.now(),
      status: "active",
      integrationStatus: "completed",
    };
    const previous = await this.repo.saveLink(userId, link);
    await this.repo.deletePending(t.accountId);
    if (previous && previous.userId && previous.userId !== userId) {
      // The newest pair goes to whoever signed in now; the earlier partner account loses this Ring account.
      await this.repo.deleteDevicesForAccount(previous.userId, t.accountId);
      await this.repo.audit(previous.userId, "ring_account_moved_to_other_user", {});
    }
    await this.repo.audit(userId, "ring_account_linked", { integrationStatus });

    const deviceCount = await this.syncDevices(userId, t.accountId).catch(() => null);
    return { status: "linked", accountId: t.accountId, integrationStatus, deviceCount };
  }

  /** Retry PATCH status=completed for links left in "awaiting" (e.g. transient failure during linking). */
  async completePendingIntegrations() {
    for (const l of await this.repo.allLinks()) {
      if (!l.userId || l.data.integrationStatus === "completed" || l.data.status !== "active") continue;
      try {
        await this.tokens.withToken(l.id, (tok) => setIntegrationStatus(tok, l.id, "completed"));
        const fresh = await this.repo.linkByAccount(l.id);
        if (fresh?.userId) await this.repo.saveLink(fresh.userId, { ...fresh.data, integrationStatus: "completed" });
      } catch (err) {
        console.warn("Background PATCH completed failed:", (err as Error).message);
      }
    }
  }

  /** Device discovery for one linked Ring account; replaces that account's device list for the owner. */
  async syncDevices(userId: string, accountId: string): Promise<number> {
    const list = await this.tokens.withToken(accountId, (tok) => listDevices(tok, accountId));
    const now = new Date().toISOString();
    const keep = new Set(list.map((d) => d.deviceId));
    for (const d of await this.repo.devicesForUser(userId)) {
      if (d.data.accountId === accountId && !keep.has(d.data.deviceId)) await this.repo.deleteDevice(userId, d.data.deviceId);
    }
    for (const d of list) await this.repo.putDevice(userId, { ...d, accountId, updatedAt: now });
    return list.length;
  }
}
