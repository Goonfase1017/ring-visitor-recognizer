import { CONFIG } from "./config";
import { FaceRecognizer } from "./faceRecognition";
import { readEncrypted, writeEncrypted } from "./secure";

export interface ConsentRecord {
  /** ISO time the owner confirmed the visitor's consent */
  confirmedAt: string;
  /** How consent was obtained, e.g. "verbal", "written", "in-app", "self (owner)" */
  method: string;
  /** Exact consent statement the owner affirmed */
  statement: string;
}

export interface Visitor {
  id: string;
  name: string;
  /** Face embedding; emptied when the visitor opts out */
  embedding: number[];
  optOut?: boolean;
  optOutAt?: string;
  /** Media id of the encrypted registration photo */
  photoPath?: string;
  consent?: ConsentRecord;
  createdAt?: string;
}

export const CONSENT_STATEMENT =
  "I confirm this person has given me permission to store their name, photo, and face template so this app can recognise them at my door, and that I will delete their data if they ask.";

/** Encrypted JSON store for known visitors. */
export class VisitorStore {
  private path = CONFIG.VISITOR_DB_PATH;
  private visitors: Visitor[] = [];

  async load() {
    try {
      this.visitors = JSON.parse((await readEncrypted(this.path)).toString("utf8"));
    } catch {
      this.visitors = [];
    }
  }

  async save() {
    await writeEncrypted(this.path, JSON.stringify(this.visitors));
  }

  getAll(): Visitor[] {
    return [...this.visitors];
  }

  /** Public view without embeddings. */
  list() {
    return this.visitors.map(({ embedding, ...rest }) => ({ ...rest, hasFaceTemplate: embedding.length > 0 }));
  }

  add(visitor: Visitor) {
    this.visitors.push(visitor);
  }

  delete(id: string): Visitor | null {
    const idx = this.visitors.findIndex((v) => v.id === id);
    if (idx === -1) return null;
    return this.visitors.splice(idx, 1)[0];
  }

  /** Opt-out is enforced by deleting the face template and photo reference immediately. */
  optOut(id: string): Visitor | null {
    const v = this.visitors.find((v) => v.id === id);
    if (!v) return null;
    const previousPhoto = v.photoPath;
    v.optOut = true;
    v.optOutAt = new Date().toISOString();
    v.embedding = [];
    v.photoPath = undefined;
    return { ...v, photoPath: previousPhoto };
  }

  findBestMatchWithScore(embedding: Float32Array): { visitor: Visitor; score: number } | null {
    let best: Visitor | null = null;
    let bestScore = 0;
    for (const v of this.visitors) {
      if (v.optOut || !v.embedding.length) continue;
      const score = FaceRecognizer.cosineSimilarity(Float32Array.from(v.embedding), embedding);
      if (score > bestScore) {
        best = v;
        bestScore = score;
      }
    }
    return best ? { visitor: best, score: bestScore } : null;
  }

  findBestMatch(embedding: Float32Array, threshold: number = CONFIG.RECOGNITION_THRESHOLD) {
    const best = this.findBestMatchWithScore(embedding);
    return best && best.score >= threshold ? best : null;
  }
}
