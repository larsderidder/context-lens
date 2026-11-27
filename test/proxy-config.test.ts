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
  it("has safe defaults when no env vars are set", () => {
    withEnv(
      {
        CONTEXT_LENS_BIND_HOST: undefined,
        CONTEXT_LENS_PROXY_PORT: undefined,
        CONTEXT_LENS_ALLOW_TARGET_OVERRIDE: undefined,
        CONTEXT_LENS_CAPTURE_DIR: undefined,
        CONTEXT_LENS_INGEST_URL: undefined,
        UPSTREAM_OPENAI_URL: undefined,
        UPSTREAM_ANTHROPIC_URL: undefined,
        UPSTREAM_CHATGPT_URL: undefined,
        UPSTREAM_GEMINI_URL: undefined,
        UPSTREAM_GEMINI_CODE_ASSIST_URL: undefined,
        UPSTREAM_VERTEX_URL: undefined,
      },
      () => {
        const config = loadProxyConfig();
        assert.equal(config.bindHost, "127.0.0.1");
        assert.equal(config.port, 4040);
        assert.equal(config.allowTargetOverride, false);
        assert.equal(config.ingestUrl, null);
        assert.ok(config.captureDir.includes(".context-lens"));
        assert.equal(config.upstreams.openai, "https://api.openai.com");
        assert.equal(config.upstreams.anthropic, "https://api.anthropic.com");
        assert.equal(config.upstreams.chatgpt, "https://chatgpt.com");
        assert.ok(config.upstreams.gemini.includes("googleapis.com"));
        assert.ok(
          config.upstreams.vertex.includes("aiplatform.googleapis.com"),
        );
      },
    );
  });

  it("respects CONTEXT_LENS_BIND_HOST, CONTEXT_LENS_PROXY_PORT, and CONTEXT_LENS_ALLOW_TARGET_OVERRIDE", () => {
    withEnv(
      {
        CONTEXT_LENS_BIND_HOST: "127.0.0.2",
        CONTEXT_LENS_PROXY_PORT: "6060",
        CONTEXT_LENS_ALLOW_TARGET_OVERRIDE: "1",
      },
      () => {
        const config = loadProxyConfig();
        assert.equal(config.bindHost, "127.0.0.2");
        assert.equal(config.port, 6060);
        assert.equal(config.allowTargetOverride, true);
      },
    );
  });

  it("does not enable target override unless value is exactly '1'", () => {
    for (const val of ["true", "yes", "0", "false", ""]) {
      withEnv({ CONTEXT_LENS_ALLOW_TARGET_OVERRIDE: val }, () => {
        const config = loadProxyConfig();
        assert.equal(
          config.allowTargetOverride,
          false,
          `expected false for CONTEXT_LENS_ALLOW_TARGET_OVERRIDE="${val}"`,
        );
      });
    }
  });

  it("respects upstream URL overrides via env vars", () => {
    withEnv(
      {
        UPSTREAM_OPENAI_URL: "https://custom-openai.example.com",
        UPSTREAM_ANTHROPIC_URL: "https://custom-anthropic.example.com",
        UPSTREAM_GEMINI_URL: "https://custom-gemini.example.com",
      },
      () => {
        const config = loadProxyConfig();
        assert.equal(
          config.upstreams.openai,
          "https://custom-openai.example.com",
        );
        assert.equal(
          config.upstreams.anthropic,
          "https://custom-anthropic.example.com",
        );
        assert.equal(
          config.upstreams.gemini,
          "https://custom-gemini.example.com",
        );
      },
    );
  });

  it("respects CONTEXT_LENS_INGEST_URL", () => {
    withEnv(
      { CONTEXT_LENS_INGEST_URL: "http://localhost:4041/api/ingest" },
      () => {
        const config = loadProxyConfig();
        assert.equal(config.ingestUrl, "http://localhost:4041/api/ingest");
      },
    );
  });

  it("respects CONTEXT_LENS_CAPTURE_DIR", () => {
    withEnv({ CONTEXT_LENS_CAPTURE_DIR: "/tmp/custom-captures" }, () => {
      const config = loadProxyConfig();
      assert.equal(config.captureDir, "/tmp/custom-captures");
    });
  });
});
