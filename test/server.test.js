import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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
    schemaVersion: 1
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
