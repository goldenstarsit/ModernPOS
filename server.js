import { createServer } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { resolve, sep, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { handleApiRequest } from "./api.js";
import { openDatabase } from "./db/database.js";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = resolve(ROOT, "public");
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 3000);
const DATABASE_PATH = process.env.DATABASE_PATH;

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

const db = openDatabase(DATABASE_PATH);

const server = createServer(async (req, res) => {
  let pathname;

  try {
    pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname
    );
  } catch {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  if (await handleApiRequest(req, res, pathname, db)) return;

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405, { Allow: "GET, HEAD" });
    res.end("Method Not Allowed");
    return;
  }

  if (pathname === "/") pathname = "/index.html";

  const filePath = resolve(PUBLIC_DIR, `.${pathname}`);

  if (
    filePath !== PUBLIC_DIR &&
    !filePath.startsWith(PUBLIC_DIR + sep)
  ) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const realPublicDir = await realpath(PUBLIC_DIR);
    const realFilePath = await realpath(filePath);

    if (
      realFilePath !== realPublicDir &&
      !realFilePath.startsWith(realPublicDir + sep)
    ) {
      res.writeHead(403, {
        "Content-Type": "text/plain; charset=utf-8"
      });
      res.end("Forbidden");
      return;
    }

    const info = await stat(realFilePath);

    if (!info.isFile()) throw new Error("Not a file");

    const content = await readFile(realFilePath);

    res.writeHead(200, {
      "Content-Type":
        contentTypes[extname(realFilePath).toLowerCase()] ||
        "application/octet-stream",
      "Content-Length": content.length,
      "X-Content-Type-Options": "nosniff"
    });

    res.end(req.method === "HEAD" ? undefined : content);
  } catch {
    res.writeHead(404, {
      "Content-Type": "text/plain; charset=utf-8"
    });
    res.end("Not Found");
  }
});

let shuttingDown = false;

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;

  server.close(() => {
    db.close();
    process.exit(0);
  });

  server.closeAllConnections();
}

process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);

server.on("error", (error) => {
  console.error("ModernPOS server error:", error.message);
  db.close();
  process.exitCode = 1;
});

server.listen(PORT, HOST, () => {
  console.log(`ModernPOS running at http://${HOST}:${PORT}`);
});
