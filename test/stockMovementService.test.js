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
