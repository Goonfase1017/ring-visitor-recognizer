import { promises as fs } from "fs";
import path from "path";
import { decrypt, encrypt } from "../secure";
import { Collection, DocMeta, Query, Store, StoredDoc, matches } from "./types";

interface Row extends DocMeta {
  id: string;
  /** encrypted JSON body, base64 */
  enc: string;
}
interface BlobMeta {
  userId: string;
  createdAt: number;
}

/**
 * Default backend: one AES-256-GCM encrypted index file plus one encrypted file per blob in DATA_DIR.
 * Suitable for a single instance with a persistent disk. Render's free tier wipes the disk on restart,
 * so production should set DATABASE_URL (see pgStore).
 */
export class FileStore implements Store {
  readonly kind = "file" as const;
  private rows = new Map<string, Map<string, Row>>();
  private blobs = new Map<string, BlobMeta>();
  private writing: Promise<void> = Promise.resolve();
  private dirty = false;
  constructor(private dir: string) {}

  private get dbFile() {
    return path.join(this.dir, "store.enc");
  }
  private blobFile(id: string) {
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new Error("bad blob id");
    return path.join(this.dir, "blobs", `${id}.enc`);
  }

  async init() {
    await fs.mkdir(path.join(this.dir, "blobs"), { recursive: true, mode: 0o700 });
    try {
      const parsed = JSON.parse(decrypt(await fs.readFile(this.dbFile)).toString("utf8")) as {
        rows: Record<string, Row[]>;
        blobs: Record<string, BlobMeta>;
      };
      for (const [c, list] of Object.entries(parsed.rows)) this.rows.set(c, new Map(list.map((r) => [r.id, r])));
      this.blobs = new Map(Object.entries(parsed.blobs ?? {}));
    } catch (err: any) {
      if (err?.code !== "ENOENT") throw err;
    }
  }

  private table(c: Collection) {
    let t = this.rows.get(c);
    if (!t) this.rows.set(c, (t = new Map()));
    return t;
  }

  /** Serialised, atomic write of the whole index (tmp file + rename). */
  private persist(): Promise<void> {
    this.dirty = true;
    this.writing = this.writing.then(async () => {
      if (!this.dirty) return;
      this.dirty = false;
      const snapshot = {
        rows: Object.fromEntries([...this.rows].map(([c, t]) => [c, [...t.values()]])),
        blobs: Object.fromEntries(this.blobs),
      };
      const tmp = `${this.dbFile}.${process.pid}.tmp`;
      await fs.writeFile(tmp, encrypt(Buffer.from(JSON.stringify(snapshot))), { mode: 0o600 });
      await fs.rename(tmp, this.dbFile);
    });
    return this.writing;
  }

  async put<T>(c: Collection, id: string, meta: DocMeta, data: T) {
    this.table(c).set(id, { id, ...meta, enc: encrypt(Buffer.from(JSON.stringify(data))).toString("base64") });
    await this.persist();
  }

  private toDoc<T>(r: Row): StoredDoc<T> {
    return {
      id: r.id,
      userId: r.userId,
      lookup: r.lookup ?? null,
      createdAt: r.createdAt,
      data: JSON.parse(decrypt(Buffer.from(r.enc, "base64")).toString("utf8")) as T,
    };
  }

  async get<T>(c: Collection, id: string) {
    const r = this.table(c).get(id);
    return r ? this.toDoc<T>(r) : null;
  }

  async find<T>(c: Collection, q: Query, limit = 10_000) {
    const out: StoredDoc<T>[] = [];
    const sorted = [...this.table(c).values()].filter((r) => matches(r, q)).sort((a, b) => b.createdAt - a.createdAt);
    for (const r of sorted.slice(0, limit)) out.push(this.toDoc<T>(r));
    return out;
  }

  async delete(c: Collection, id: string) {
    const existed = this.table(c).delete(id);
    if (existed) await this.persist();
    return existed;
  }

  async deleteWhere(c: Collection, q: Query) {
    let n = 0;
    for (const [id, r] of this.table(c)) if (matches(r, q)) { this.table(c).delete(id); n++; }
    if (n) await this.persist();
    return n;
  }

  async count(c: Collection, q: Query = {}) {
    let n = 0;
    for (const r of this.table(c).values()) if (matches(r, q)) n++;
    return n;
  }

  async putBlob(id: string, userId: string, bytes: Buffer) {
    const file = this.blobFile(id);
    await fs.writeFile(`${file}.tmp`, encrypt(bytes), { mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
    this.blobs.set(id, { userId, createdAt: Date.now() });
    await this.persist();
  }

  async getBlob(id: string, userId: string) {
    const meta = this.blobs.get(id);
    if (!meta || meta.userId !== userId) return null;
    try {
      return decrypt(await fs.readFile(this.blobFile(id)));
    } catch {
      return null;
    }
  }

  async deleteBlob(id: string) {
    this.blobs.delete(id);
    await fs.unlink(this.blobFile(id)).catch(() => undefined);
    await this.persist();
  }

  async deleteBlobsWhere(q: { userId?: string; createdBefore?: number }) {
    let n = 0;
    for (const [id, m] of [...this.blobs]) {
      if (q.userId !== undefined && m.userId !== q.userId) continue;
      if (q.createdBefore !== undefined && !(m.createdAt < q.createdBefore)) continue;
      this.blobs.delete(id);
      await fs.unlink(this.blobFile(id)).catch(() => undefined);
      n++;
    }
    if (n) await this.persist();
    return n;
  }

  async close() {
    await this.writing;
  }
}
