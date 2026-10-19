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
