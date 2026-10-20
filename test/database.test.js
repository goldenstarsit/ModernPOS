import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/database.js";

function createTestDatabase(t) {
  const directory = mkdtempSync(
    join(tmpdir(), "modernpos-db-")
  );

  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  return join(directory, "test.sqlite");
}

test("database creates initial schema and records its migration", (t) => {
  const path = createTestDatabase(t);
  const db = openDatabase(path);

  try {
    const tables = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
      ORDER BY name
    `).all().map((row) => row.name);

    assert.deepEqual(tables, [
      "app_metadata",
      "product_batches",
      "products",
      "schema_migrations",
      "stock_movements"
    ]);

    assert.deepEqual(
      db.prepare(
        "SELECT version, name FROM schema_migrations ORDER BY version"
      ).all().map((row) => ({
        version: row.version,
        name: row.name
      })),
      [
        { version: 1, name: "initial_metadata" },
        { version: 2, name: "initial_products" },
        { version: 3, name: "initial_product_batches" },
        { version: 4, name: "initial_stock_movements" },
        { version: 5, name: "stock_ledger_integrity" },
        { version: 6, name: "stock_balance_safe_integer_guard" }
      ]
    );
  } finally {
    db.close();
  }
});

test("stock movements reject balances above the JavaScript safe integer limit", (t) => {
  const db = openDatabase(createTestDatabase(t));

  try {
    const product = db.prepare(
      "INSERT INTO products (sku, name) VALUES (?, ?)"
    ).run("SAFE-BALANCE-001", "Safe Balance Test");

    const batch = db.prepare(`
      INSERT INTO product_batches (
        product_id, batch_number, expiry_date, quantity_on_hand
      ) VALUES (?, ?, ?, 0)
    `).run(Number(product.lastInsertRowid), "SAFE-001", "2030-12-31");

    const batchId = Number(batch.lastInsertRowid);

    db.prepare(`
      INSERT INTO stock_movements (batch_id, movement_type, quantity)
      VALUES (?, 'purchase', ?)
    `).run(batchId, Number.MAX_SAFE_INTEGER);

    assert.throws(
      () => db.prepare(`
        INSERT INTO stock_movements (batch_id, movement_type, quantity)
        VALUES (?, 'purchase', 1)
      `).run(batchId),
      /Stock balance exceeds JavaScript safe integer limit/
    );

    assert.equal(
      db.prepare(
        "SELECT quantity_on_hand FROM product_batches WHERE id = ?"
      ).get(batchId).quantity_on_hand,
      Number.MAX_SAFE_INTEGER
    );

    assert.equal(
      db.prepare(
        "SELECT COUNT(*) AS count FROM stock_movements WHERE batch_id = ?"
      ).get(batchId).count,
      1
    );
  } finally {
    db.close();
  }
});

test("database preserves metadata after reopening", (t) => {
  const path = createTestDatabase(t);

  const first = openDatabase(path);

  try {
    first.prepare(`
      INSERT INTO app_metadata (key, value)
      VALUES (?, ?)
    `).run("test.setting", "saved-value");
  } finally {
    first.close();
  }

  const second = openDatabase(path);

  try {
    const row = second.prepare(`
      SELECT key, value, updated_at
      FROM app_metadata
      WHERE key = ?
    `).get("test.setting");

    assert.equal(row.key, "test.setting");
    assert.equal(row.value, "saved-value");
    assert.ok(row.updated_at);
    assert.equal(
      second.prepare(
        "SELECT COUNT(*) AS count FROM schema_migrations"
      ).get().count,
      6
    );
  } finally {
    second.close();
  }
});

test("database enables foreign keys and passes integrity check", (t) => {
  const db = openDatabase(createTestDatabase(t));

  try {
    assert.equal(
      db.prepare("PRAGMA foreign_keys").get().foreign_keys,
      1
    );

    assert.equal(
      db.prepare("PRAGMA integrity_check").get().integrity_check,
      "ok"
    );
  } finally {
    db.close();
  }
});


test("products enforce required fields, valid prices, and unique SKUs", (t) => {
  const db = openDatabase(createTestDatabase(t));

  try {
    const insert = db.prepare(`
      INSERT INTO products (
        sku, name, unit, cost_price_paisa, sale_price_paisa
      )
      VALUES (?, ?, ?, ?, ?)
    `);

    insert.run("MED-001", "Paracetamol", "tablet", 250, 400);

    assert.throws(
      () => insert.run("MED-002", "   ", "tablet", 250, 400),
      /CHECK constraint failed/
    );

    assert.throws(
      () => insert.run("MED-002", "Test product", "piece", -1, 100),
      /CHECK constraint failed/
    );

    assert.throws(
      () => insert.run("med-001", "Duplicate SKU", "box", 100, 200),
      /UNIQUE constraint failed/
    );

    const product = db.prepare(`
      SELECT sku, name, unit, cost_price_paisa, sale_price_paisa, is_active
      FROM products
      WHERE sku = ?
    `).get("MED-001");

    assert.deepEqual({ ...product }, {
      sku: "MED-001",
      name: "Paracetamol",
      unit: "tablet",
      cost_price_paisa: 250,
      sale_price_paisa: 400,
      is_active: 1
    });
  } finally {
    db.close();
  }
});


test("product batches enforce product links, valid quantities, and unique batch numbers", (t) => {
  const db = openDatabase(createTestDatabase(t));

  try {
    const product = db.prepare(`
      INSERT INTO products (sku, name)
      VALUES (?, ?)
    `).run("MED-BATCH-001", "Sample Medicine");

    const productId = Number(product.lastInsertRowid);
    const insertBatch = db.prepare(`
      INSERT INTO product_batches (
        product_id, batch_number, expiry_date,
        quantity_on_hand, cost_price_paisa
      ) VALUES (?, ?, ?, ?, ?)
    `);

    insertBatch.run(productId, "BATCH-001", "2027-12-31", 0, 250);

    const batchId = Number(db.prepare(`
      SELECT id FROM product_batches
      WHERE product_id = ? AND batch_number = ?
    `).get(productId, "BATCH-001").id);

    db.prepare(`
      INSERT INTO stock_movements (batch_id, movement_type, quantity)
      VALUES (?, 'opening_stock', 100)
    `).run(batchId);

    assert.throws(
      () => insertBatch.run(productId, "BATCH-001", "2028-01-31", 0, 250),
      /UNIQUE constraint failed/
    );

    assert.throws(
      () => insertBatch.run(productId, "BATCH-002", "2027-12-31", -1, 250),
      /Stock quantity must start at zero|CHECK constraint failed/
    );

    assert.throws(
      () => insertBatch.run(productId, "BATCH-INVALID-DATE", "2027-99-99", 0, 250),
      /CHECK constraint failed/
    );

    assert.throws(
      () => insertBatch.run(productId, "BATCH-INVALID-DAY", "2027-02-29", 0, 250),
      /CHECK constraint failed/
    );

    assert.throws(
      () => insertBatch.run(999999, "BATCH-003", "2027-12-31", 0, 250),
      /FOREIGN KEY constraint failed/
    );

    const batch = db.prepare(`
      SELECT batch_number, expiry_date, quantity_on_hand, cost_price_paisa
      FROM product_batches
      WHERE product_id = ?
    `).get(productId);

    assert.deepEqual({ ...batch }, {
      batch_number: "BATCH-001",
      expiry_date: "2027-12-31",
      quantity_on_hand: 100,
      cost_price_paisa: 250
    });
  } finally {
    db.close();
  }
});


test("stock movements update batch quantities and preserve immutable history", (t) => {
  const db = openDatabase(createTestDatabase(t));

  try {
    const product = db.prepare(`
      INSERT INTO products (sku, name)
      VALUES (?, ?)
    `).run("STOCK-001", "Stock Test Product");

    const batch = db.prepare(`
      INSERT INTO product_batches (
        product_id, batch_number, expiry_date, quantity_on_hand
      ) VALUES (?, ?, ?, ?)
    `).run(Number(product.lastInsertRowid), "STOCK-BATCH-001", "2028-12-31", 0);

    const batchId = Number(batch.lastInsertRowid);
    const addMovement = db.prepare(`
      INSERT INTO stock_movements (batch_id, movement_type, quantity, notes)
      VALUES (?, ?, ?, ?)
    `);

    addMovement.run(batchId, "purchase", 100, "Initial delivery");
    addMovement.run(batchId, "sale", 30, "Customer sale");

    assert.equal(
      db.prepare("SELECT quantity_on_hand FROM product_batches WHERE id = ?")
        .get(batchId).quantity_on_hand,
      70
    );

    assert.throws(
      () => addMovement.run(batchId, "sale", 71, "Excess sale"),
      /Insufficient stock/
    );

    const movement = db.prepare(`
      SELECT movement_type, quantity, notes
      FROM stock_movements
      WHERE batch_id = ?
      ORDER BY id
    `).all(batchId);

    assert.deepEqual(movement.map((row) => ({ ...row })), [
      { movement_type: "purchase", quantity: 100, notes: "Initial delivery" },
      { movement_type: "sale", quantity: 30, notes: "Customer sale" }
    ]);

    assert.throws(
      () => db.prepare(`
        UPDATE stock_movements SET quantity = 99 WHERE batch_id = ?
      `).run(batchId),
      /Stock movements are immutable/
    );

    assert.throws(
      () => db.prepare(`
        DELETE FROM stock_movements WHERE batch_id = ?
      `).run(batchId),
      /Stock movements are immutable/
    );

    assert.equal(
      db.prepare("SELECT quantity_on_hand FROM product_batches WHERE id = ?")
        .get(batchId).quantity_on_hand,
      70
    );
  } finally {
    db.close();
  }
});

test("stock ledger rejects direct batch balance changes", (t) => {
  const db = openDatabase(createTestDatabase(t));

  try {
    const product = db.prepare(
      "INSERT INTO products (sku, name) VALUES (?, ?)"
    ).run("STOCK-GUARD-001", "Stock Guard Test");

    const productId = Number(product.lastInsertRowid);
    const insertBatch = db.prepare(`
      INSERT INTO product_batches (
        product_id, batch_number, expiry_date, quantity_on_hand
      ) VALUES (?, ?, ?, ?)
    `);

    assert.throws(
      () => insertBatch.run(productId, "GUARD-BAD", "2030-12-31", 5),
      /Stock quantity must start at zero/
    );

    const batch = insertBatch.run(
      productId, "GUARD-OK", "2030-12-31", 0
    );
    const batchId = Number(batch.lastInsertRowid);

    db.prepare(`
      INSERT INTO stock_movements (batch_id, movement_type, quantity)
      VALUES (?, 'purchase', 20)
    `).run(batchId);

    assert.throws(
      () => db.prepare(
        "UPDATE product_batches SET quantity_on_hand = 999 WHERE id = ?"
      ).run(batchId),
      /Stock quantity must match movement history/
    );

    assert.equal(
      db.prepare(
        "SELECT quantity_on_hand FROM product_batches WHERE id = ?"
      ).get(batchId).quantity_on_hand,
      20
    );
  } finally {
    db.close();
  }
});

test("migration 5 reconciles legacy batch balances without double-counting", (t) => {
  const path = createTestDatabase(t);
  let db = openDatabase(path);

  const product = db.prepare(
    "INSERT INTO products (sku, name) VALUES (?, ?)"
  ).run("STOCK-MIGRATION-001", "Legacy Stock Test");

  const batch = db.prepare(`
    INSERT INTO product_batches (
      product_id, batch_number, expiry_date, quantity_on_hand
    ) VALUES (?, ?, ?, 0)
  `).run(Number(product.lastInsertRowid), "LEGACY-001", "2030-12-31");

  const batchId = Number(batch.lastInsertRowid);

  try {
    db.exec("DROP TRIGGER product_batches_stock_insert_guard");
    db.exec("DROP TRIGGER product_batches_stock_update_guard");
    db.prepare(
      "UPDATE product_batches SET quantity_on_hand = 37 WHERE id = ?"
    ).run(batchId);
    db.prepare(
      "DELETE FROM schema_migrations WHERE version = 5"
    ).run();
  } finally {
    db.close();
  }

  db = openDatabase(path);

  try {
    assert.equal(
      db.prepare(
        "SELECT quantity_on_hand FROM product_batches WHERE id = ?"
      ).get(batchId).quantity_on_hand,
      37
    );

    const movements = db.prepare(`
      SELECT movement_type, quantity, reference
      FROM stock_movements WHERE batch_id = ? ORDER BY id
    `).all(batchId);

    assert.deepEqual(movements.map((row) => ({ ...row })), [{
      movement_type: "opening_stock",
      quantity: 37,
      reference: "migration-v5"
    }]);

    assert.throws(
      () => db.prepare(
        "UPDATE product_batches SET quantity_on_hand = 38 WHERE id = ?"
      ).run(batchId),
      /Stock quantity must match movement history/
    );
  } finally {
    db.close();
  }
});

test("migration 5 reconciles legacy balances against existing movement ledgers", (t) => {
  const scenarios = [
    { name: "legacy balance above ledger", legacyBalance: 27, expectedType: "adjustment_in" },
    { name: "legacy balance below ledger", legacyBalance: 13, expectedType: "adjustment_out" }
  ];

  for (const scenario of scenarios) {
    const path = createTestDatabase(t);
    let db = openDatabase(path);
    let batchId;

    try {
      const product = db.prepare(
        "INSERT INTO products (sku, name) VALUES (?, ?)"
      ).run(
        scenario.expectedType === "adjustment_in" ? "MIGRATION-IN-001" : "MIGRATION-OUT-001",
        scenario.name
      );

      const batch = db.prepare(`
        INSERT INTO product_batches (
          product_id, batch_number, expiry_date, quantity_on_hand
        ) VALUES (?, ?, ?, 0)
      `).run(Number(product.lastInsertRowid), "LEDGER-001", "2030-12-31");

      batchId = Number(batch.lastInsertRowid);

      db.prepare(`
        INSERT INTO stock_movements (batch_id, movement_type, quantity)
        VALUES (?, 'purchase', 20)
      `).run(batchId);

      db.exec(`
        DROP TRIGGER product_batches_stock_insert_guard;
        DROP TRIGGER product_batches_stock_update_guard;
      `);

      db.prepare(
        "UPDATE product_batches SET quantity_on_hand = ? WHERE id = ?"
      ).run(scenario.legacyBalance, batchId);

      db.prepare(
        "DELETE FROM schema_migrations WHERE version = 5"
      ).run();
    } finally {
      db.close();
    }

    db = openDatabase(path);

    try {
      assert.equal(
        db.prepare(
          "SELECT quantity_on_hand FROM product_batches WHERE id = ?"
        ).get(batchId).quantity_on_hand,
        scenario.legacyBalance,
        scenario.name
      );

      const reconciliation = db.prepare(`
        SELECT movement_type, quantity, reference
        FROM stock_movements
        WHERE batch_id = ? AND reference = 'migration-v5'
      `).get(batchId);

      assert.deepEqual(
        { ...reconciliation },
        {
          movement_type: scenario.expectedType,
          quantity: 7,
          reference: "migration-v5"
        },
        scenario.name
      );

      const ledgerBalance = db.prepare(`
        SELECT SUM(
          CASE
            WHEN movement_type IN (
              'opening_stock', 'purchase', 'customer_return', 'adjustment_in'
            ) THEN quantity
            ELSE -quantity
          END
        ) AS balance
        FROM stock_movements
        WHERE batch_id = ?
      `).get(batchId).balance;

      assert.equal(ledgerBalance, scenario.legacyBalance, scenario.name);
    } finally {
      db.close();
    }
  }
});
