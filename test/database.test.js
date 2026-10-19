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
      "products",
      "schema_migrations"
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
        { version: 2, name: "initial_products" }
      ]
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
      2
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
