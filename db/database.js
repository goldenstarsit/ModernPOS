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
  },
  {
    version: 3,
    name: "initial_product_batches",
    sql: `
      CREATE TABLE product_batches (
        id INTEGER PRIMARY KEY,
        product_id INTEGER NOT NULL
          REFERENCES products(id) ON DELETE RESTRICT,
        batch_number TEXT NOT NULL
          CHECK (length(trim(batch_number)) > 0),
        expiry_date TEXT NOT NULL
          CHECK (
            length(expiry_date) = 10
            AND expiry_date GLOB
              '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
            AND date(expiry_date, '+0 days') IS NOT NULL
            AND date(expiry_date, '+0 days') = expiry_date
          ),
        quantity_on_hand INTEGER NOT NULL DEFAULT 0
          CHECK (quantity_on_hand >= 0),
        cost_price_paisa INTEGER NOT NULL DEFAULT 0
          CHECK (cost_price_paisa >= 0),
        created_at TEXT NOT NULL
          DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL
          DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (product_id, batch_number)
      ) STRICT;

      CREATE INDEX product_batches_expiry_idx
        ON product_batches(expiry_date);
    `
  },
  {
    version: 4,
    name: "initial_stock_movements",
    sql: `
      CREATE TABLE stock_movements (
        id INTEGER PRIMARY KEY,
        batch_id INTEGER NOT NULL
          REFERENCES product_batches(id) ON DELETE RESTRICT,
        movement_type TEXT NOT NULL CHECK (
          movement_type IN (
            'opening_stock',
            'purchase',
            'sale',
            'customer_return',
            'supplier_return',
            'damage',
            'expiry',
            'adjustment_in',
            'adjustment_out'
          )
        ),
        quantity INTEGER NOT NULL CHECK (quantity > 0),
        reference TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL
          DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ) STRICT;

      CREATE INDEX stock_movements_batch_created_idx
        ON stock_movements(batch_id, created_at, id);

      CREATE TRIGGER stock_movements_validate_stock
      BEFORE INSERT ON stock_movements
      WHEN NEW.movement_type IN (
        'sale', 'supplier_return', 'damage', 'expiry', 'adjustment_out'
      )
      AND NEW.quantity > (
        SELECT quantity_on_hand
        FROM product_batches
        WHERE id = NEW.batch_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'Insufficient stock');
      END;

      CREATE TRIGGER stock_movements_apply_stock
      AFTER INSERT ON stock_movements
      BEGIN
        UPDATE product_batches
        SET quantity_on_hand = quantity_on_hand +
          CASE
            WHEN NEW.movement_type IN (
              'opening_stock', 'purchase', 'customer_return', 'adjustment_in'
            ) THEN NEW.quantity
            ELSE -NEW.quantity
          END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = NEW.batch_id;
      END;

      CREATE TRIGGER stock_movements_no_update
      BEFORE UPDATE ON stock_movements
      BEGIN
        SELECT RAISE(ABORT, 'Stock movements are immutable');
      END;

      CREATE TRIGGER stock_movements_no_delete
      BEFORE DELETE ON stock_movements
      BEGIN
        SELECT RAISE(ABORT, 'Stock movements are immutable');
      END;
    `
  },

  {
    version: 5,
    name: "stock_ledger_integrity",
    sql: `
      CREATE TEMP TABLE migration_stock_balances AS
      SELECT
        pb.id AS batch_id,
        pb.quantity_on_hand AS balance,
        COALESCE(SUM(
          CASE
            WHEN sm.movement_type IN (
              'opening_stock', 'purchase', 'customer_return', 'adjustment_in'
            ) THEN sm.quantity
            ELSE -sm.quantity
          END
        ), 0) AS ledger_balance,
        COUNT(sm.id) AS movement_count
      FROM product_batches AS pb
      LEFT JOIN stock_movements AS sm ON sm.batch_id = pb.id
      GROUP BY pb.id;

      UPDATE product_batches
      SET quantity_on_hand = (
        SELECT ledger_balance
        FROM migration_stock_balances
        WHERE batch_id = product_batches.id
      )
      WHERE quantity_on_hand <> (
        SELECT ledger_balance
        FROM migration_stock_balances
        WHERE batch_id = product_batches.id
      );

      INSERT INTO stock_movements (
        batch_id, movement_type, quantity, reference, notes
      )
      SELECT
        batch_id,
        CASE
          WHEN ledger_balance = 0 AND movement_count = 0
            THEN 'opening_stock'
          WHEN balance > ledger_balance
            THEN 'adjustment_in'
          ELSE 'adjustment_out'
        END,
        ABS(balance - ledger_balance),
        'migration-v5',
        'Balance reconciled during stock ledger migration'
      FROM migration_stock_balances
      WHERE balance <> ledger_balance;

      DROP TABLE migration_stock_balances;

      CREATE TRIGGER product_batches_stock_insert_guard
      BEFORE INSERT ON product_batches
      WHEN NEW.quantity_on_hand <> 0
      BEGIN
        SELECT RAISE(ABORT, 'Stock quantity must start at zero');
      END;

      CREATE TRIGGER product_batches_stock_update_guard
      BEFORE UPDATE OF quantity_on_hand ON product_batches
      WHEN NEW.quantity_on_hand <> COALESCE((
        SELECT SUM(
          CASE
            WHEN movement_type IN (
              'opening_stock', 'purchase', 'customer_return', 'adjustment_in'
            ) THEN quantity
            ELSE -quantity
          END
        )
        FROM stock_movements
        WHERE batch_id = OLD.id
      ), 0)
      BEGIN
        SELECT RAISE(ABORT, 'Stock quantity must match movement history');
      END;
    `
  },
  {
    version: 6,
    name: "stock_balance_safe_integer_guard",
    sql: `
      CREATE TRIGGER stock_movements_validate_safe_balance
      BEFORE INSERT ON stock_movements
      WHEN NEW.movement_type IN (
        'opening_stock', 'purchase', 'customer_return', 'adjustment_in'
      )
      AND NEW.quantity > 9007199254740991 - (
        SELECT quantity_on_hand
        FROM product_batches
        WHERE id = NEW.batch_id
      )
      BEGIN
        SELECT RAISE(
          ABORT,
          'Stock balance exceeds JavaScript safe integer limit'
        );
      END;
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
