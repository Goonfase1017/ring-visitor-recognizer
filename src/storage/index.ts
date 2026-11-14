import { CONFIG } from "../config";
import { FileStore } from "./fileStore";
import { PgStore } from "./pgStore";
import { Store } from "./types";

export * from "./types";

export function createStore(): Store {
  return CONFIG.DATABASE_URL ? new PgStore(CONFIG.DATABASE_URL, CONFIG.DATABASE_SSL) : new FileStore(CONFIG.DATA_DIR);
}
