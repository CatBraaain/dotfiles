import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { catalogFile, catalogRoot } from "./catalog-files.mjs";

export async function serveCatalog(rootDir, { port = 4173 } = {}) {
  requirePort(port);
  const root = catalogRoot(rootDir);
  const server = createServer((request, response) => {
    respond(root, server.address().port, request, response).catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end("Unable to serve catalog file.\n");
    });
  });
  await new Promise((resolveListening, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolveListening();
    });
  });
  return { server, root, url: `http://127.0.0.1:${server.address().port}/` };
}

export async function main(argv) {
  const [rootDir, portFlag, portText, ...extra] = argv.slice(2);
  const validArguments =
    rootDir &&
    (portFlag === undefined ||
      (portFlag === "--port" && /^\d+$/.test(portText ?? "") && extra.length === 0));
  if (!validArguments) {
    console.error("Usage: node serve-catalog.mjs <catalog-root> [--port <0-65535>]");
    return 1;
  }
  try {
    const { server, url } = await serveCatalog(rootDir, {
      port: portText === undefined ? 4173 : Number(portText),
    });
    console.log(url);
    const stop = () => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      server.close();
      server.closeAllConnections();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

async function respond(root, port, request, response) {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  const validHost =
    request.headers.host === `127.0.0.1:${port}` || request.headers.host === `localhost:${port}`;
  if (!validHost) return sendError(response, 403, "Loopback Host required.");
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    return sendError(response, 405, "Only GET and HEAD are supported.");
  }
  let decodedPath;
  try {
    const rawPath = request.url.split("?")[0];
    if (!rawPath.startsWith("/") || rawPath.startsWith("//")) {
      return sendError(response, 400, "Expected a local request path.");
    }
    decodedPath = decodeURIComponent(rawPath);
    if (decodedPath.startsWith("//") || decodedPath.includes("\\") || /\p{Cc}/u.test(decodedPath)) {
      return sendError(response, 400, "Invalid request path.");
    }
  } catch {
    return sendError(response, 400, "Invalid request path encoding.");
  }
  const relativePath = decodedPath.endsWith("/")
    ? `${decodedPath.slice(1)}index.html`
    : decodedPath.slice(1);
  let handle;
  let content;
  try {
    const file = catalogFile(root, relativePath);
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) return sendError(response, 404, "Catalog file not found.");
    if (request.method !== "HEAD") content = await handle.readFile();
    response.setHeader(
      "Content-Length",
      request.method === "HEAD" ? fileStat.size : content.length,
    );
  } catch (error) {
    const isMissing = error.code === "ENOENT" || error.code === "ENOTDIR";
    return sendError(
      response,
      isMissing ? 404 : 403,
      isMissing ? "Catalog file not found." : "Catalog file unavailable.",
    );
  } finally {
    if (handle) await handle.close();
  }
  response.setHeader(
    "Content-Type",
    MIME_TYPES[extname(relativePath).toLowerCase()] ?? "application/octet-stream",
  );
  response.writeHead(200);
  response.end(content);
}

function sendError(response, status, message) {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  response.end(`${message}\n`);
}

function requirePort(port) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("Port must be an integer from 0 to 65535.");
  }
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv);
}
