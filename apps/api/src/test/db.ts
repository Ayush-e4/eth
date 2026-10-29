import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { type Db, MIGRATIONS_DIR } from "../db/client";
import * as schema from "../db/schema";

/** A real Postgres (PGlite, in memory) with the app's migrations applied. No Docker needed. */
export async function testDb(): Promise<Db> {
  const db = drizzle(new PGlite(), { schema });
  await migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db as unknown as Db;
}
