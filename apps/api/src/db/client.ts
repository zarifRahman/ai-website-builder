import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

const connectionString = process.env.DATABASE_URL;

/**
 * Lazily-created DB handle. Throws only when actually used without a
 * DATABASE_URL, so the server (e.g. /health) can boot without a database.
 */
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!_db) {
    if (!connectionString) {
      throw new Error("DATABASE_URL is not set");
    }
    const sql = postgres(connectionString);
    _db = drizzle(sql, { schema });
  }
  return _db;
}

export { schema };
