import { Linking } from "./linking";
import { EventProcessor } from "./processor";
import { Repo } from "./repo";

export interface RingWebhook {
  meta?: { version?: string; time?: string; request_id?: string; account_id?: string };
  data?: {
    id?: string;
    type?: string;
    attributes?: {
      source?: string;
      source_type?: string;
      timestamp?: number;
      sub_type?: string;
      component_ids?: string[];
      plan_id?: string;
    };
  };
}

/**
 * Handles verified Ring webhook v1.1 payloads after the 200 has been sent. Deduplicates on
 * meta.request_id (Ring retries and may deliver twice).
 */
export class WebhookHandler {
  private recent = new Set<string>();
  constructor(private repo: Repo, private linking: Linking, private processor: EventProcessor) {}

  async handle(payload: RingWebhook): Promise<void> {
    const requestId = payload.meta?.request_id ?? payload.data?.id;
    if (requestId) {
      if (this.recent.has(requestId) || (await this.repo.store.get("webhookSeen", requestId))) return;
      this.recent.add(requestId);
      if (this.recent.size > 5000) this.recent.clear();
      await this.repo.store.put("webhookSeen", requestId, { userId: null, createdAt: Date.now() }, {});
    }
    const type = payload.data?.type ?? "";
    const accountId = payload.meta?.account_id ?? "";
    const attrs = payload.data?.attributes ?? {};
    const deviceId = attrs.source ?? "";
    if (!accountId) return;
    const link = await this.repo.linkByAccount(accountId);
    const userId = link?.userId ?? null;

    switch (type) {
      case "motion_detected":
      case "button_press":
        if (!userId || !deviceId) return;
        this.processor.enqueue({
          accountId,
          deviceId,
          kind: type,
          subType: attrs.sub_type,
          timestampMs: Number(attrs.timestamp) || Date.now(),
          componentIds: Array.isArray(attrs.component_ids) ? attrs.component_ids.map(String) : [],
        });
        return;

      case "device_added":
        // May arrive before the link is claimed; claim() runs discovery itself in that case.
        if (userId) await this.linking.syncDevices(userId, accountId).catch((e) => console.warn("device sync failed:", e.message));
        return;

      case "device_removed": {
        this.processor.cancel({ accountId, deviceId });
        if (!userId || !deviceId) return;
        await this.repo.deleteDevice(userId, deviceId);
        const removedEvents = await this.repo.deleteEventsForDevice(userId, deviceId);
        await this.repo.audit(userId, "ring_device_removed", { eventsDeleted: removedEvents });
        return;
      }

      case "device_online":
      case "device_offline": {
        if (!userId || !deviceId) return;
        const d = await this.repo.device(userId, deviceId);
        if (d) await this.repo.putDevice(userId, { ...d.data, online: type === "device_online", updatedAt: new Date().toISOString() });
        return;
      }

      case "app_integration_added":
        if (userId) await this.repo.audit(userId, "ring_integration_added", {});
        return;

      case "app_integration_removed": {
        // Tokens are revoked by Ring; delete ours, stop processing, never call Ring for this account again.
        this.processor.cancel({ accountId });
        await this.repo.deletePending(accountId);
        if (!userId) {
          await this.repo.deleteLink(accountId);
          return;
        }
        await this.repo.deleteLink(accountId);
        const devices = await this.repo.deleteDevicesForAccount(userId, accountId);
        await this.repo.audit(userId, "ring_integration_removed", { tokensDeleted: true, devicesRemoved: devices });
        return;
      }

      case "subscription_activated":
      case "subscription_deactivated":
        if (link && userId) {
          await this.repo.saveLink(userId, {
            ...link.data,
            subscription: { type, subType: attrs.sub_type, at: new Date().toISOString() },
          });
          await this.repo.audit(userId, type, { subType: attrs.sub_type });
        }
        return;

      default:
        return; // unknown types are acknowledged and ignored (forward compatible)
    }
  }

  /** Forget dedupe keys after Ring's 72 h dead-letter window. */
  async sweep() {
    return this.repo.store.deleteWhere("webhookSeen", { createdBefore: Date.now() - 73 * 3600_000 });
  }
}
