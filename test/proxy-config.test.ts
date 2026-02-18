import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { loadProxyConfig } from "../src/proxy/config.js";

type EnvSnapshot = Record<string, string | undefined>;

function withEnv(
  vars: Record<string, string | undefined>,
  fn: () => void,
): void {
  const before: EnvSnapshot = {};
  for (const key of Object.keys(vars)) {
    before[key] = process.env[key];
    const next = vars[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(vars)) {
      const prev = before[key];
      if (prev === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = prev;
      }
    }
  }
}

afterEach(() => {
  for (const key of [
    "CONTEXT_LENS_BIND_HOST",
    "CONTEXT_PROXY_BIND_HOST",
    "CONTEXT_LENS_PROXY_PORT",
    "CONTEXT_PROXY_PORT",
    "CONTEXT_LENS_ALLOW_TARGET_OVERRIDE",
    "CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE",
  ]) {
    delete process.env[key];
  }
});

describe("proxy/config", () => {
  it("uses contextio env var aliases when context-lens vars are not set", () => {
    withEnv(
      {
        CONTEXT_LENS_BIND_HOST: undefined,
        CONTEXT_PROXY_BIND_HOST: "0.0.0.0",
        CONTEXT_LENS_PROXY_PORT: undefined,
        CONTEXT_PROXY_PORT: "5050",
        CONTEXT_LENS_ALLOW_TARGET_OVERRIDE: undefined,
        CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE: "1",
      },
      () => {
        const config = loadProxyConfig();
        assert.equal(config.bindHost, "0.0.0.0");
        assert.equal(config.port, 5050);
        assert.equal(config.allowTargetOverride, true);
      },
    );
  });

  it("prefers context-lens env vars over contextio aliases", () => {
    withEnv(
      {
        CONTEXT_LENS_BIND_HOST: "127.0.0.2",
        CONTEXT_PROXY_BIND_HOST: "0.0.0.0",
        CONTEXT_LENS_PROXY_PORT: "6060",
        CONTEXT_PROXY_PORT: "5050",
        CONTEXT_LENS_ALLOW_TARGET_OVERRIDE: "1",
        CONTEXT_PROXY_ALLOW_TARGET_OVERRIDE: undefined,
      },
      () => {
        const config = loadProxyConfig();
        assert.equal(config.bindHost, "127.0.0.2");
        assert.equal(config.port, 6060);
        assert.equal(config.allowTargetOverride, true);
      },
    );
  });
});
