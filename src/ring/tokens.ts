import { Repo, RingLink } from "../repo";
import { RingApiError, refreshTokens } from "./api";

/**
 * Token lifecycle for claimed Ring links. Refreshes are serialised per Ring account because each
 * refresh invalidates the previous refresh token; the new pair is persisted before it is used.
 */
export class TokenManager {
  private inflight = new Map<string, Promise<RingLink | null>>();
  constructor(private repo: Repo) {}

  async refresh(accountId: string): Promise<RingLink | null> {
    const running = this.inflight.get(accountId);
    if (running) return running;
    const p = (async () => {
      const doc = await this.repo.linkByAccount(accountId);
      if (!doc || !doc.userId) return null;
      try {
        const t = await refreshTokens(doc.data.refreshToken);
        const updated: RingLink = {
          ...doc.data,
          accessToken: t.access_token,
          refreshToken: t.refresh_token,
          expiresAt: Date.now() + (t.expires_in || 14400) * 1000,
          refreshedAt: Date.now(),
          status: "active",
        };
        await this.repo.saveLink(doc.userId, updated);
        return updated;
      } catch (err) {
        if (err instanceof RingApiError && (err.status === 400 || err.status === 401)) {
          // Refresh token expired or revoked: only the customer can fix this by linking again.
          await this.repo.saveLink(doc.userId, { ...doc.data, status: "needs_relink" });
          await this.repo.audit(doc.userId, "ring_token_refresh_failed", { reason: `HTTP ${err.status}` });
        }
        throw err;
      }
    })().finally(() => this.inflight.delete(accountId));
    this.inflight.set(accountId, p);
    return p;
  }

  /** A valid access token for this Ring account, refreshed silently if it expires within 5 minutes. */
  async accessToken(accountId: string): Promise<string | null> {
    const doc = await this.repo.linkByAccount(accountId);
    if (!doc || !doc.userId || doc.data.status !== "active") return null;
    if (doc.data.expiresAt - Date.now() > 5 * 60_000) return doc.data.accessToken;
    return (await this.refresh(accountId))?.accessToken ?? null;
  }

  /** Runs fn with a token; on 401 refreshes once and retries (reactive refresh per Ring docs). */
  async withToken<T>(accountId: string, fn: (token: string) => Promise<T>): Promise<T> {
    const token = await this.accessToken(accountId);
    if (!token) throw new RingApiError(401, "no active Ring link for this account");
    try {
      return await fn(token);
    } catch (err) {
      if (!(err instanceof RingApiError && err.status === 401)) throw err;
      const fresh = await this.refresh(accountId);
      if (!fresh) throw err;
      return fn(fresh.accessToken);
    }
  }

  /** Proactive refresh (Ring recommends every 24 h) so refresh tokens never reach their ~30 day expiry. */
  async refreshDue(maxAgeMs = 20 * 3600_000) {
    for (const link of await this.repo.allLinks()) {
      if (link.data.status !== "active") continue;
      if (Date.now() - link.data.refreshedAt < maxAgeMs && link.data.expiresAt - Date.now() > 30 * 60_000) continue;
      await this.refresh(link.id).catch((err) => console.warn("Proactive Ring token refresh failed:", (err as Error).message));
    }
  }
}
