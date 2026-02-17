import assert from "node:assert/strict";
import http from "node:http";
import zlib from "node:zlib";
import { afterEach, beforeEach, describe, it } from "node:test";

import type { CaptureData } from "../src/proxy/capture.js";
import {
  createProxyHandler,
  type ForwardOptions,
} from "../src/proxy/forward.js";
import type { Upstreams } from "../src/proxy/routing.js";

// --- Test infrastructure ---

interface UpstreamRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function createUpstreamServer(): {
  server: http.Server;
  port: number;
  requests: UpstreamRequest[];
  setResponse: (opts: {
    status?: number;
    headers?: Record<string, string>;
    body?: string;
  }) => void;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const requests: UpstreamRequest[] = [];
  let responseOpts = {
    status: 200,
    headers: {} as Record<string, string>,
    body: "{}",
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      res.writeHead(responseOpts.status, {
        "content-type": "application/json",
        ...responseOpts.headers,
      });
      res.end(responseOpts.body);
    });
  });

  let port = 0;
  return {
    server,
    get port() {
      return port;
    },
    requests,
    setResponse: (opts) => {
      responseOpts = {
        status: opts.status ?? 200,
        headers: opts.headers ?? {},
        body: opts.body ?? "{}",
      };
    },
    start: () =>
      new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", () => {
          port = (server.address() as { port: number }).port;
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function proxyRequest(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  opts: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string | Buffer;
  },
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  try {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: "127.0.0.1",
          port,
          path: opts.path,
          method: opts.method,
          headers: opts.headers ?? {},
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks).toString("utf8"),
            });
          });
        },
      );
      req.on("error", reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

// --- Tests ---

describe("proxy/forward", () => {
  let upstream: ReturnType<typeof createUpstreamServer>;
  let upstreams: Upstreams;
  let captures: CaptureData[];
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeEach(async () => {
    upstream = createUpstreamServer();
    await upstream.start();
    captures = [];

    const base = `http://127.0.0.1:${upstream.port}`;
    upstreams = {
      openai: base,
      anthropic: base,
      chatgpt: base,
      gemini: base,
      geminiCodeAssist: base,
      vertex: base,
    };

    handler = createProxyHandler({
      upstreams,
      allowTargetOverride: false,
      onCapture: (capture) => captures.push(capture),
    });
  });

  afterEach(async () => {
    await upstream.stop();
  });

  it("forwards POST and calls onCapture with request/response data", async () => {
    const responseBody = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      usage: { input_tokens: 10, output_tokens: 5 },
    });
    upstream.setResponse({ body: responseBody });

    const requestBody = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      messages: [{ role: "user", content: "hello" }],
    });

    const res = await proxyRequest(handler, {
      method: "POST",
      path: "/v1/messages",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-test",
      },
      body: requestBody,
    });

    // Client gets the upstream response
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).model, "claude-sonnet-4-20250514");

    // Upstream received the right request
    assert.equal(upstream.requests.length, 1);
    assert.equal(upstream.requests[0].body, requestBody);

    // onCapture was called with the right data
    assert.equal(captures.length, 1);
    const c = captures[0];
    assert.equal(c.method, "POST");
    assert.equal(c.path, "/v1/messages");
    assert.equal(c.provider, "anthropic");
    assert.equal(c.apiFormat, "anthropic-messages");
    assert.equal(c.responseStatus, 200);
    assert.ok(c.requestBytes > 0);
    assert.ok(c.responseBytes > 0);
    assert.ok(c.timings.total_ms >= 0);

    // Request body is captured as parsed JSON
    assert.deepEqual(c.requestBody, JSON.parse(requestBody));

    // Response body is captured as raw string
    assert.equal(c.responseBody, responseBody);
  });

  it("captures source from URL path prefix", async () => {
    upstream.setResponse({ body: '{"ok":true}' });

    await proxyRequest(handler, {
      method: "POST",
      path: "/claude/v1/messages",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [] }),
    });

    assert.equal(captures.length, 1);
    assert.equal(captures[0].source, "claude");
    assert.equal(captures[0].path, "/v1/messages");
  });

  it("captures source and sessionId from URL path prefix", async () => {
    upstream.setResponse({ body: '{"ok":true}' });

    await proxyRequest(handler, {
      method: "POST",
      path: "/claude/ab12cd34/v1/messages",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [] }),
    });

    assert.equal(captures.length, 1);
    assert.equal(captures[0].source, "claude");
    assert.equal(captures[0].sessionId, "ab12cd34");
    assert.equal(captures[0].path, "/v1/messages");
  });

  it("captures non-JSON body with null requestBody", async () => {
    upstream.setResponse({ body: "OK" });

    await proxyRequest(handler, {
      method: "POST",
      path: "/v1/messages",
      headers: { "content-type": "text/plain" },
      body: "this is not JSON",
    });

    assert.equal(captures.length, 1);
    assert.equal(captures[0].requestBody, null);
    assert.equal(captures[0].requestBytes, 16);
  });

  it("parses gzipped JSON request bodies for capture", async () => {
    upstream.setResponse({ body: '{"ok":true}' });
    const requestJson = JSON.stringify({ model: "test", messages: [] });
    const gzipped = zlib.gzipSync(Buffer.from(requestJson, "utf8"));

    await proxyRequest(handler, {
      method: "POST",
      path: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "content-encoding": "gzip",
      },
      body: gzipped,
    });

    assert.equal(captures.length, 1);
    assert.deepEqual(captures[0].requestBody, JSON.parse(requestJson));
  });

  it("does not capture GET requests", async () => {
    upstream.setResponse({
      body: JSON.stringify({ data: [{ id: "model-1" }] }),
    });

    const res = await proxyRequest(handler, {
      method: "GET",
      path: "/v1/models",
    });

    assert.equal(res.status, 200);
    assert.equal(captures.length, 0);
  });

  it("strips x-target-url before forwarding", async () => {
    upstream.setResponse({ body: '{"ok":true}' });

    await proxyRequest(handler, {
      method: "POST",
      path: "/v1/messages",
      headers: {
        "content-type": "application/json",
        "x-target-url": "http://should-be-stripped.example.com",
      },
      body: JSON.stringify({ model: "test", messages: [] }),
    });

    assert.equal(upstream.requests[0].headers["x-target-url"], undefined);
  });

  it("redacts sensitive headers in captures", async () => {
    upstream.setResponse({ body: '{"ok":true}' });

    await proxyRequest(handler, {
      method: "POST",
      path: "/v1/messages",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer sk-secret-key",
        "x-api-key": "secret-api-key",
        "x-custom-header": "safe-value",
      },
      body: JSON.stringify({ model: "test", messages: [] }),
    });

    assert.equal(captures.length, 1);
    const h = captures[0].requestHeaders;
    assert.equal(h["authorization"], undefined);
    assert.equal(h["x-api-key"], undefined);
    assert.equal(h["x-custom-header"], "safe-value");
  });

  it("preserves multi-byte UTF-8 in forwarded body", async () => {
    upstream.setResponse({ body: '{"ok":true}' });

    const content = "Hello 🌍 世界 café ñ";
    const requestBody = JSON.stringify({
      model: "test",
      messages: [{ role: "user", content }],
    });

    await proxyRequest(handler, {
      method: "POST",
      path: "/v1/messages",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });

    // Upstream received byte-identical body
    assert.equal(upstream.requests[0].body, requestBody);

    // Content-length matches byte length
    assert.equal(
      Number(upstream.requests[0].headers["content-length"]),
      Buffer.byteLength(requestBody, "utf8"),
    );
  });

  it("captures streaming responses with responseIsStreaming flag", async () => {
    const sseBody = [
      'data: {"type":"message_start"}',
      'data: {"type":"content_block_delta","delta":{"text":"hi"}}',
      "",
    ].join("\n");

    upstream.setResponse({
      headers: { "content-type": "text/event-stream" },
      body: sseBody,
    });

    const res = await proxyRequest(handler, {
      method: "POST",
      path: "/v1/messages",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [], stream: true }),
    });

    assert.equal(res.status, 200);
    assert.ok(res.body.includes("message_start"));

    assert.equal(captures.length, 1);
    assert.equal(captures[0].responseIsStreaming, true);
    assert.ok(captures[0].responseBytes > 0);
  });

  it("captures timings", async () => {
    upstream.setResponse({ body: '{"ok":true}' });

    await proxyRequest(handler, {
      method: "POST",
      path: "/v1/messages",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [] }),
    });

    assert.equal(captures.length, 1);
    const t = captures[0].timings;
    assert.ok(t.total_ms >= 0);
    assert.ok(t.send_ms >= 0);
    assert.ok(t.wait_ms >= 0);
    assert.ok(t.receive_ms >= 0);
  });

  it("detects provider and apiFormat correctly", async () => {
    upstream.setResponse({ body: '{"ok":true}' });

    // Anthropic
    await proxyRequest(handler, {
      method: "POST",
      path: "/v1/messages",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [] }),
    });
    assert.equal(captures[0].provider, "anthropic");
    assert.equal(captures[0].apiFormat, "anthropic-messages");

    // OpenAI chat completions
    await proxyRequest(handler, {
      method: "POST",
      path: "/v1/chat/completions",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [] }),
    });
    assert.equal(captures[1].provider, "openai");
    assert.equal(captures[1].apiFormat, "chat-completions");

    // OpenAI responses
    await proxyRequest(handler, {
      method: "POST",
      path: "/v1/responses",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test", input: "hi" }),
    });
    assert.equal(captures[2].provider, "openai");
    assert.equal(captures[2].apiFormat, "responses");
  });
});
