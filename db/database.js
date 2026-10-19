import { DatabaseSync } from "node:sqlite";
import {
  mkdirSync
} from "node:fs";
import {
  dirname,
  resolve
} from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = resolve(
  fileURLToPath(new URL("../", import.meta.url))
);

const migrations = [
  {
    version: 1,
    name: "initial_metadata",
    sql: `
      CREATE TABLE app_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
          DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;
    `
  },
  {
    version: 2,
    name: "initial_products",
    sql: `
      CREATE TABLE products (
        id INTEGER PRIMARY KEY,
        sku TEXT,
        name TEXT NOT NULL
          CHECK (length(trim(name)) > 0),
        description TEXT NOT NULL DEFAULT '',
        unit TEXT NOT NULL DEFAULT 'piece'
          CHECK (length(trim(unit)) > 0),
        cost_price_paisa INTEGER NOT NULL DEFAULT 0
          CHECK (cost_price_paisa >= 0),
        sale_price_paisa INTEGER NOT NULL DEFAULT 0
          CHECK (sale_price_paisa >= 0),
        is_active INTEGER NOT NULL DEFAULT 1
          CHECK (is_active IN (0, 1)),
        created_at TEXT NOT NULL
          DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL
          DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;

      CREATE UNIQUE INDEX products_sku_unique
        ON products(lower(trim(sku)))
        WHERE sku IS NOT NULL AND trim(sku) <> '';
    `
  }
];

export function openDatabase(
  databasePath = resolve(PROJECT_ROOT, "data", "modernpos.sqlite")
) {
  const absolutePath = resolve(databasePath);

  mkdirSync(dirname(absolutePath), { recursive: true });

  const db = new DatabaseSync(absolutePath);

  try {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA journal_mode = WAL");

    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
          DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;
    `);

    for (const migration of migrations) {
      const applied = db.prepare(
        "SELECT version FROM schema_migrations WHERE version = ?"
      ).get(migration.version);

      if (applied) continue;

      db.exec("BEGIN IMMEDIATE");

      try {
        db.exec(migration.sql);

        db.prepare(`
          INSERT INTO schema_migrations (version, name)
          VALUES (?, ?)
        `).run(migration.version, migration.name);

        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }

    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
