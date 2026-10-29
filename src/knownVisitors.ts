import { promises as fs } from "fs";
import { CONFIG } from "./config";
import { FaceRecognizer } from "./faceRecognition";

export interface Visitor {
  /** Unique identifier */
  id: string;
  /** Human‑readable name */
  name: string;
  /** 128‑dim embedding */
  embedding: number[];
  /** If true, the visitor has opted out of recognition */
  optOut?: boolean;
  /** Locally stored registration or event photo */
  photoPath?: string;
}

/** Persistent JSON store for known visitors. */
export class VisitorStore {
  private path = CONFIG.VISITOR_DB_PATH;
  private visitors: Visitor[] = [];

  async load() {
    try {
      const raw = await fs.readFile(this.path, "utf-8");
      this.visitors = JSON.parse(raw);
    } catch {
      this.visitors = [];
    }
  }

  async save() {
    await fs.mkdir(require("path").dirname(this.path), { recursive: true });
    await fs.writeFile(this.path, JSON.stringify(this.visitors, null, 2));
  }

  getAll(): Visitor[] {
    return [...this.visitors];
  }

  add(visitor: Visitor) {
    this.visitors.push(visitor);
  }

  delete(id: string): boolean {
    const idx = this.visitors.findIndex((v) => v.id === id);
    if (idx === -1) return false;
    this.visitors.splice(idx, 1);
    return true;
  }

  updateOptOut(id: string, optOut: boolean): boolean {
    const v = this.visitors.find((v) => v.id === id);
    if (!v) return false;
    v.optOut = optOut;
    return true;
  }

  /** Return the best cosine score, including scores below the recognition threshold. */
  findBestMatchWithScore(embedding: Float32Array): { visitor: Visitor; score: number } | null {
    let best: Visitor | null = null;
    let bestScore = 0;
    for (const visitor of this.visitors) {
      if (visitor.optOut) continue;
      const score = FaceRecognizer.cosineSimilarity(Float32Array.from(visitor.embedding), embedding);
      if (score > bestScore) {
        best = visitor;
        bestScore = score;
      }
    }
    return best ? { visitor: best, score: bestScore } : null;
  }

  /** Find best match above threshold and not opted‑out. */
  findBestMatch(
    embedding: Float32Array,
    threshold: number = CONFIG.RECOGNITION_THRESHOLD
  ): { visitor: Visitor; score: number } | null {
    let best: Visitor | null = null;
    let bestScore = 0;
    for (const v of this.visitors) {
      if (v.optOut) continue;
      const score = FaceRecognizer.cosineSimilarity(
        Float32Array.from(v.embedding),
        embedding
      );
      if (score > bestScore) {
        bestScore = score;
        best = v;
      }
    }
    return bestScore >= threshold && best
      ? { visitor: best, score: bestScore }
      : null;
  }
}
