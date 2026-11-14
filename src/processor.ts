import { CONFIG } from "./config";
import { FaceEngine, cosineSimilarity } from "./face";
import { ArrivalEvent, Repo } from "./repo";
import { downloadSnapshot, SnapshotResult } from "./ring/api";
import { TokenManager } from "./ring/tokens";

export interface EventJob {
  accountId: string;
  deviceId: string;
  kind: "button_press" | "motion_detected";
  subType?: string;
  timestampMs: number;
  componentIds: string[];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function recognitionAllowedForState(state: string | null): boolean {
  return !(state && CONFIG.RECOGNITION_BLOCKED_STATES.includes(state));
}

/**
 * Asynchronous pipeline for motion / doorbell webhooks (the webhook itself is acknowledged first).
 * Everything here is scoped to the partner user that owns the Ring account in the event: the
 * snapshot is matched only against that user's own enrolled templates, never anyone else's.
 */
export class EventProcessor {
  private queue: EventJob[] = [];
  private running = 0;
  private lastByDevice = new Map<string, number>();
  private idleWaiters: (() => void)[] = [];

  constructor(private repo: Repo, private tokens: TokenManager, private faces: FaceEngine, private concurrency = 2) {}

  get pending() {
    return this.queue.length + this.running;
  }

  enqueue(job: EventJob) {
    this.queue.push(job);
    this.pump();
  }

  /** Drop queued work for a device or a whole Ring account (device_removed / app_integration_removed). */
  cancel(filter: { accountId: string; deviceId?: string }) {
    this.queue = this.queue.filter((j) => !(j.accountId === filter.accountId && (!filter.deviceId || j.deviceId === filter.deviceId)));
  }

  /** Test helper: resolves when the queue is empty and nothing is running. */
  idle(): Promise<void> {
    if (!this.pending) return Promise.resolve();
    return new Promise((r) => this.idleWaiters.push(r));
  }

  private pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.running++;
      this.run(job)
        .catch((err) => console.error("Event processing failed:", (err as Error).message))
        .finally(() => {
          this.running--;
          this.pump();
          if (!this.pending) this.idleWaiters.splice(0).forEach((r) => r());
        });
    }
  }

  private async run(job: EventJob) {
    const link = await this.repo.linkByAccount(job.accountId);
    if (!link || !link.userId || link.data.status !== "active") return; // unlinked: stop processing
    const userId = link.userId;
    const device = await this.repo.device(userId, job.deviceId);
    if (!device) return; // not a device this customer shared with the app

    // A burst of motion events produces one entry per 15 s; a doorbell press is always logged.
    const key = `${userId}|${job.deviceId}`;
    const last = this.lastByDevice.get(key) ?? 0;
    if (job.kind === "motion_detected" && job.timestampMs - last < 15_000) return;
    this.lastByDevice.set(key, job.timestampMs);

    const user = await this.repo.userById(userId);
    if (!user) return;
    const visitors = user.data.recognitionConsent ? await this.repo.visitors(userId) : [];
    const recognitionOn = Boolean(user.data.recognitionConsent) && visitors.length > 0 && recognitionAllowedForState(device.data.state);

    const base: ArrivalEvent = {
      accountId: job.accountId,
      deviceId: job.deviceId,
      deviceName: device.data.name,
      kind: job.kind,
      subType: job.subType,
      at: new Date(job.timestampMs || Date.now()).toISOString(),
      status: "logged",
      recognized: [],
      unknownFaces: 0,
    };

    if (device.data.e2ee) {
      await this.repo.addEvent(userId, { ...base, status: "encrypted", note: "Video encryption is on for this camera, so snapshots can't be read." });
      return;
    }

    const componentId = job.componentIds[0] ?? device.data.componentIds[0];
    let snap: SnapshotResult | null = null;
    for (const delay of CONFIG.SNAPSHOT_RETRY_DELAYS_MS.length ? CONFIG.SNAPSHOT_RETRY_DELAYS_MS : [0]) {
      await sleep(delay); // the recording must finish before Ring can serve a frame
      if (!(await this.repo.linkByAccount(job.accountId))) return; // unlinked while waiting
      try {
        snap = await this.tokens.withToken(job.accountId, (tok) =>
          downloadSnapshot(tok, job.accountId, job.deviceId, job.timestampMs || Date.now(), componentId)
        );
      } catch (err) {
        snap = { ok: false, status: 0, retryable: false };
        console.warn("Snapshot request failed:", (err as Error).message);
      }
      if (snap.ok || !snap.retryable) break;
    }
    if (!snap || !snap.ok) {
      await this.repo.addEvent(userId, { ...base, status: "unavailable", note: "Ring didn't have a snapshot for this moment." });
      return;
    }
    if (!/^image\//i.test(snap.contentType) && snap.contentType) {
      await this.repo.addEvent(userId, { ...base, status: "encrypted", note: "This camera's video is encrypted, so the snapshot can't be read." });
      return;
    }

    let result;
    try {
      result = await this.faces.process(snap.bytes, { zones: device.data.privacyZones, embed: recognitionOn });
    } catch (err) {
      console.warn("Image processing unavailable:", (err as Error).message);
      // Without the image step privacy zones can't be masked, so only store the frame when there are none.
      const snapshotId = device.data.privacyZones.length ? undefined : await this.repo.putSnapshot(userId, snap.bytes);
      await this.repo.addEvent(userId, { ...base, status: "logged", snapshotId });
      return;
    }
    if (!result.decodable) {
      await this.repo.addEvent(userId, { ...base, status: "encrypted", note: "The snapshot couldn't be read (the camera may use video encryption)." });
      return;
    }
    const snapshotId = result.maskedJpeg ? await this.repo.putSnapshot(userId, result.maskedJpeg) : undefined;

    if (!recognitionOn) {
      await this.repo.addEvent(userId, { ...base, status: "logged", snapshotId });
      return;
    }

    // Match each face only against THIS user's enrolled templates. Unknown faces are counted and
    // their templates discarded immediately: nothing is stored for people who are not enrolled.
    const recognized = new Map<string, { visitorId: string; name: string; score: number }>();
    let unknown = 0;
    for (const face of result.faces) {
      if (!face.embedding) continue;
      let best: { id: string; name: string; score: number } | null = null;
      for (const v of visitors) {
        const score = cosineSimilarity(v.data.template, face.embedding);
        if (!best || score > best.score) best = { id: v.id, name: v.data.name, score };
      }
      if (best && best.score >= CONFIG.RECOGNITION_THRESHOLD) {
        const prev = recognized.get(best.id);
        if (!prev || prev.score < best.score) recognized.set(best.id, { visitorId: best.id, name: best.name, score: Number(best.score.toFixed(3)) });
      } else unknown++;
    }
    await this.repo.addEvent(userId, {
      ...base,
      status: recognized.size ? "recognized" : result.faces.length ? "unknown" : "no_face",
      recognized: [...recognized.values()],
      unknownFaces: unknown,
      snapshotId,
    });
  }
}
