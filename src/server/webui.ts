import fs from "node:fs";
import type http from "node:http";
import path from "node:path";

import { createApiHandler } from "./api.js";
import { createStaticHandler } from "./static.js";
import type { Store } from "./store.js";

export function loadHtmlUI(baseDir: string): string {
  return fs.readFileSync(
    path.join(baseDir, "..", "public", "index.html"),
    "utf-8",
  );
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
