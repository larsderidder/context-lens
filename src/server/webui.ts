import fs from "node:fs";
import path from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

import { createApiApp } from "./api.js";
import type { Store } from "./store.js";

export function loadHtmlUI(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Context Lens</title>
  </head>
  <body style="margin:0;padding:16px;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#0b0f16;color:#e6edf3;">
    <main style="max-width:720px;margin:0 auto;">
      <h1 style="font-size:20px;margin:0 0 8px;">Context Lens UI bundle not found</h1>
      <p style="margin:0 0 12px;color:#9fb0c4;">Build the UI and restart the server.</p>
      <pre style="margin:0;padding:10px;border:1px solid #2d3748;background:#111827;color:#d1d5db;border-radius:6px;">cd ui && pnpm install && pnpm run build</pre>
    </main>
  </body>
</html>`;
}

/**
 * Create the combined Hono app: API routes + static file serving.
 */
export function createApp(
  store: Store,
  htmlUI: string,
  baseDir?: string,
): Hono {
  const app = new Hono();

  // Mount API routes
  const apiApp = createApiApp(store);
  app.route("/", apiApp);

  // Check for ui/dist/ directory (new Vue UI)
  let uiDir: string | null = null;
  if (baseDir) {
    const candidate = path.join(baseDir, "..", "ui", "dist");
    if (fs.existsSync(candidate)) {
      uiDir = candidate;
    }
  }

  if (uiDir) {
    // Serve static files from ui/dist/
    app.use("/*", serveStatic({ root: uiDir, rewriteRequestPath: (p) => p }));
    // SPA fallback: serve index.html for unmatched routes
    app.get("*", (c) => {
      const indexPath = path.join(uiDir!, "index.html");
      try {
        const content = fs.readFileSync(indexPath, "utf8");
        return c.html(content);
      } catch {
        return c.text("Not Found", 404);
      }
    });
  } else {
    // Fallback: serve legacy HTML UI
    app.get("/", (c) => c.html(htmlUI));
    app.get("/index.html", (c) => c.html(htmlUI));
  }

  return app;
}
