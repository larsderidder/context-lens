import fs from "node:fs";
import type http from "node:http";
import path from "node:path";

import { createApiHandler } from "./api.js";
import { createStaticHandler } from "./static.js";
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

export function createWebUIHandler(
  store: Store,
  htmlUI: string,
  baseDir?: string,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const handleApi = createApiHandler(store);

  // Check for ui/dist/ directory (new Vue UI)
  // baseDir is the `dist/` output dir; project root is one level up
  let uiDir: string | null = null;
  if (baseDir) {
    const candidate = path.join(baseDir, "..", "ui", "dist");
    if (fs.existsSync(candidate)) {
      uiDir = candidate;
    }
  }
  const handleStatic = createStaticHandler(uiDir, htmlUI);

  return function handleWebUI(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    // Try API routes first
    if (handleApi(req, res)) return;

    // Fall through to static file serving
    handleStatic(req, res);
  };
}
