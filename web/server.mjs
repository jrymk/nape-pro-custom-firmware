// Local, loopback-only static preview. No device bridge or uploads.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { releaseDownload } from "./release-download.js";
const root = path.resolve(fileURLToPath(new URL("./public/", import.meta.url)));
const port = Number(process.env.NAPE_WEB_PORT || 8787);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};
const headers = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "hid=(self)",
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
};
const server = http.createServer(async (req, res) => {
  try {
    if (new URL(req.url, "http://localhost").pathname.startsWith("/api/")) {
      const response = await releaseDownload(new Request(new URL(req.url, "http://localhost"), { method: req.method }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const name = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
    const target = path.resolve(
      root,
      "." + (name === "/" ? "/index.html" : name),
    );
    if (!target.startsWith(root + path.sep)) {
      res.writeHead(403).end();
      return;
    }
    const content = await readFile(target);
    res.writeHead(200, {
      ...headers,
      "Content-Type": types[path.extname(target)] || "application/octet-stream",
    });
    res.end(req.method === "HEAD" ? undefined : content);
  } catch {
    res.writeHead(404, headers).end("Not found");
  }
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Nape Studio: http://127.0.0.1:${port}`),
);
