import { Pool } from "pg";
import { decrypt, encrypt } from "../secure";
import { Collection, DocMeta, Query, Store, StoredDoc } from "./types";

/**
 * Postgres backend, used automatically when DATABASE_URL is set. Document bodies and blobs are
 * AES-256-GCM encrypted by the app before they are written (column `data`), so the database never
 * holds tokens, emails, face templates or snapshots in clear text.
 */
export class PgStore implements Store {
  readonly kind = "postgres" as const;
  private pool: Pool;
  constructor(url: string, ssl: boolean) {
    this.pool = new Pool({ connectionString: url, ssl: ssl ? { rejectUnauthorized: true } : undefined, max: 5 });
  }

  async init() {
    await this.pool.query(`
      create table if not exists vr_docs (
        collection text not null,
        id text not null,
        user_id text,
        lookup text,
        created_at bigint not null,
        data bytea not null,
        primary key (collection, id)
      );
      create index if not exists vr_docs_user on vr_docs (collection, user_id);
      create index if not exists vr_docs_lookup on vr_docs (collection, lookup);
      create index if not exists vr_docs_created on vr_docs (collection, created_at);
      create table if not exists vr_blobs (
        id text primary key,
        user_id text not null,
        created_at bigint not null,
        data bytea not null
      );
      create index if not exists vr_blobs_user on vr_blobs (user_id);
      create index if not exists vr_blobs_created on vr_blobs (created_at);
    `);
  }

  private where(c: Collection, q: Query): { sql: string; args: unknown[] } {
    const args: unknown[] = [c];
    const parts = ["collection = $1"];
    if (q.userId === null) parts.push("user_id is null");
    else if (q.userId !== undefined) { args.push(q.userId); parts.push(`user_id = $${args.length}`); }
    if (q.lookup !== undefined) { args.push(q.lookup); parts.push(`lookup = $${args.length}`); }
    if (q.createdBefore !== undefined) { args.push(q.createdBefore); parts.push(`created_at < $${args.length}`); }
    return { sql: parts.join(" and "), args };
  }

  private toDoc<T>(r: any): StoredDoc<T> {
    return {
      id: r.id,
      userId: r.user_id,
      lookup: r.lookup,
      createdAt: Number(r.created_at),
      data: JSON.parse(decrypt(r.data).toString("utf8")) as T,
    };
  }

  async put<T>(c: Collection, id: string, meta: DocMeta, data: T) {
    await this.pool.query(
      `insert into vr_docs (collection, id, user_id, lookup, created_at, data) values ($1,$2,$3,$4,$5,$6)
       on conflict (collection, id) do update set user_id = excluded.user_id, lookup = excluded.lookup,
         created_at = excluded.created_at, data = excluded.data`,
      [c, id, meta.userId, meta.lookup ?? null, meta.createdAt, encrypt(Buffer.from(JSON.stringify(data)))]
    );
  }

  async get<T>(c: Collection, id: string) {
    const r = await this.pool.query("select * from vr_docs where collection = $1 and id = $2", [c, id]);
    return r.rows[0] ? this.toDoc<T>(r.rows[0]) : null;
  }

  async find<T>(c: Collection, q: Query, limit = 10_000) {
    const w = this.where(c, q);
    const r = await this.pool.query(`select * from vr_docs where ${w.sql} order by created_at desc limit ${Math.floor(limit)}`, w.args);
    return r.rows.map((row) => this.toDoc<T>(row));
  }

  async delete(c: Collection, id: string) {
    const r = await this.pool.query("delete from vr_docs where collection = $1 and id = $2", [c, id]);
    return (r.rowCount ?? 0) > 0;
  }

  async deleteWhere(c: Collection, q: Query) {
    const w = this.where(c, q);
    const r = await this.pool.query(`delete from vr_docs where ${w.sql}`, w.args);
    return r.rowCount ?? 0;
  }

  async count(c: Collection, q: Query = {}) {
    const w = this.where(c, q);
    const r = await this.pool.query(`select count(*)::int as n from vr_docs where ${w.sql}`, w.args);
    return r.rows[0].n as number;
  }

  async putBlob(id: string, userId: string, bytes: Buffer) {
    await this.pool.query(
      "insert into vr_blobs (id, user_id, created_at, data) values ($1,$2,$3,$4) on conflict (id) do update set data = excluded.data",
      [id, userId, Date.now(), encrypt(bytes)]
    );
  }

  async getBlob(id: string, userId: string) {
    const r = await this.pool.query("select data from vr_blobs where id = $1 and user_id = $2", [id, userId]);
    return r.rows[0] ? decrypt(r.rows[0].data) : null;
  }

  async deleteBlob(id: string) {
    await this.pool.query("delete from vr_blobs where id = $1", [id]);
  }

  async deleteBlobsWhere(q: { userId?: string; createdBefore?: number }) {
    const args: unknown[] = [];
    const parts: string[] = [];
    if (q.userId !== undefined) { args.push(q.userId); parts.push(`user_id = $${args.length}`); }
    if (q.createdBefore !== undefined) { args.push(q.createdBefore); parts.push(`created_at < $${args.length}`); }
    if (!parts.length) throw new Error("refusing unscoped blob delete");
    const r = await this.pool.query(`delete from vr_blobs where ${parts.join(" and ")}`, args);
    return r.rowCount ?? 0;
  }

  async close() {
    await this.pool.end();
  }
}
