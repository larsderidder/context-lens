#!/usr/bin/env node

/**
 * Context Lens Proxy — standalone entry point.
 *
 * A minimal HTTP proxy that forwards LLM API requests to their upstream
 * providers and writes raw captures to disk for analysis.
 *
 * ZERO DEPENDENCIES CONSTRAINT
 * ============================
 * This proxy (everything under src/proxy/) must stay zero external
 * dependencies. Only Node.js built-in modules (node:http, node:https,
 * node:fs, node:path, node:os, node:url) are allowed. No npm packages.
 *
 * Why: users route their API keys through this proxy. Keeping the code
 * small and dependency-free means the entire proxy can be audited by
 * reading a single directory. No transitive supply-chain risk.
 *
 * The analysis server, CLI, and web UI are separate processes that
 * communicate via capture files on disk, and those are free to use
 * whatever dependencies they need.
 *
 * Capture files are written to CONTEXT_LENS_CAPTURE_DIR (default:
 * ~/.context-lens/captures/) as atomic JSON files. A separate analysis
 * server watches that directory and provides the web UI.
 */

import http from "node:http";

import { createCaptureWriter } from "./capture.js";
import { loadProxyConfig } from "./config.js";
import { createProxyHandler, type ProxyPlugin } from "./forward.js";

async function loadPluginsFromEnv(): Promise<ProxyPlugin[]> {
  const pluginsEnv =
    process.env.CONTEXT_LENS_PROXY_PLUGINS || process.env.CONTEXT_PROXY_PLUGINS;
  if (!pluginsEnv) return [];

  const specifiers = pluginsEnv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const plugins: ProxyPlugin[] = [];
  for (const specifier of specifiers) {
    try {
      const mod = await import(specifier);
      const pluginOrFactory = mod.default ?? mod;
      if (typeof pluginOrFactory === "function") {
        const plugin = pluginOrFactory();
        if (plugin && typeof plugin === "object" && plugin.name) {
          plugins.push(plugin as ProxyPlugin);
          console.log(`Loaded proxy plugin: ${plugin.name} (${specifier})`);
        } else {
          console.error(`Plugin "${specifier}" factory returned invalid plugin`);
        }
      } else if (
        pluginOrFactory &&
        typeof pluginOrFactory === "object" &&
        pluginOrFactory.name
      ) {
        plugins.push(pluginOrFactory as ProxyPlugin);
        console.log(
          `Loaded proxy plugin: ${pluginOrFactory.name} (${specifier})`,
        );
      } else {
        console.error(`Plugin "${specifier}" export is not a plugin or factory`);
      }
    } catch (err: unknown) {
      console.error(
        `Failed to load plugin "${specifier}":`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return plugins;
}

async function main(): Promise<void> {
  const config = loadProxyConfig();
  const captureWriter = createCaptureWriter(config.captureDir);
  const plugins = await loadPluginsFromEnv();

  const server = http.createServer(
    createProxyHandler({
      upstreams: config.upstreams,
      allowTargetOverride: config.allowTargetOverride,
      plugins,
      onCapture: (capture) => {
        captureWriter.write(capture);
      },
    }),
  );

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.log(`🔍 Context Lens Proxy already running on port ${config.port}`);
      process.exit(0);
    }
    throw err;
  });

  server.listen(config.port, config.bindHost, () => {
    console.log(
      `🔍 Context Lens Proxy running on http://${config.bindHost}:${config.port}`,
    );
    console.log(`📁 Captures → ${config.captureDir}`);
    if (!process.env.CONTEXT_LENS_CLI) {
      console.log(`\nUpstream: OpenAI → ${config.upstreams.openai}`);
      console.log(`         Anthropic → ${config.upstreams.anthropic}`);
      console.log(`         Gemini → ${config.upstreams.gemini}`);
      if (process.env.UPSTREAM_OPENAI_URL) {
        console.log(`\n⚠️  OpenAI upstream overridden via UPSTREAM_OPENAI_URL`);
      }
    }
  });
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
