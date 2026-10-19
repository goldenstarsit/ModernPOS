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

export function handleApiRequest(req, res, pathname, db) {
  if (pathname !== "/api" && !pathname.startsWith("/api/")) {
    return false;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    sendJson(
      res,
      405,
      {
        error: {
          code: "METHOD_NOT_ALLOWED",
          message: "This HTTP method is not supported."
        }
      },
      req.method,
      { Allow: "GET, HEAD" }
    );

    return true;
  }

  if (pathname === "/api/health") {
    sendJson(
      res,
      200,
      { status: "ok", service: "ModernPOS" },
      req.method
    );

    return true;
  }

  if (pathname === "/api/health/database") {
    try {
      db.prepare("SELECT 1 AS ok").get();

      const migration = db.prepare(`
        SELECT MAX(version) AS version
        FROM schema_migrations
      `).get();

      sendJson(
        res,
        200,
        {
          status: "ok",
          database: "connected",
          schemaVersion: migration.version
        },
        req.method
      );
    } catch {
      sendJson(
        res,
        503,
        {
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "The database is currently unavailable."
          }
        },
        req.method
      );
    }

    return true;
  }

  sendJson(
    res,
    404,
    {
      error: {
        code: "NOT_FOUND",
        message: "API route not found."
      }
    },
    req.method
  );

  return true;
}
