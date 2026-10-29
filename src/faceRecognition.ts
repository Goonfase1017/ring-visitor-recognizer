import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";

const execFileAsync = promisify(execFile);

export class FaceRecognizer {
  private readonly modelDir: string;

  constructor(modelDir: string) {
    this.modelDir = modelDir;
  }

  async embed(url: string): Promise<{ faceDetected: boolean; embedding: Float32Array | null; faceBox?: number[] }> {
    const scriptPath = path.resolve("scripts", "embed_face.py");
    const modelPath = path.resolve(this.modelDir, "mobile_facenet.tflite");
    const python = process.platform === "win32" ? "py" : "python3";
    const pythonArgs = process.platform === "win32"
      ? ["-3.13", scriptPath, url, modelPath]
      : [scriptPath, url, modelPath];
    const { stdout } = await execFileAsync(python, pythonArgs, {
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const result = JSON.parse(stdout.trim()) as { faceDetected: boolean; embedding: number[] | null; faceBox?: number[] };
    return {
      faceDetected: result.faceDetected,
      embedding: result.embedding ? Float32Array.from(result.embedding) : null,
      faceBox: result.faceBox,
    };
  }

  static cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}

