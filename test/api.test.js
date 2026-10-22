import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../db/database.js";
import { handleApiRequest } from "../api.js";

function createResponseCapture() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) {
      this.status = status;
      this.headers = headers;
    },
    end(body) {
      this.body = body;
    }
  };
}

function createTestDatabase(t) {
  const directory = mkdtempSync(join(tmpdir(), "modernpos-api-"));

  t.after(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  const db = openDatabase(join(directory, "test.sqlite"));
  t.after(() => db.close());
  return db;
}

async function getProducts(db, query = "") {
  const req = {
    method: "GET",
    url: `/api/products${query}`,
    headers: {}
  };
  const res = createResponseCapture();
  const handled = await handleApiRequest(req, res, "/api/products", db);

  assert.equal(handled, true);
  return { status: res.status, headers: res.headers, body: JSON.parse(res.body) };
}

function insertProduct(db, sku, name) {
  return db.prepare(`
    INSERT INTO products (sku, name, unit, cost_price_paisa, sale_price_paisa)
    VALUES (?, ?, 'piece', 12500, 18000)
  `).run(sku, name);
}

test("database health endpoint returns a safe 503 when the database fails", async () => {
  let status;
  let headers;
  let body;

  const req = { method: "GET" };
  const res = {
    writeHead(code, responseHeaders) {
      status = code;
      headers = responseHeaders;
    },
    end(responseBody) {
      body = responseBody;
    }
  };

  const db = {
    prepare() {
      throw new Error("Internal database error");
    }
  };

  const handled = await handleApiRequest(
    req,
    res,
    "/api/health/database",
    db
  );

  assert.equal(handled, true);
  assert.equal(status, 503);
  assert.match(headers["Content-Type"], /application\/json/);
  assert.deepEqual(JSON.parse(body), {
    error: {
      code: "DATABASE_UNAVAILABLE",
      message: "The database is currently unavailable."
    }
  });
  assert.equal(body.includes("Internal database error"), false);
});

test("product list returns a safe database error when querying fails", async () => {
  const req = { method: "GET", url: "/api/products", headers: {} };
  const res = createResponseCapture();
  const db = {
    prepare() {
      throw new Error("Internal database details");
    }
  };

  const handled = await handleApiRequest(req, res, "/api/products", db);

  assert.equal(handled, true);
  assert.equal(res.status, 500);
  assert.match(res.headers["Content-Type"], /application\/json/);
  assert.deepEqual(JSON.parse(res.body), {
    error: {
      code: "DATABASE_ERROR",
      message: "Unable to retrieve products."
    }
  });
  assert.equal(res.body.includes("Internal database details"), false);
});

test("product list returns products in descending ID order with pagination metadata", async (t) => {
  const db = createTestDatabase(t);
  insertProduct(db, "PAGE-001", "First Product");
  insertProduct(db, "PAGE-002", "Second Product");
  insertProduct(db, "PAGE-003", "Third Product");

  const result = await getProducts(db, "?limit=2&offset=1");

  assert.equal(result.status, 200);
  assert.match(result.headers["Content-Type"], /application\/json/);
  assert.deepEqual(result.body.pagination, {
    limit: 2,
    offset: 1,
    total: 3
  });
  assert.deepEqual(
    result.body.data.map((product) => product.sku),
    ["PAGE-002", "PAGE-001"]
  );
});

test("product search matches product names and SKUs", async (t) => {
  const db = createTestDatabase(t);
  insertProduct(db, "MED-ALPHA", "Pain Relief Tablets");
  insertProduct(db, "VIT-BETA", "Daily Vitamin");
  insertProduct(db, "OTHER-GAMMA", "Pain Relief Cream");

  const byName = await getProducts(db, "?q=Vitamin");
  assert.equal(byName.status, 200);
  assert.equal(byName.body.pagination.total, 1);
  assert.deepEqual(
    byName.body.data.map((product) => product.sku),
    ["VIT-BETA"]
  );

  const bySku = await getProducts(db, "?q=MED-ALPHA");
  assert.equal(bySku.body.pagination.total, 1);
  assert.deepEqual(
    bySku.body.data.map((product) => product.sku),
    ["MED-ALPHA"]
  );
});

test("product search treats SQL LIKE wildcard characters literally", async (t) => {
  const db = createTestDatabase(t);
  insertProduct(db, "WILD-001", "100% Cotton");
  insertProduct(db, "WILD-002", "100X Cotton");
  insertProduct(db, "UNDER_001", "Under Score Product");
  insertProduct(db, "UNDERX001", "Under X Product");

  const percent = await getProducts(db, "?q=%25");
  assert.equal(percent.body.pagination.total, 1);
  assert.equal(percent.body.data[0].name, "100% Cotton");

  const underscore = await getProducts(db, "?q=%5F");
  assert.equal(underscore.body.pagination.total, 1);
  assert.equal(underscore.body.data[0].sku, "UNDER_001");
});

test("product list rejects invalid pagination and overlong search queries", async (t) => {
  const db = createTestDatabase(t);

  const invalidLimit = await getProducts(db, "?limit=0");
  assert.equal(invalidLimit.status, 400);
  assert.equal(invalidLimit.body.error.code, "INVALID_LIMIT");

  const invalidOffset = await getProducts(db, "?offset=-1");
  assert.equal(invalidOffset.status, 400);
  assert.equal(invalidOffset.body.error.code, "INVALID_OFFSET");

  const longQuery = "x".repeat(201);
  const invalidQuery = await getProducts(db, `?q=${longQuery}`);
  assert.equal(invalidQuery.status, 400);
  assert.equal(invalidQuery.body.error.code, "INVALID_QUERY");
});

test("unknown API routes return the documented not-found response", async () => {
  const req = { method: "GET", url: "/api/unknown", headers: {} };
  const res = createResponseCapture();

  const handled = await handleApiRequest(req, res, "/api/unknown", {});

  assert.equal(handled, true);
  assert.equal(res.status, 404);
  assert.deepEqual(JSON.parse(res.body), {
    error: {
      code: "NOT_FOUND",
      message: "API route not found."
    }
  });
});

test("paths outside the API are not handled by the API router", async () => {
  const req = { method: "GET", url: "/health", headers: {} };
  const res = createResponseCapture();

  const handled = await handleApiRequest(req, res, "/health", {});

  assert.equal(handled, false);
  assert.equal(res.status, null);
  assert.equal(res.body, null);
});

test("product detail returns a safe database error when querying fails", async () => {
  const req = {
    method: "GET",
    url: "/api/products/1",
    headers: {}
  };
  const res = createResponseCapture();
  const db = {
    prepare() {
      throw new Error("Internal product database details");
    }
  };

  const handled = await handleApiRequest(
    req,
    res,
    "/api/products/1",
    db
  );

  assert.equal(handled, true);
  assert.equal(res.status, 500);
  assert.match(res.headers["Content-Type"], /application\/json/);
  assert.deepEqual(JSON.parse(res.body), {
    error: {
      code: "DATABASE_ERROR",
      message: "Unable to retrieve the product."
    }
  });
  assert.equal(
    res.body.includes("Internal product database details"),
    false
  );
});
