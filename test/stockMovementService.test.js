import test from "node:test";
import assert from "node:assert/strict";
import { listStockMovements } from "../services/stockMovementService.js";

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
