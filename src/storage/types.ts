/**
 * Storage abstraction. Every document body and blob is encrypted (AES-256-GCM) before it reaches
 * the backend; only opaque routing columns (collection, id, owner user id, blind-index lookup key,
 * created time) are stored in clear so rows can be found and deleted.
 */
export type Collection =
  | "users"
  | "sessions"
  | "pendingTokens" // unclaimed Ring tokens, keyed by Ring Account ID
  | "ringLinks" // claimed Ring tokens, keyed by Ring Account ID, owned by one partner user
  | "devices"
  | "visitors" // enrolled faces (templates only)
  | "events"
  | "audit"
  | "deletionLog"
  | "webhookSeen";

export interface DocMeta {
  /** Owning partner user. null for records with no owner yet (unclaimed tokens, operator records). */
  userId: string | null;
  /** Optional blind-index / secondary key (e.g. HMAC of an email, a Ring Account ID). */
  lookup?: string | null;
  createdAt: number;
}

export interface StoredDoc<T> extends DocMeta {
  id: string;
  data: T;
}

export interface Query {
  userId?: string | null; // null means "has no owner"
  lookup?: string;
  createdBefore?: number;
}

export interface Store {
  readonly kind: "file" | "postgres";
  init(): Promise<void>;
  put<T>(collection: Collection, id: string, meta: DocMeta, data: T): Promise<void>;
  get<T>(collection: Collection, id: string): Promise<StoredDoc<T> | null>;
  find<T>(collection: Collection, query: Query, limit?: number): Promise<StoredDoc<T>[]>;
  delete(collection: Collection, id: string): Promise<boolean>;
  deleteWhere(collection: Collection, query: Query): Promise<number>;
  count(collection: Collection, query?: Query): Promise<number>;

  putBlob(id: string, userId: string, bytes: Buffer): Promise<void>;
  /** Returns the blob only if it belongs to userId. */
  getBlob(id: string, userId: string): Promise<Buffer | null>;
  deleteBlob(id: string): Promise<void>;
  deleteBlobsWhere(query: { userId?: string; createdBefore?: number }): Promise<number>;
  close(): Promise<void>;
}

export function matches(doc: DocMeta, q: Query): boolean {
  if (q.userId !== undefined && doc.userId !== q.userId) return false;
  if (q.lookup !== undefined && doc.lookup !== q.lookup) return false;
  if (q.createdBefore !== undefined && !(doc.createdAt < q.createdBefore)) return false;
  return true;
}
