import test from "node:test";
import assert from "node:assert/strict";
import { handleApiRequest } from "../api.js";

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
