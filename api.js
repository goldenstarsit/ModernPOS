const MAX_BODY_BYTES = 16 * 1024;
const MAX_LIMIT = 100;

function sendJson(res, status, data, method = "GET", headers = {}) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
    ...headers
  });

  res.end(method === "HEAD" ? undefined : body);
}

function sendError(res, status, code, message, method, headers = {}) {
  sendJson(res, status, { error: { code, message } }, method, headers);
}

function productFromRow(row) {
  return row ? { ...row } : null;
}

function parsePositiveInteger(value) {
  if (!/^[1-9]\d*$/.test(value)) return null;

  const number = Number(value);
  return Number.isSafeInteger(number) ? number : null;
}

function validateProduct(input) {
  if (
    input === null ||
    typeof input !== "object" ||
    Array.isArray(input)
  ) {
    return "The request body must be a JSON object.";
  }

  if (typeof input.name !== "string" || !input.name.trim()) {
    return "Product name is required.";
  }

  if (input.name.trim().length > 200) {
    return "Product name must not exceed 200 characters.";
  }

  if (
    input.sku !== undefined &&
    input.sku !== null &&
    (typeof input.sku !== "string" || input.sku.trim().length > 100)
  ) {
    return "SKU must be a string of at most 100 characters.";
  }

  if (
    input.description !== undefined &&
    (typeof input.description !== "string" ||
      input.description.length > 2000)
  ) {
    return "Description must be a string of at most 2000 characters.";
  }

  if (
    input.unit !== undefined &&
    (typeof input.unit !== "string" ||
      !input.unit.trim() ||
      input.unit.trim().length > 50)
  ) {
    return "Unit must be a non-empty string of at most 50 characters.";
  }

  for (const field of ["cost_price_paisa", "sale_price_paisa"]) {
    if (
      input[field] !== undefined &&
      (!Number.isSafeInteger(input[field]) || input[field] < 0)
    ) {
      return `${field} must be a non-negative integer in paisa.`;
    }
  }

  if (
    input.is_active !== undefined &&
    typeof input.is_active !== "boolean"
  ) {
    return "is_active must be a boolean.";
  }

  return null;
}

async function readJsonBody(req) {
  const contentType = req.headers["content-type"] || "";

  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
    return { error: "Content-Type must be application/json.", status: 415 };
  }

  const contentLength = req.headers["content-length"];

  if (
    contentLength !== undefined &&
    (!/^\d+$/.test(contentLength) ||
      Number(contentLength) > MAX_BODY_BYTES)
  ) {
    return { error: "Request body is too large or invalid.", status: 413 };
  }

  let body = "";
  let bytes = 0;
  let tooLarge = false;

  try {
    for await (const chunk of req) {
      bytes += Buffer.byteLength(chunk);

      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        continue;
      }

      if (!tooLarge) {
        body += chunk.toString("utf8");
      }
    }
  } catch {
    return { error: "Unable to read request body.", status: 400 };
  }

  if (tooLarge) {
    return { error: "Request body is too large.", status: 413 };
  }

  try {
    return { value: JSON.parse(body) };
  } catch {
    return { error: "Request body must contain valid JSON.", status: 400 };
  }
}

function listProducts(req, res, db) {
  const url = new URL(req.url, "http://localhost");
  const rawLimit = url.searchParams.get("limit") ?? "50";
  const rawOffset = url.searchParams.get("offset") ?? "0";
  const limit = parsePositiveInteger(rawLimit);
  const offset = /^(0|[1-9]\d*)$/.test(rawOffset)
    ? Number(rawOffset)
    : null;

  if (limit === null || limit > MAX_LIMIT) {
    sendError(
      res, 400, "INVALID_LIMIT",
      `limit must be an integer between 1 and ${MAX_LIMIT}.`,
      req.method
    );
    return;
  }

  if (offset === null || !Number.isSafeInteger(offset)) {
    sendError(
      res, 400, "INVALID_OFFSET",
      "offset must be a non-negative integer.",
      req.method
    );
    return;
  }

  const query = (url.searchParams.get("q") || "").trim();

  if (query.length > 200) {
    sendError(
      res, 400, "INVALID_QUERY",
      "Search query must not exceed 200 characters.",
      req.method
    );
    return;
  }

  try {
    const where = query ? "WHERE name LIKE ? OR sku LIKE ?" : "";
    const params = query ? [`%${query}%`, `%${query}%`] : [];

    const total = db.prepare(
      `SELECT COUNT(*) AS total FROM products ${where}`
    ).get(...params).total;

    const rows = db.prepare(`
      SELECT id, sku, name, description, unit,
             cost_price_paisa, sale_price_paisa, is_active,
             created_at, updated_at
      FROM products
      ${where}
      ORDER BY id DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    sendJson(res, 200, {
      data: rows.map(productFromRow),
      pagination: { limit, offset, total }
    }, req.method);
  } catch {
    sendError(
      res, 500, "DATABASE_ERROR",
      "Unable to retrieve products.",
      req.method
    );
  }
}

function getProduct(req, res, db, rawId) {
  const id = parsePositiveInteger(rawId);

  if (id === null) {
    sendError(
      res, 400, "INVALID_PRODUCT_ID",
      "Product ID must be a positive integer.",
      req.method
    );
    return;
  }

  try {
    const row = db.prepare(`
      SELECT id, sku, name, description, unit,
             cost_price_paisa, sale_price_paisa, is_active,
             created_at, updated_at
      FROM products
      WHERE id = ?
    `).get(id);

    if (!row) {
      sendError(
        res, 404, "PRODUCT_NOT_FOUND",
        "Product not found.",
        req.method
      );
      return;
    }

    sendJson(res, 200, { data: productFromRow(row) }, req.method);
  } catch {
    sendError(
      res, 500, "DATABASE_ERROR",
      "Unable to retrieve the product.",
      req.method
    );
  }
}

async function createProduct(req, res, db) {
  const parsed = await readJsonBody(req);

  if (parsed.error) {
    sendError(
      res, parsed.status, "INVALID_REQUEST_BODY",
      parsed.error, req.method
    );
    return;
  }

  const validationError = validateProduct(parsed.value);

  if (validationError) {
    sendError(
      res, 400, "VALIDATION_ERROR",
      validationError, req.method
    );
    return;
  }

  const input = parsed.value;
  const sku = input.sku == null || !input.sku.trim()
    ? null
    : input.sku.trim();
  const name = input.name.trim();
  const description = input.description ?? "";
  const unit = input.unit === undefined ? "piece" : input.unit.trim();
  const costPrice = input.cost_price_paisa ?? 0;
  const salePrice = input.sale_price_paisa ?? 0;
  const isActive = input.is_active === undefined
    ? 1
    : Number(input.is_active);

  try {
    const result = db.prepare(`
      INSERT INTO products (
        sku, name, description, unit,
        cost_price_paisa, sale_price_paisa, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      sku, name, description, unit,
      costPrice, salePrice, isActive
    );

    const row = db.prepare(`
      SELECT id, sku, name, description, unit,
             cost_price_paisa, sale_price_paisa, is_active,
             created_at, updated_at
      FROM products
      WHERE id = ?
    `).get(Number(result.lastInsertRowid));

    sendJson(res, 201, { data: productFromRow(row) }, req.method);
  } catch (error) {
    if (
      error.code === "ERR_SQLITE_CONSTRAINT_UNIQUE" ||
      /UNIQUE constraint failed:\s*index/i.test(error.message)
    ) {
      sendError(
        res, 409, "DUPLICATE_SKU",
        "A product with this SKU already exists.",
        req.method
      );
      return;
    }

    sendError(
      res, 500, "DATABASE_ERROR",
      "Unable to create the product.",
      req.method
    );
  }
}

export async function handleApiRequest(req, res, pathname, db) {
  if (pathname !== "/api" && !pathname.startsWith("/api/")) {
    return false;
  }

  const productCollection = pathname === "/api/products";
  const productItem = /^\/api\/products\/([^/]+)$/.exec(pathname);
  const isReadMethod = req.method === "GET" || req.method === "HEAD";
  const isCreateMethod = req.method === "POST" && productCollection;

  if (!isReadMethod && !isCreateMethod) {
    sendError(
      res, 405, "METHOD_NOT_ALLOWED",
      "This HTTP method is not supported.",
      req.method,
      {
        Allow: productCollection
          ? "GET, HEAD, POST"
          : productItem
            ? "GET, HEAD"
            : "GET, HEAD"
      }
    );
    return true;
  }

  if (pathname === "/api/health") {
    sendJson(
      res, 200,
      { status: "ok", service: "ModernPOS" },
      req.method
    );
    return true;
  }

  if (pathname === "/api/health/database") {
    try {
      db.prepare("SELECT 1 AS ok").get();
      const migration = db.prepare(`
        SELECT MAX(version) AS version FROM schema_migrations
      `).get();

      sendJson(res, 200, {
        status: "ok",
        database: "connected",
        schemaVersion: migration.version
      }, req.method);
    } catch {
      sendError(
        res, 503, "DATABASE_UNAVAILABLE",
        "The database is currently unavailable.",
        req.method
      );
    }

    return true;
  }

  if (productCollection && isReadMethod) {
    listProducts(req, res, db);
    return true;
  }

  if (productItem && isReadMethod) {
    getProduct(req, res, db, productItem[1]);
    return true;
  }

  if (isCreateMethod) {
    await createProduct(req, res, db);
    return true;
  }

  sendError(
    res, 404, "NOT_FOUND",
    "API route not found.",
    req.method
  );
  return true;
}
