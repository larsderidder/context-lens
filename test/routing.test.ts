import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  detectApiFormat,
  detectProvider,
  extractSource,
  resolveTargetUrl,
} from "../src/core.js";

describe("detectProvider", () => {
  it("detects anthropic from /v1/messages path", () => {
    assert.equal(detectProvider("/v1/messages", {}), "anthropic");
  });

  it("detects anthropic from /v1/complete path", () => {
    assert.equal(detectProvider("/v1/complete", {}), "anthropic");
  });

  it("detects anthropic from anthropic-version header", () => {
    assert.equal(
      detectProvider("/some/path", { "anthropic-version": "2024-01-01" }),
      "anthropic",
    );
  });

  it("detects openai from /responses path", () => {
    assert.equal(detectProvider("/responses", {}), "openai");
  });

  it("detects openai from /chat/completions path", () => {
    assert.equal(detectProvider("/chat/completions", {}), "openai");
  });

  it("detects openai from Bearer sk- header", () => {
    assert.equal(
      detectProvider("/anything", { authorization: "Bearer sk-abc123" }),
      "openai",
    );
  });

  it("detects chatgpt from /backend-api/ path", () => {
    assert.equal(detectProvider("/backend-api/codex/responses", {}), "chatgpt");
  });

  it("detects chatgpt from /api/ path", () => {
    assert.equal(detectProvider("/api/codex/responses", {}), "chatgpt");
  });

  it("returns unknown for unrecognized paths", () => {
    assert.equal(detectProvider("/unknown/path", {}), "unknown");
  });
});

describe("detectApiFormat", () => {
  it("detects anthropic-messages", () => {
    assert.equal(detectApiFormat("/v1/messages"), "anthropic-messages");
  });

  it("detects chatgpt-backend", () => {
    assert.equal(
      detectApiFormat("/backend-api/codex/responses"),
      "chatgpt-backend",
    );
    assert.equal(detectApiFormat("/api/codex/responses"), "chatgpt-backend");
  });

  it("detects responses API", () => {
    assert.equal(detectApiFormat("/responses"), "responses");
  });

  it("detects chat-completions", () => {
    assert.equal(detectApiFormat("/chat/completions"), "chat-completions");
  });

  it("returns unknown for unrecognized paths", () => {
    assert.equal(detectApiFormat("/v1/models"), "unknown");
  });
});

describe("extractSource", () => {
  it("extracts source prefix from path", () => {
    const result = extractSource("/claude/v1/messages");
    assert.equal(result.source, "claude");
    assert.equal(result.cleanPath, "/v1/messages");
  });

  it("extracts custom source prefix", () => {
    const result = extractSource("/my-tool/responses");
    assert.equal(result.source, "my-tool");
    assert.equal(result.cleanPath, "/responses");
  });

  it("does not treat API path segments as source", () => {
    for (const seg of [
      "v1",
      "responses",
      "chat",
      "models",
      "embeddings",
      "backend-api",
      "api",
    ]) {
      const result = extractSource(`/${seg}/something`);
      assert.equal(result.source, null, `should not treat /${seg} as source`);
      assert.equal(result.cleanPath, `/${seg}/something`);
    }
  });

  it("returns null source for paths with no prefix", () => {
    const result = extractSource("/v1/messages");
    assert.equal(result.source, null);
    assert.equal(result.cleanPath, "/v1/messages");
  });

  it("returns null source for single-segment paths", () => {
    const result = extractSource("/responses");
    assert.equal(result.source, null);
    assert.equal(result.cleanPath, "/responses");
  });

  it("decodes URI-encoded source", () => {
    const result = extractSource("/my%20tool/v1/messages");
    assert.equal(result.source, "my tool");
  });
});

describe("resolveTargetUrl", () => {
  const upstreams = {
    openai: "https://api.openai.com/v1",
    anthropic: "https://api.anthropic.com",
    chatgpt: "https://chatgpt.com",
    gemini: "https://generativelanguage.googleapis.com",
    geminiCodeAssist: "https://cloudcode-pa.googleapis.com",
  };

  it("routes anthropic paths to anthropic upstream", () => {
    const result = resolveTargetUrl(
      { pathname: "/v1/messages" },
      {},
      upstreams,
    );
    assert.equal(result.targetUrl, "https://api.anthropic.com/v1/messages");
    assert.equal(result.provider, "anthropic");
  });

  it("routes openai paths to openai upstream", () => {
    const result = resolveTargetUrl({ pathname: "/responses" }, {}, upstreams);
    assert.equal(result.targetUrl, "https://api.openai.com/v1/responses");
    assert.equal(result.provider, "openai");
  });

  it("routes chatgpt paths to chatgpt upstream", () => {
    const result = resolveTargetUrl(
      { pathname: "/backend-api/codex/responses" },
      {},
      upstreams,
    );
    assert.equal(
      result.targetUrl,
      "https://chatgpt.com/backend-api/codex/responses",
    );
    assert.equal(result.provider, "chatgpt");
  });

  it("uses x-target-url header when provided", () => {
    const headers = { "x-target-url": "https://custom.api.com/v1/messages" };
    const result = resolveTargetUrl(
      { pathname: "/v1/messages" },
      headers,
      upstreams,
    );
    assert.equal(result.targetUrl, "https://custom.api.com/v1/messages");
  });

  it("preserves query string in target URL", () => {
    const result = resolveTargetUrl(
      { pathname: "/v1/messages", search: "?beta=true" },
      {},
      upstreams,
    );
    assert.equal(
      result.targetUrl,
      "https://api.anthropic.com/v1/messages?beta=true",
    );
  });

  it("handles missing query string gracefully", () => {
    const result = resolveTargetUrl(
      { pathname: "/v1/messages", search: null },
      {},
      upstreams,
    );
    assert.equal(result.targetUrl, "https://api.anthropic.com/v1/messages");
  });
});
