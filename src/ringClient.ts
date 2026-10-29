import { RingApi } from "ring-client-api";
import { CONFIG } from "./config";
import { EventEmitter } from "events";
import { promises as fs } from "fs";
import { randomUUID } from "crypto";

/**
 * Wrapper around Ring client‑api (uses refresh token).
 */
export class RingClient extends EventEmitter {
  private api: RingApi | null;
  private doorbell?: any;
  private connectedCameraCount = 0;
  private cameraNames: string[] = [];

  constructor() {
    super();
    this.api = CONFIG.RING_REFRESH_TOKEN
      ? new RingApi({ refreshToken: CONFIG.RING_REFRESH_TOKEN })
      : null;
  }

  async init() {
    if (!this.api) throw new Error("RING_REFRESH_TOKEN is not configured.");
    // The RingApi automatically authenticates using the refresh token when needed.
    const cams = await this.api.getCameras();
    if (!cams.length) throw new Error("No Ring cameras found in your account.");
    this.doorbell = cams.find((c) => /doorbell/i.test(String((c as any).deviceType))) ?? cams[0];
    this.connectedCameraCount = cams.length;
    this.cameraNames = cams.map((c) => String((c as any).name ?? (c as any).deviceType ?? "Unknown camera"));

    for (const camera of cams) {
      if ((camera as any).onMotionStarted) {
        (camera as any).onMotionStarted.subscribe(() => {
          console.log(`Motion detected by ${(camera as any).name ?? "Ring camera"}`);
          this.emit("motion", camera);
        });
      } else if ((camera as any).onMotionDetected) {
        let previousMotion = false;
        (camera as any).onMotionDetected.subscribe((detected: boolean) => {
          if (detected && !previousMotion) {
            console.log(`Motion detected by ${(camera as any).name ?? "Ring camera"}`);
            this.emit("motion", camera);
          }
          previousMotion = detected;
        });
      }
      if ((camera as any).onDoorbellPressed) {
        (camera as any).onDoorbellPressed.subscribe(() => {
          console.log(`Doorbell pressed on ${(camera as any).name ?? "Ring camera"}`);
          this.emit("ding", camera);
        });
      }
    }
    console.log(`Connected to Ring camera: ${(this.doorbell as any).name ?? (this.doorbell as any).deviceType ?? "Unknown"}`);
  }

  async requestSnapshot(): Promise<string> {
    if (!this.doorbell) throw new Error("Ring client not initialised.");
    if (typeof (this.doorbell as any).getSnapShotUrl === "function") {
      return await (this.doorbell as any).getSnapShotUrl();
    }
    if (typeof (this.doorbell as any).getSnapshot === "function") {
      const snapshot: Buffer = await (this.doorbell as any).getSnapshot();
      if (!snapshot?.length) throw new Error("Ring returned an empty snapshot.");
      const snapshotId = randomUUID();
      await fs.mkdir("public/snapshots", { recursive: true });
      await fs.writeFile(`public/snapshots/${snapshotId}.jpg`, snapshot);
      return `http://localhost:3000/snapshots/${snapshotId}.jpg`;
    }
    throw new Error("This Ring camera does not expose a supported snapshot method.");
  }

  getStatus() {
    return {
      connected: Boolean(this.doorbell),
      cameraCount: this.connectedCameraCount,
      cameraNames: this.cameraNames,
      selectedCamera: this.doorbell?.name ?? this.doorbell?.deviceType ?? null,
    };
  }
}
