import test from "node:test";
import assert from "node:assert/strict";
import { createStockMovement, listStockMovements } from "../services/stockMovementService.js";

test("stock movement listing validates pagination before database access", () => {
  const invalidLimits = [0, -1, 1.5, 101, Number.MAX_SAFE_INTEGER + 1];
  const invalidOffsets = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1];

  for (const limit of invalidLimits) {
    assert.throws(
      () => listStockMovements({}, { limit }),
      (error) => error.code === "INVALID_LIMIT" && error.status === 400,
      `limit=${limit}`
    );
  }

  for (const offset of invalidOffsets) {
    assert.throws(
      () => listStockMovements({}, { offset }),
      (error) => error.code === "INVALID_OFFSET" && error.status === 400,
      `offset=${offset}`
    );
  }
});

test("stock movement listing accepts valid pagination values", () => {
  const db = {
    prepare(sql) {
      return {
        get() {
          assert.match(sql, /COUNT\(\*\)/);
          return { total: 0 };
        },
        all(...params) {
          assert.deepEqual(params, [100, 0]);
          return [];
        }
      };
    }
  };

  assert.deepEqual(
    listStockMovements(db, { limit: 100, offset: 0 }),
    {
      data: [],
      pagination: { limit: 100, offset: 0, total: 0 }
    }
  );
});

test("stock movement listing preserves valid offset, total, and result rows", () => {
  const row = {
    id: 7,
    batch_id: 3,
    movement_type: "receipt"
  };

  const db = {
    prepare(sql) {
      return {
        get(...params) {
          assert.match(sql, /COUNT\(\*\)/);
          assert.deepEqual(params, []);
          return { total: 40 };
        },
        all(...params) {
          assert.match(sql, /ORDER BY sm\.id DESC/);
          assert.match(sql, /LIMIT \? OFFSET \?/);
          assert.deepEqual(params, [10, 25]);
          return [row];
        }
      };
    }
  };

  const result = listStockMovements(db, {
    limit: 10,
    offset: 25
  });

  assert.deepEqual(result, {
    data: [row],
    pagination: {
      limit: 10,
      offset: 25,
      total: 40
    }
  });
  assert.notEqual(result.data[0], row);
});

test("stock movement creation rolls back and preserves the original database error", () => {
  const originalError = new Error("Unexpected database write failure");
  const statements = [];

  const db = {
    exec(sql) {
      statements.push(sql);
    },
    prepare(sql) {
      if (/SELECT id, quantity_on_hand/.test(sql)) {
        return {
          get(batchId) {
            assert.equal(batchId, 3);
            return { id: 3, quantity_on_hand: 10 };
          }
        };
      }

      if (/INSERT INTO stock_movements/.test(sql)) {
        return {
          run() {
            throw originalError;
          }
        };
      }

      assert.fail(`Unexpected SQL statement: ${sql}`);
    }
  };

  assert.throws(
    () => createStockMovement(db, {
      batch_id: 3,
      movement_type: "purchase",
      quantity: 5
    }),
    (error) => error === originalError
  );

  assert.deepEqual(statements, [
    "BEGIN IMMEDIATE",
    "ROLLBACK"
  ]);
});

test("stock movement creation rolls back when reading the inserted movement fails", () => {
  const originalError = new Error("Unexpected movement read failure");
  const statements = [];

  const db = {
    exec(sql) {
      statements.push(sql);
    },
    prepare(sql) {
      if (/SELECT id, quantity_on_hand/.test(sql)) {
        return {
          get(batchId) {
            assert.equal(batchId, 3);
            return { id: 3, quantity_on_hand: 10 };
          }
        };
      }

      if (/INSERT INTO stock_movements/.test(sql)) {
        return {
          run(...params) {
            assert.deepEqual(params, [
              3,
              "purchase",
              5,
              "",
              ""
            ]);
            return { lastInsertRowid: 41 };
          }
        };
      }

      if (/WHERE sm\.id = \?/.test(sql)) {
        return {
          get(movementId) {
            assert.equal(movementId, 41);
            throw originalError;
          }
        };
      }

      assert.fail(`Unexpected SQL statement: ${sql}`);
    }
  };

  assert.throws(
    () => createStockMovement(db, {
      batch_id: 3,
      movement_type: "purchase",
      quantity: 5
    }),
    (error) => error === originalError
  );

  assert.deepEqual(statements, [
    "BEGIN IMMEDIATE",
    "ROLLBACK"
  ]);
});

test("stock movement creation rolls back and preserves the original commit error", () => {
  const originalError = new Error("Unexpected commit failure");
  const statements = [];

  const db = {
    exec(sql) {
      statements.push(sql);

      if (sql === "COMMIT") {
        throw originalError;
      }
    },
    prepare(sql) {
      if (/SELECT id, quantity_on_hand/.test(sql)) {
        return {
          get(batchId) {
            assert.equal(batchId, 3);
            return { id: 3, quantity_on_hand: 10 };
          }
        };
      }

      if (/INSERT INTO stock_movements/.test(sql)) {
        return {
          run(...params) {
            assert.deepEqual(params, [
              3,
              "purchase",
              5,
              "",
              ""
            ]);
            return { lastInsertRowid: 41 };
          }
        };
      }

      if (/WHERE sm\.id = \?/.test(sql)) {
        return {
          get(movementId) {
            assert.equal(movementId, 41);
            return {
              id: 41,
              batch_id: 3,
              movement_type: "purchase",
              quantity: 5
            };
          }
        };
      }

      assert.fail(`Unexpected SQL statement: ${sql}`);
    }
  };

  assert.throws(
    () => createStockMovement(db, {
      batch_id: 3,
      movement_type: "purchase",
      quantity: 5
    }),
    (error) => error === originalError
  );

  assert.deepEqual(statements, [
    "BEGIN IMMEDIATE",
    "COMMIT",
    "ROLLBACK"
  ]);
});

test("stock movement creation preserves the original error when rollback also fails", () => {
  const originalError = new Error("Unexpected database write failure");
  const rollbackError = new Error("Unexpected rollback failure");
  const statements = [];

  const db = {
    exec(sql) {
      statements.push(sql);

      if (sql === "ROLLBACK") {
        throw rollbackError;
      }
    },
    prepare(sql) {
      if (/SELECT id, quantity_on_hand/.test(sql)) {
        return {
          get(batchId) {
            assert.equal(batchId, 3);
            return { id: 3, quantity_on_hand: 10 };
          }
        };
      }

      if (/INSERT INTO stock_movements/.test(sql)) {
        return {
          run() {
            throw originalError;
          }
        };
      }

      assert.fail(`Unexpected SQL statement: ${sql}`);
    }
  };

  assert.throws(
    () => createStockMovement(db, {
      batch_id: 3,
      movement_type: "purchase",
      quantity: 5
    }),
    (error) => error === originalError
  );

  assert.deepEqual(statements, [
    "BEGIN IMMEDIATE",
    "ROLLBACK"
  ]);
});

test("stock movement creation rejects a missing batch and rolls back", () => {
  const statements = [];

  const db = {
    exec(sql) {
      statements.push(sql);
    },
    prepare(sql) {
      if (/SELECT id, quantity_on_hand/.test(sql)) {
        return {
          get(batchId) {
            assert.equal(batchId, 999999);
            return undefined;
          }
        };
      }

      assert.fail(`Unexpected SQL statement: ${sql}`);
    }
  };

  assert.throws(
    () => createStockMovement(db, {
      batch_id: 999999,
      movement_type: "purchase",
      quantity: 5
    }),
    (error) =>
      error.code === "BATCH_NOT_FOUND" &&
      error.status === 404 &&
      error.message === "The specified product batch does not exist."
  );

  assert.deepEqual(statements, [
    "BEGIN IMMEDIATE",
    "ROLLBACK"
  ]);
});
