import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

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

async function startServer(port, t) {
  const baseUrl = `http://${HOST}:${port}`;
  const directory = mkdtempSync(join(tmpdir(), "modernpos-http-"));
  const databasePath = join(directory, "test.sqlite");
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
    schemaVersion: 2
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
