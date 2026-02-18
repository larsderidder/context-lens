import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyRequest,
  extractSource,
  resolveTargetUrl,
  type Upstreams,
} from "@contextio/core";

const DEFAULT_UPSTREAMS: Upstreams = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com",
  chatgpt: "https://chatgpt.com",
  gemini: "https://generativelanguage.googleapis.com",
  geminiCodeAssist: "https://cloudcode-pa.googleapis.com",
  vertex: "https://us-central1-aiplatform.googleapis.com",
};

describe("proxy/routing", () => {
  describe("classifyRequest", () => {
    it("detects anthropic from /v1/messages", () => {
      const r = classifyRequest("/v1/messages", {});
      assert.equal(r.provider, "anthropic");
      assert.equal(r.apiFormat, "anthropic-messages");
    });

    it("detects anthropic from anthropic-version header", () => {
      const r = classifyRequest("/some/path", {
        "anthropic-version": "2024-01",
      });
      assert.equal(r.provider, "anthropic");
    });

    it("detects openai from /v1/chat/completions", () => {
      const r = classifyRequest("/v1/chat/completions", {});
      assert.equal(r.provider, "openai");
      assert.equal(r.apiFormat, "chat-completions");
    });

    it("detects openai from /v1/responses", () => {
      const r = classifyRequest("/v1/responses", {});
      assert.equal(r.provider, "openai");
      assert.equal(r.apiFormat, "responses");
    });

    it("detects chatgpt from /backend-api/", () => {
      const r = classifyRequest("/backend-api/conversation", {});
      assert.equal(r.provider, "chatgpt");
      assert.equal(r.apiFormat, "chatgpt-backend");
    });

    it("detects gemini from :generateContent", () => {
      const r = classifyRequest(
        "/v1beta/models/gemini-pro:generateContent",
        {},
      );
      assert.equal(r.provider, "gemini");
      assert.equal(r.apiFormat, "gemini");
    });

    it("detects gemini from x-goog-api-key header", () => {
      const r = classifyRequest("/some/path", { "x-goog-api-key": "key" });
      assert.equal(r.provider, "gemini");
    });

    it("detects vertex from Vertex AI path", () => {
      const r = classifyRequest(
        "/v1beta1/projects/my-project/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent",
        {},
      );
      assert.equal(r.provider, "vertex");
      assert.equal(r.apiFormat, "gemini");
    });

    it("returns unknown for unrecognized paths", () => {
      const r = classifyRequest("/random/endpoint", {});
      assert.equal(r.provider, "unknown");
      assert.equal(r.apiFormat, "unknown");
    });
  });

  describe("extractSource", () => {
    it("extracts source prefix from path", () => {
      const r = extractSource("/claude/v1/messages");
      assert.equal(r.source, "claude");
      assert.equal(r.sessionId, null);
      assert.equal(r.cleanPath, "/v1/messages");
    });

    it("extracts source and sessionId prefix from path", () => {
      const r = extractSource("/claude/ab12cd34/v1/messages");
      assert.equal(r.source, "claude");
      assert.equal(r.sessionId, "ab12cd34");
      assert.equal(r.cleanPath, "/v1/messages");
    });

    it("does not treat API path segments as source", () => {
      const r = extractSource("/v1/messages");
      assert.equal(r.source, null);
      assert.equal(r.sessionId, null);
      assert.equal(r.cleanPath, "/v1/messages");
    });

    it("returns null for single-segment paths", () => {
      const r = extractSource("/v1");
      assert.equal(r.source, null);
    });

    it("rejects path traversal in source", () => {
      const r = extractSource("/%2e%2e/v1/messages");
      assert.equal(r.source, null);
    });
  });

  describe("resolveTargetUrl", () => {
    it("routes anthropic paths to anthropic upstream", () => {
      const r = resolveTargetUrl("/v1/messages", null, {}, DEFAULT_UPSTREAMS);
      assert.equal(r.targetUrl, "https://api.anthropic.com/v1/messages");
      assert.equal(r.provider, "anthropic");
    });

    it("routes openai paths to openai upstream", () => {
      const r = resolveTargetUrl(
        "/v1/chat/completions",
        null,
        {},
        DEFAULT_UPSTREAMS,
      );
      assert.equal(
        r.targetUrl,
        "https://api.openai.com/v1/v1/chat/completions",
      );
      assert.equal(r.provider, "openai");
    });

    it("preserves query string", () => {
      const r = resolveTargetUrl(
        "/v1/messages",
        "?key=val",
        {},
        DEFAULT_UPSTREAMS,
      );
      assert.ok(r.targetUrl.includes("?key=val"));
    });

    it("uses x-target-url when provided", () => {
      const r = resolveTargetUrl(
        "/v1/messages",
        null,
        { "x-target-url": "http://custom.example.com/v1/messages" },
        DEFAULT_UPSTREAMS,
      );
      assert.equal(r.targetUrl, "http://custom.example.com/v1/messages");
    });

    it("routes gemini code assist paths", () => {
      const r = resolveTargetUrl(
        "/v1internal:something",
        null,
        {},
        DEFAULT_UPSTREAMS,
      );
      assert.ok(r.targetUrl.startsWith("https://cloudcode-pa.googleapis.com"));
      assert.equal(r.provider, "gemini");
    });

    it("routes Vertex AI paths to location-based upstream", () => {
      const r = resolveTargetUrl(
        "/v1beta1/projects/my-project/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent",
        null,
        {},
        DEFAULT_UPSTREAMS,
      );
      assert.equal(
        r.targetUrl,
        "https://us-central1-aiplatform.googleapis.com/v1beta1/projects/my-project/locations/us-central1/publishers/google/models/gemini-2.5-pro:generateContent",
      );
      assert.equal(r.provider, "vertex");
    });
  });
});
