import fs from "node:fs";
import type http from "node:http";
import path from "node:path";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

/**
 * Create a static file handler that serves from `uiDir` if it exists,
 * otherwise falls back to serving `fallbackHtml` at `/`.
 *
 * Returns a function that handles the request, always responds.
 */
export function createStaticHandler(
  uiDir: string | null,
  fallbackHtml: string,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  // Check if ui/dist exists at startup
  const uiDirExists = uiDir !== null && fs.existsSync(uiDir);

  return function handleStatic(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    if (uiDirExists && uiDir) {
      // Serve from ui/dist
      let reqPath = req.url?.split("?")[0] || "/";

      // Prevent directory traversal
      reqPath = path.normalize(reqPath).replace(/^(\.\.[/\\])+/, "");

      // Map / to /index.html
      if (reqPath === "/") reqPath = "/index.html";

      const filePath = path.join(uiDir, reqPath);

      // Ensure we don't serve files outside uiDir
      if (!filePath.startsWith(uiDir)) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        res.end("Forbidden");
        return;
      }

      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          const ext = path.extname(filePath).toLowerCase();
          const contentType = MIME_TYPES[ext] || "application/octet-stream";
          const content = fs.readFileSync(filePath);
          res.writeHead(200, { "Content-Type": contentType });
          res.end(content);
          return;
        }
      } catch {
        // File not found; fall through to SPA fallback
      }

      // SPA fallback: serve index.html for unmatched routes
      const indexPath = path.join(uiDir, "index.html");
      try {
        const content = fs.readFileSync(indexPath);
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(content);
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not Found");
      }
      return;
    }

    // Fallback: serve legacy HTML UI
    if (req.url === "/" || req.url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(fallbackHtml);
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  };
}
