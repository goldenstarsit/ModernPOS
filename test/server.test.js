import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "../db/database.js";

const HOST = "127.0.0.1";

async function getAvailablePort() {
  const probe = createServer();

  await new Promise((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, HOST, resolve);
  });

  const address = probe.address();
  const port = address.port;

  await new Promise((resolve, reject) => {
    probe.close((error) => error ? reject(error) : resolve());
  });

  return port;
}

async function startServer(port, t, setupDatabase) {
  const baseUrl = `http://${HOST}:${port}`;
  const directory = mkdtempSync(join(tmpdir(), "modernpos-http-"));
  const databasePath = join(directory, "test.sqlite");

  if (setupDatabase) {
    const db = openDatabase(databasePath);
    try {
      setupDatabase(db);
    } finally {
      db.close();
    }
  }

  const child = spawn(process.execPath, ["server.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST,
      PORT: String(port),
      DATABASE_PATH: databasePath
    },
    stdio: "ignore"
  });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once("exit", resolve));
      child.kill("SIGTERM");
      await exited;
    }

    rmSync(directory, { recursive: true, force: true });
  });

  try {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (child.exitCode !== null) {
        throw new Error(`Server exited with code ${child.exitCode}`);
      }

      try {
        const response = await fetch(baseUrl);

        if (response.ok) return { child, baseUrl };
      } catch {
        // The server may still be starting.
      }

      await delay(100);
    }

    throw new Error("Server did not become ready in time");
  } catch (error) {
    child.kill();
    throw error;
  }
}

test("static server preserves basic HTTP behavior", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);

  const homepage = await fetch(baseUrl);
  assert.equal(homepage.status, 200);
  assert.match(
    homepage.headers.get("content-type") || "",
    /text\/html/
  );
  assert.equal(
    homepage.headers.get("x-content-type-options"),
    "nosniff"
  );

  const missing = await fetch(`${baseUrl}/missing-file`);
  assert.equal(missing.status, 404);

  const unsupported = await fetch(baseUrl, { method: "POST" });
  assert.equal(unsupported.status, 405);
  assert.match(unsupported.headers.get("allow") || "", /GET/);
});

test("health endpoint returns JSON success", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);

  const response = await fetch(`${baseUrl}/api/health`);

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") || "",
    /application\/json/
  );
  assert.equal(
    response.headers.get("x-content-type-options"),
    "nosniff"
  );
  assert.deepEqual(await response.json(), {
    status: "ok",
    service: "ModernPOS"
  });
});

test("unknown API routes return a JSON 404", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);

  const response = await fetch(`${baseUrl}/api/unknown`);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: {
      code: "NOT_FOUND",
      message: "API route not found."
    }
  });
});

test("unsupported API methods return a JSON 405", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);

  const response = await fetch(`${baseUrl}/api/health`, {
    method: "POST"
  });

  assert.equal(response.status, 405);
  assert.match(response.headers.get("allow") || "", /GET/);
  assert.deepEqual(await response.json(), {
    error: {
      code: "METHOD_NOT_ALLOWED",
      message: "This HTTP method is not supported."
    }
  });
});

test("health endpoint supports HEAD without a response body", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);

  const response = await fetch(`${baseUrl}/api/health`, {
    method: "HEAD"
  });

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") || "",
    /application\/json/
  );
  assert.equal(await response.text(), "");
});

test("database health endpoint confirms SQLite connectivity", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);

  const response = await fetch(`${baseUrl}/api/health/database`);

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    database: "connected",
    schemaVersion: 6
  });
});

test("database health endpoint supports HEAD without a response body", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);

  const response = await fetch(`${baseUrl}/api/health/database`, {
    method: "HEAD"
  });

  assert.equal(response.status, 200);
  assert.match(
    response.headers.get("content-type") || "",
    /application\/json/
  );
  assert.equal(await response.text(), "");
});

test("products API creates, lists, retrieves, and rejects duplicate SKUs", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);

  const created = await fetch(`${baseUrl}/api/products`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sku: "TEST-001",
      name: "Test Product",
      description: "Integration test product",
      unit: "piece",
      cost_price_paisa: 1250,
      sale_price_paisa: 1800,
      is_active: true
    })
  });

  assert.equal(created.status, 201);
  const createdBody = await created.json();
  assert.equal(createdBody.data.name, "Test Product");
  assert.equal(createdBody.data.sku, "TEST-001");
  assert.equal(createdBody.data.cost_price_paisa, 1250);
  assert.equal(createdBody.data.sale_price_paisa, 1800);
  assert.equal(createdBody.data.is_active, 1);

  const id = createdBody.data.id;
  assert.ok(Number.isSafeInteger(id));

  const duplicate = await fetch(`${baseUrl}/api/products`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sku: "test-001",
      name: "Duplicate Product"
    })
  });

  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), {
    error: {
      code: "DUPLICATE_SKU",
      message: "A product with this SKU already exists."
    }
  });

  const list = await fetch(`${baseUrl}/api/products?limit=10&offset=0`);
  assert.equal(list.status, 200);
  const listBody = await list.json();

  assert.equal(listBody.pagination.limit, 10);
  assert.equal(listBody.pagination.offset, 0);
  assert.equal(listBody.pagination.total, 1);
  assert.equal(listBody.data.length, 1);
  assert.equal(listBody.data[0].id, id);

  const detail = await fetch(`${baseUrl}/api/products/${id}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).data.name, "Test Product");

  const missing = await fetch(`${baseUrl}/api/products/999999`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json()).error.code, "PRODUCT_NOT_FOUND");

  const head = await fetch(`${baseUrl}/api/products`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
});

test("product API returns correct pages for non-zero offsets", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);
  const ids = [];

  for (let index = 1; index <= 3; index += 1) {
    const response = await fetch(`${baseUrl}/api/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sku: `PAGE-${index}`,
        name: `Pagination Product ${index}`
      })
    });

    assert.equal(response.status, 201);
    ids.push((await response.json()).data.id);
  }

  const firstPageResponse = await fetch(
    `${baseUrl}/api/products?limit=1&offset=0`
  );
  assert.equal(firstPageResponse.status, 200);
  const firstPage = await firstPageResponse.json();

  assert.equal(firstPage.pagination.total, 3);
  assert.equal(firstPage.pagination.offset, 0);
  assert.deepEqual(firstPage.data.map((product) => product.id), [ids[2]]);

  const secondPageResponse = await fetch(
    `${baseUrl}/api/products?limit=2&offset=1`
  );
  assert.equal(secondPageResponse.status, 200);
  const secondPage = await secondPageResponse.json();

  assert.equal(secondPage.pagination.limit, 2);
  assert.equal(secondPage.pagination.offset, 1);
  assert.equal(secondPage.pagination.total, 3);
  assert.deepEqual(
    secondPage.data.map((product) => product.id),
    [ids[1], ids[0]]
  );
  assert.ok(
    !firstPage.data.some((first) =>
      secondPage.data.some((second) => second.id === first.id)
    ),
    "the second page must not repeat products from the first page"
  );
});

test("products API rejects invalid input and pagination parameters", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);

  const invalidProduct = await fetch(`${baseUrl}/api/products`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name: "Invalid Price",
      sale_price_paisa: -10
    })
  });

  assert.equal(invalidProduct.status, 400);
  assert.equal(
    (await invalidProduct.json()).error.code,
    "VALIDATION_ERROR"
  );

  const invalidJson = await fetch(`${baseUrl}/api/products`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{invalid json"
  });

  assert.equal(invalidJson.status, 400);
  assert.equal(
    (await invalidJson.json()).error.code,
    "INVALID_REQUEST_BODY"
  );

  const wrongContentType = await fetch(`${baseUrl}/api/products`, {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "not JSON"
  });

  assert.equal(wrongContentType.status, 415);

  const invalidLimit = await fetch(`${baseUrl}/api/products?limit=101`);
  assert.equal(invalidLimit.status, 400);
  assert.equal((await invalidLimit.json()).error.code, "INVALID_LIMIT");

  const invalidId = await fetch(`${baseUrl}/api/products/0`);
  assert.equal(invalidId.status, 400);
  assert.equal((await invalidId.json()).error.code, "INVALID_PRODUCT_ID");

  const list = await fetch(`${baseUrl}/api/products`);
  assert.equal((await list.json()).pagination.total, 0);
});


test("products API rejects invalid product field boundaries without inserting records", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);

  const invalidProducts = [
    { name: "x".repeat(201) },
    { name: "Invalid SKU", sku: "S".repeat(101) },
    { name: "Invalid description", description: "x".repeat(2001) },
    { name: "Invalid unit", unit: "   " },
    { name: "Unsafe cost", cost_price_paisa: Number.MAX_SAFE_INTEGER + 1 },
    { name: "Fractional sale price", sale_price_paisa: 1.5 },
    { name: "Invalid active flag", is_active: "false" }
  ];

  for (const product of invalidProducts) {
    const response = await fetch(`${baseUrl}/api/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(product)
    });

    assert.equal(
      response.status,
      400,
      `Expected invalid product to be rejected: ${product.name}`
    );
    assert.equal(
      (await response.json()).error.code,
      "VALIDATION_ERROR"
    );
  }

  const list = await fetch(`${baseUrl}/api/products?limit=10&offset=0`);
  assert.equal(list.status, 200);
  assert.equal((await list.json()).pagination.total, 0);
});

test("products API enforces the request body size limit", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);

  const oversized = await fetch(`${baseUrl}/api/products`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "x".repeat(17 * 1024) })
  });

  assert.equal(oversized.status, 413);
  assert.equal(
    (await oversized.json()).error.code,
    "INVALID_REQUEST_BODY"
  );

  const valid = await fetch(`${baseUrl}/api/products`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: "After Oversized Request" })
  });

  assert.equal(valid.status, 201);
  assert.equal((await valid.json()).data.name, "After Oversized Request");
});

test("products API rejects oversized chunked request bodies", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);

  const response = await new Promise((resolve, reject) => {
    const req = httpRequest(`${baseUrl}/api/products`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Transfer-Encoding": "chunked"
      }
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });

    req.on("error", reject);
    req.setTimeout(5000, () => {
      req.destroy(new Error("Timed out waiting for oversized-body response."));
    });

    req.write('{"name":"');
    req.write("x".repeat(17 * 1024));
    req.end('"}');
  });

  assert.equal(response.status, 413);
  assert.equal(
    JSON.parse(response.body).error.code,
    "INVALID_REQUEST_BODY"
  );

  const health = await fetch(`${baseUrl}/api/health`);
  assert.equal(health.status, 200);
});


test("stock movement API records and protects stock", async (t) => {
  const port = await getAvailablePort();
  let batchId;

  const { baseUrl } = await startServer(port, t, (db) => {
    const product = db.prepare(`
      INSERT INTO products (sku, name)
      VALUES (?, ?)
    `).run("TEST-STOCK-001", "Integration Test Product");

    const batch = db.prepare(`
      INSERT INTO product_batches (
        product_id, batch_number, expiry_date, quantity_on_hand
      ) VALUES (?, ?, ?, ?)
    `).run(
      Number(product.lastInsertRowid),
      "TEST-BATCH-001",
      "2030-12-31",
      0
    );

    batchId = Number(batch.lastInsertRowid);
  });

  async function createMovement(payload) {
    return fetch(`${baseUrl}/api/stock-movements`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
  }

  const purchase = await createMovement({
    batch_id: batchId,
    movement_type: "purchase",
    quantity: 100,
    reference: "TEST-PURCHASE"
  });

  assert.equal(purchase.status, 201);
  const purchaseBody = await purchase.json();
  assert.equal(purchaseBody.data.current_quantity_on_hand, 100);
  assert.equal(purchaseBody.data.movement_type, "purchase");

  const sale = await createMovement({
    batch_id: batchId,
    movement_type: "sale",
    quantity: 30,
    reference: "TEST-SALE"
  });

  assert.equal(sale.status, 201);
  const saleBody = await sale.json();
  assert.equal(saleBody.data.current_quantity_on_hand, 70);

  const excessiveSale = await createMovement({
    batch_id: batchId,
    movement_type: "sale",
    quantity: 71
  });

  assert.equal(excessiveSale.status, 409);
  assert.equal(
    (await excessiveSale.json()).error.code,
    "INSUFFICIENT_STOCK"
  );

  const historyAfterRejectedSale = await fetch(
    `${baseUrl}/api/stock-movements?batch_id=${batchId}&limit=100&offset=0`
  );
  assert.equal(historyAfterRejectedSale.status, 200);
  const rejectedSaleHistoryBody = await historyAfterRejectedSale.json();
  assert.equal(rejectedSaleHistoryBody.pagination.total, 2);
  assert.equal(
    rejectedSaleHistoryBody.data[0].current_quantity_on_hand,
    70
  );

  const invalidMovement = await createMovement({
    batch_id: batchId,
    movement_type: "unknown_type",
    quantity: 1
  });

  assert.equal(invalidMovement.status, 400);
  assert.equal(
    (await invalidMovement.json()).error.code,
    "VALIDATION_ERROR"
  );

  const missingBatch = await createMovement({
    batch_id: 999999999,
    movement_type: "purchase",
    quantity: 1
  });

  assert.equal(missingBatch.status, 404);
  assert.equal(
    (await missingBatch.json()).error.code,
    "BATCH_NOT_FOUND"
  );

  const history = await fetch(
    `${baseUrl}/api/stock-movements?batch_id=${batchId}&limit=1&offset=0`
  );

  assert.equal(history.status, 200);
  const historyBody = await history.json();

  assert.equal(historyBody.pagination.total, 2);
  assert.equal(historyBody.pagination.limit, 1);
  assert.equal(historyBody.pagination.offset, 0);
  assert.equal(historyBody.data.length, 1);
  assert.equal(historyBody.data[0].movement_type, "sale");
  assert.equal(historyBody.data[0].current_quantity_on_hand, 70);

  const secondPage = await fetch(
    `${baseUrl}/api/stock-movements?batch_id=${batchId}&limit=1&offset=1`
  );
  assert.equal(secondPage.status, 200);
  const secondPageBody = await secondPage.json();

  assert.equal(secondPageBody.pagination.limit, 1);
  assert.equal(secondPageBody.pagination.offset, 1);
  assert.equal(secondPageBody.pagination.total, 2);
  assert.equal(secondPageBody.data.length, 1);
  assert.equal(secondPageBody.data[0].movement_type, "purchase");
  assert.equal(secondPageBody.data[0].current_quantity_on_hand, 70);

  const allHistory = await fetch(
    `${baseUrl}/api/stock-movements?batch_id=${batchId}`
  );
  const allHistoryBody = await allHistory.json();

  assert.equal(allHistoryBody.pagination.total, 2);
  assert.deepEqual(
    allHistoryBody.data.map((movement) => movement.movement_type),
    ["sale", "purchase"]
  );

  const reachSafeLimit = await createMovement({
    batch_id: batchId,
    movement_type: "purchase",
    quantity: Number.MAX_SAFE_INTEGER - 70
  });

  assert.equal(reachSafeLimit.status, 201);
  assert.equal(
    (await reachSafeLimit.json()).data.current_quantity_on_hand,
    Number.MAX_SAFE_INTEGER
  );

  const overflow = await createMovement({
    batch_id: batchId,
    movement_type: "purchase",
    quantity: 1
  });

  assert.equal(overflow.status, 409);
  assert.equal((await overflow.json()).error.code, "STOCK_BALANCE_LIMIT");

  const finalHistory = await fetch(
    `${baseUrl}/api/stock-movements?batch_id=${batchId}`
  );
  const finalBody = await finalHistory.json();

  assert.equal(finalBody.pagination.total, 3);
  assert.equal(
    finalBody.data[0].current_quantity_on_hand,
    Number.MAX_SAFE_INTEGER
  );
});

test("product and stock movement APIs use default pagination values", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);

  for (const path of ["/api/products", "/api/stock-movements"]) {
    const response = await fetch(`${baseUrl}${path}`);

    assert.equal(response.status, 200, path);

    const body = await response.json();
    assert.equal(body.pagination.limit, 50, path);
    assert.equal(body.pagination.offset, 0, path);
    assert.equal(body.pagination.total, 0, path);
    assert.deepEqual(body.data, [], path);
  }
});

test("product and stock movement APIs accept the maximum pagination limit", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);

  for (const path of ["/api/products", "/api/stock-movements"]) {
    const response = await fetch(
      `${baseUrl}${path}?limit=100&offset=0`
    );

    assert.equal(response.status, 200, path);

    const body = await response.json();
    assert.equal(body.pagination.limit, 100, path);
    assert.equal(body.pagination.offset, 0, path);
    assert.equal(body.pagination.total, 0, path);
    assert.deepEqual(body.data, [], path);
  }
});

test("product and stock movement APIs reject unsafe pagination offsets", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);
  const unsafeOffset = Number.MAX_SAFE_INTEGER + 1;

  for (const path of ["/api/products", "/api/stock-movements"]) {
    const response = await fetch(
      `${baseUrl}${path}?offset=${unsafeOffset}`
    );

    assert.equal(response.status, 400, path);
    assert.equal(
      (await response.json()).error.code,
      "INVALID_OFFSET",
      path
    );
  }
});

test("product and stock movement APIs reject invalid pagination limits", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);
  const invalidLimits = [
    "abc",
    "1.5",
    "101",
    "9007199254740992"
  ];

  for (const path of ["/api/products", "/api/stock-movements"]) {
    for (const limit of invalidLimits) {
      const response = await fetch(
        `${baseUrl}${path}?limit=${limit}`
      );

      assert.equal(response.status, 400, `${path}?limit=${limit}`);
      assert.equal(
        (await response.json()).error.code,
        "INVALID_LIMIT",
        `${path}?limit=${limit}`
      );
    }
  }
});

test("stock movement API validates query parameters and HTTP methods", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);

  const invalidCases = [
    ["limit=0", "INVALID_LIMIT"],
    ["offset=-1", "INVALID_OFFSET"],
    ["batch_id=abc", "INVALID_BATCH_ID"]
  ];

  for (const [query, expectedCode] of invalidCases) {
    const response = await fetch(
      `${baseUrl}/api/stock-movements?${query}`
    );

    assert.equal(response.status, 400, query);
    assert.equal(
      (await response.json()).error.code,
      expectedCode,
      query
    );
  }

  const head = await fetch(`${baseUrl}/api/stock-movements`, {
    method: "HEAD"
  });

  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");

  const unsupported = await fetch(
    `${baseUrl}/api/stock-movements`,
    { method: "PUT" }
  );

  assert.equal(unsupported.status, 405);
  assert.match(
    unsupported.headers.get("allow") || "",
    /GET.*HEAD.*POST/
  );
  assert.equal(
    (await unsupported.json()).error.code,
    "METHOD_NOT_ALLOWED"
  );
});

test("products API enforces search query length boundaries", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);

  const accepted = await fetch(
    `${baseUrl}/api/products?q=${"x".repeat(200)}`
  );
  assert.equal(accepted.status, 200);
  assert.equal((await accepted.json()).pagination.total, 0);

  const rejected = await fetch(
    `${baseUrl}/api/products?q=${"x".repeat(201)}`
  );
  assert.equal(rejected.status, 400);
  assert.equal(
    (await rejected.json()).error.code,
    "INVALID_QUERY"
  );

  const list = await fetch(`${baseUrl}/api/products`);
  assert.equal(list.status, 200);
  assert.equal((await list.json()).pagination.total, 0);
});

test("products API treats percent signs in search queries literally", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);

  for (const name of ["Juice 100% Pure", "Juice 100X Pure"]) {
    const response = await fetch(`${baseUrl}/api/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    assert.equal(response.status, 201);
  }

  const response = await fetch(
    `${baseUrl}/api/products?q=${encodeURIComponent("100%")}`
  );
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.deepEqual(body.data.map((product) => product.name), [
    "Juice 100% Pure"
  ]);
  assert.equal(body.pagination.total, 1);
});

test("products API treats underscores in search queries literally", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);

  for (const name of ["Model A_B Cable", "Model AxB Cable"]) {
    const response = await fetch(`${baseUrl}/api/products`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    assert.equal(response.status, 201);
  }

  const response = await fetch(
    `${baseUrl}/api/products?q=${encodeURIComponent("A_B")}`
  );
  assert.equal(response.status, 200);

  const body = await response.json();
  assert.deepEqual(body.data.map((product) => product.name), [
    "Model A_B Cable"
  ]);
  assert.equal(body.pagination.total, 1);
});

test("malformed URL encoding returns 400 and server remains healthy", async (t) => {
  const port = await getAvailablePort();
  const { baseUrl } = await startServer(port, t);

  const malformed = await fetch(`${baseUrl}/api/products/%ZZ`);

  assert.equal(malformed.status, 400);
  assert.equal(await malformed.text(), "Bad Request");

  const health = await fetch(`${baseUrl}/api/health`);

  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), {
    status: "ok",
    service: "ModernPOS"
  });
});
