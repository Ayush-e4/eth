import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { type Db, MIGRATIONS_DIR } from "../db/client";
import * as schema from "../db/schema";

// Migrating a fresh database for every test got slow as migrations grew (and timed out when all
// packages test at once), so each test worker migrates one template and every test gets a copy.
let template: Promise<PGlite> | null = null;
const migrated = () => {
  template ??= (async () => {
    const pg = new PGlite();
    await migrate(drizzle(pg, { schema }), { migrationsFolder: MIGRATIONS_DIR });
    return pg;
  })();
  return template;
};

/** A real Postgres (PGlite, in memory) with the app's migrations applied. No Docker needed. */
export async function testDb(): Promise<Db> {
  const pg = (await (await migrated()).clone()) as PGlite;
  return drizzle(pg, { schema }) as unknown as Db;
}
