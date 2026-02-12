#!/usr/bin/env node

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadServerConfig } from "./server/config.js";
import { createProxyHandler } from "./server/proxy.js";
import { Store } from "./server/store.js";
import { createWebUIHandler, loadHtmlUI } from "./server/webui.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const config = loadServerConfig(__dirname);
const store = new Store({
  dataDir: config.dataDir,
  stateFile: config.stateFile,
  maxSessions: config.maxSessions,
  maxCompactMessages: config.maxCompactMessages,
  privacy: config.privacy,
});

// Start servers
store.loadState();

const proxyServer = http.createServer(
  createProxyHandler(store, {
    upstreams: config.upstreams,
    allowTargetOverride: config.allowTargetOverride,
  }),
);

const htmlUI = loadHtmlUI();
const webUIServer = http.createServer(createWebUIHandler(store, htmlUI, __dirname));

proxyServer.listen(4040, config.bindHost, () => {
  console.log(
    `🔍 Context Lens Proxy running on http://${config.bindHost}:4040`,
  );
});

webUIServer.listen(4041, config.bindHost, () => {
  console.log(
    `🌐 Context Lens Web UI running on http://${config.bindHost}:4041`,
  );
  // Only show verbose help when running standalone (not spawned by cli.js)
  if (!process.env.CONTEXT_LENS_CLI) {
    console.log(`\nUpstream: OpenAI → ${config.upstreams.openai}`);
    console.log(`         Anthropic → ${config.upstreams.anthropic}`);
    console.log("\nUsage:");
    console.log(
      "  Codex (subscription): UPSTREAM_OPENAI_URL=https://chatgpt.com/backend-api/codex node server.js",
    );
    console.log("  Codex (API key):      node server.js");
    console.log(
      '  Then: OPENAI_BASE_URL=http://localhost:4040 codex "your prompt"',
    );
    console.log(
      '  Claude: ANTHROPIC_BASE_URL=http://localhost:4040/claude claude "your prompt"',
    );
  }
});
