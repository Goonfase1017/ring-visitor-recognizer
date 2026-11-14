import { spawn } from "child_process";
import path from "path";
import { CONFIG } from "./config";

export interface FaceResult {
  decodable: boolean;
  /** Image re-encoded with Ring privacy zones blacked out; this (never the raw frame) is what gets stored. */
  maskedJpeg: Buffer | null;
  faces: { box: number[]; embedding: number[] | null }[];
}

export interface FaceEngine {
  process(image: Buffer, opts: { zones: { x: number; y: number }[][]; embed: boolean }): Promise<FaceResult>;
}

/** Runs scripts/embed_face.py (OpenCV detector + bundled MobileFaceNet) on this server. Image via stdin. */
export class PythonFaceEngine implements FaceEngine {
  constructor(private modelDir = "./model") {}

  process(image: Buffer, opts: { zones: { x: number; y: number }[][]; embed: boolean }): Promise<FaceResult> {
    const script = path.resolve("scripts", "embed_face.py");
    const model = path.resolve(this.modelDir, "mobile_facenet.tflite");
    const args = process.platform === "win32" ? ["-3", script, model, JSON.stringify(opts)] : [script, model, JSON.stringify(opts)];
    return new Promise((resolve, reject) => {
      const child = spawn(CONFIG.PYTHON_BIN, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
      const out: Buffer[] = [];
      let err = "";
      const timer = setTimeout(() => child.kill("SIGKILL"), 60_000);
      child.stdout.on("data", (d) => out.push(d));
      child.stderr.on("data", (d) => (err += d.toString()));
      child.on("error", (e) => { clearTimeout(timer); reject(e); });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(`face engine exited ${code}: ${err.slice(-300)}`));
        try {
          const json = JSON.parse(Buffer.concat(out).toString("utf8").trim().split("\n").pop() ?? "{}");
          resolve({
            decodable: Boolean(json.decodable),
            maskedJpeg: json.maskedJpeg ? Buffer.from(json.maskedJpeg, "base64") : null,
            faces: Array.isArray(json.faces) ? json.faces : [],
          });
        } catch (e) {
          reject(e);
        }
      });
      child.stdin.end(image);
    });
  }
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}
