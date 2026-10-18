import Database from "better-sqlite3";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type BackendDatabase = InstanceType<typeof Database>;

const migrationPath = fileURLToPath(new URL("./migrations/001_initial.sql", import.meta.url));
const migrationSql = readFileSync(migrationPath, "utf8");

export function createDatabase(dbPath: string): BackendDatabase {
  if (dbPath !== ":memory:") mkdirSync(dirname(resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  if (dbPath !== ":memory:") db.pragma("journal_mode = WAL");
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = db.prepare("SELECT version FROM schema_migrations WHERE version = ?").get("001_initial") as { version: string } | undefined;
  if (!applied) {
    const applyMigration = db.transaction(() => {
      db.exec(migrationSql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run("001_initial", Math.floor(Date.now() / 1000));
    });
    applyMigration();
  }
  return db;
}
