const MOVEMENT_TYPES = new Set([
  "opening_stock",
  "purchase",
  "sale",
  "customer_return",
  "supplier_return",
  "damage",
  "expiry",
  "adjustment_in",
  "adjustment_out"
]);

const INCOMING_TYPES = new Set([
  "opening_stock",
  "purchase",
  "customer_return",
  "adjustment_in"
]);

export class StockMovementError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "StockMovementError";
    this.code = code;
    this.status = status;
  }
}

function validateMovement(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    throw new StockMovementError(
      "VALIDATION_ERROR",
      "The request body must be a JSON object.",
      400
    );
  }

  if (!Number.isSafeInteger(input.batch_id) || input.batch_id <= 0) {
    throw new StockMovementError(
      "VALIDATION_ERROR",
      "batch_id must be a positive integer.",
      400
    );
  }

  if (
    typeof input.movement_type !== "string" ||
    !MOVEMENT_TYPES.has(input.movement_type)
  ) {
    throw new StockMovementError(
      "VALIDATION_ERROR",
      "movement_type is not supported.",
      400
    );
  }

  if (!Number.isSafeInteger(input.quantity) || input.quantity <= 0) {
    throw new StockMovementError(
      "VALIDATION_ERROR",
      "quantity must be a positive integer.",
      400
    );
  }

  for (const field of ["reference", "notes"]) {
    if (
      input[field] !== undefined &&
      (typeof input[field] !== "string" || input[field].length > 1000)
    ) {
      throw new StockMovementError(
        "VALIDATION_ERROR",
        `${field} must be a string of at most 1000 characters.`,
        400
      );
    }
  }
}

const MOVEMENT_SELECT = `
  SELECT
    sm.id,
    sm.batch_id,
    sm.movement_type,
    sm.quantity,
    sm.reference,
    sm.notes,
    sm.created_at,
    pb.product_id,
    pb.batch_number,
    pb.expiry_date,
    pb.quantity_on_hand AS current_quantity_on_hand,
    p.name AS product_name,
    p.sku AS product_sku
  FROM stock_movements sm
  JOIN product_batches pb ON pb.id = sm.batch_id
  JOIN products p ON p.id = pb.product_id
`;

export function listStockMovements(db, {
  batchId = null,
  limit = 50,
  offset = 0
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new StockMovementError(
      "INVALID_LIMIT",
      "limit must be an integer between 1 and 100.",
      400
    );
  }

  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new StockMovementError(
      "INVALID_OFFSET",
      "offset must be a non-negative integer.",
      400
    );
  }

  const conditions = [];
  const params = [];

  if (batchId !== null) {
    if (!Number.isSafeInteger(batchId) || batchId <= 0) {
      throw new StockMovementError(
        "INVALID_BATCH_ID",
        "batch_id must be a positive integer.",
        400
      );
    }

    conditions.push("sm.batch_id = ?");
    params.push(batchId);
  }

  const where = conditions.length
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  const total = db.prepare(`
    SELECT COUNT(*) AS total
    FROM stock_movements sm
    ${where}
  `).get(...params).total;

  const rows = db.prepare(`
    ${MOVEMENT_SELECT}
    ${where}
    ORDER BY sm.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  return {
    data: rows.map((row) => ({ ...row })),
    pagination: { limit, offset, total }
  };
}

export function createStockMovement(db, input) {
  validateMovement(input);

  const reference = input.reference ?? "";
  const notes = input.notes ?? "";

  try {
    db.exec("BEGIN IMMEDIATE");

    const batch = db.prepare(`
      SELECT id, quantity_on_hand
      FROM product_batches
      WHERE id = ?
    `).get(input.batch_id);

    if (!batch) {
      throw new StockMovementError(
        "BATCH_NOT_FOUND",
        "The specified product batch does not exist.",
        404
      );
    }

    const result = db.prepare(`
      INSERT INTO stock_movements (
        batch_id, movement_type, quantity, reference, notes
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      input.batch_id,
      input.movement_type,
      input.quantity,
      reference,
      notes
    );

    const movement = db.prepare(`
      ${MOVEMENT_SELECT}
      WHERE sm.id = ?
    `).get(Number(result.lastInsertRowid));

    db.exec("COMMIT");

    return { ...movement };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original error if rollback itself fails.
    }

    if (error instanceof StockMovementError) {
      throw error;
    }

    if (/Stock balance exceeds JavaScript safe integer limit/i.test(error.message)) {
      throw new StockMovementError(
        "STOCK_BALANCE_LIMIT",
        "The resulting stock balance exceeds the supported safe integer limit.",
        409
      );
    }

    if (/Insufficient stock/i.test(error.message)) {
      throw new StockMovementError(
        "INSUFFICIENT_STOCK",
        "The movement quantity exceeds available stock.",
        409
      );
    }

    if (
      error.code === "ERR_SQLITE_CONSTRAINT_FOREIGNKEY" ||
      /FOREIGN KEY constraint failed/i.test(error.message)
    ) {
      throw new StockMovementError(
        "BATCH_NOT_FOUND",
        "The specified product batch does not exist.",
        404
      );
    }

    throw error;
  }
}

export { INCOMING_TYPES, MOVEMENT_TYPES };
