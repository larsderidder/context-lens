#!/usr/bin/env node

/**
 * Context Lens Proxy — standalone entry point.
 *
 * Wraps @contextio/proxy with context-lens capture handling:
 * either writing capture files to disk or POSTing them to an ingest URL.
 *
 * TRUST BOUNDARY
 * ==============
 * This proxy sees API keys. The only dependencies are @contextio/core and
 * @contextio/proxy, both zero-external-dependency packages you control.
 * The capture layer (capture.ts) and config (config.ts) are local to this
 * directory. Together that is the full auditable surface.
 */

import type { ProxyPlugin } from "@contextio/core";
import { createProxy } from "@contextio/proxy";

import { createCaptureIngestor, createCaptureWriter } from "./capture.js";
import { loadProxyConfig } from "./config.js";

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
          console.error(
            `Plugin "${specifier}" factory returned invalid plugin`,
          );
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
        console.error(
          `Plugin "${specifier}" export is not a plugin or factory`,
        );
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
  const plugins = await loadPluginsFromEnv();

  // Add a capture plugin that either writes to disk or POSTs to ingest URL.
  let onCapture: (capture: import("./capture.js").CaptureData) => void;
  if (config.ingestUrl) {
    const ingestor = createCaptureIngestor(config.ingestUrl);
    onCapture = (capture) => ingestor.post(capture);
    console.log(`📡 Captures → ${config.ingestUrl}`);
  } else {
    const writer = createCaptureWriter(config.captureDir);
    onCapture = (capture) => writer.write(capture);
  }

  const capturePlugin: ProxyPlugin = {
    name: "context-lens-capture",
    onCapture,
  };

  const proxy = createProxy({
    port: config.port,
    bindHost: config.bindHost,
    allowTargetOverride: config.allowTargetOverride,
    upstreams: config.upstreams,
    plugins: [...plugins, capturePlugin],
    logTraffic: true,
  });

  try {
    await proxy.start();
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EADDRINUSE") {
      console.log(
        `🔍 Context Lens Proxy already running on port ${config.port}`,
      );
      process.exit(0);
    }
    throw err;
  }

  if (!config.ingestUrl) {
    console.log(`📁 Captures → ${config.captureDir}`);
  }
  if (!process.env.CONTEXT_LENS_CLI) {
    console.log(`\nUpstream: OpenAI → ${config.upstreams.openai}`);
    console.log(`         Anthropic → ${config.upstreams.anthropic}`);
    console.log(`         Gemini → ${config.upstreams.gemini}`);
    if (process.env.UPSTREAM_OPENAI_URL) {
      console.log(`\n⚠️  OpenAI upstream overridden via UPSTREAM_OPENAI_URL`);
    }
  }

  process.stdin.resume();
  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    proxy.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
