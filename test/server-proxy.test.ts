import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createProxyHandler } from "../src/server/proxy.js";
import { Store } from "../src/server/store.js";
import type { Upstreams } from "../src/types.js";

// --- Test infrastructure ---

interface UpstreamRequest {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** Spins up a real HTTP server to act as the upstream API. */
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

/** Send a request through the proxy handler using a real HTTP client/server pair. */
async function proxyRequest(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  opts: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    body?: string;
  },
): Promise<{
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}> {
  // Create a one-shot HTTP server running the proxy handler
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

describe("proxy handler", () => {
  let upstream: ReturnType<typeof createUpstreamServer>;
  let store: Store;
  let cleanup: () => void;
  let upstreams: Upstreams;
  let handler: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeEach(async () => {
    upstream = createUpstreamServer();
    await upstream.start();

    const dir = mkdtempSync(path.join(tmpdir(), "proxy-test-"));
    store = new Store({
      dataDir: path.join(dir, "data"),
      stateFile: path.join(dir, "data", "state.jsonl"),
      maxSessions: 10,
      maxCompactMessages: 60,
    });

    // Point all upstreams at our mock server
    const base = `http://127.0.0.1:${upstream.port}`;
    upstreams = {
      openai: base,
      anthropic: base,
      chatgpt: base,
      gemini: base,
      geminiCodeAssist: base,
    };

    handler = createProxyHandler(store, {
      upstreams,
      allowTargetOverride: false,
    });
    cleanup = () => {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
    };
  });

  afterEach(async () => {
    await upstream.stop();
    cleanup();
  });

  it("forwards a POST with JSON body and captures the request", async () => {
    const responseBody = JSON.stringify({
      model: "claude-sonnet-4-20250514",
      stop_reason: "end_turn",
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

    // Client gets the upstream response back
    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.model, "claude-sonnet-4-20250514");

    // Upstream received the correct request
    assert.equal(upstream.requests.length, 1);
    assert.equal(upstream.requests[0].method, "POST");
    assert.equal(upstream.requests[0].body, requestBody);

    // Store captured the request
    assert.equal(store.getCapturedRequests().length, 1);
    const captured = store.getCapturedRequests()[0];
    assert.equal(captured.source, "unknown");
    assert.equal(captured.httpStatus, 200);
  });

  it("preserves multi-byte UTF-8 in forwarded body", async () => {
    upstream.setResponse({ body: '{"ok":true}' });

    // Mix of ASCII and multi-byte: emoji, CJK, accented chars
    const content = "Hello 🌍 世界 café ñ";
    const requestBody = JSON.stringify({
      model: "test-model",
      messages: [{ role: "user", content }],
    });

    const res = await proxyRequest(handler, {
      method: "POST",
      path: "/v1/messages",
      headers: { "content-type": "application/json" },
      body: requestBody,
    });

    assert.equal(res.status, 200);

    // Upstream received byte-identical body
    assert.equal(upstream.requests[0].body, requestBody);

    // Content-length header matches actual byte length
    const upstreamContentLength =
      upstream.requests[0].headers["content-length"];
    assert.equal(
      Number(upstreamContentLength),
      Buffer.byteLength(requestBody, "utf8"),
    );
  });

  it("captures non-JSON body as raw", async () => {
    upstream.setResponse({ body: "OK" });

    const res = await proxyRequest(handler, {
      method: "POST",
      path: "/v1/messages",
      headers: { "content-type": "text/plain" },
      body: "this is not JSON",
    });

    assert.equal(res.status, 200);
    assert.equal(store.getCapturedRequests().length, 1);
    assert.equal(store.getCapturedRequests()[0].contextInfo.apiFormat, "raw");
  });

  it("strips proxy-internal headers before forwarding", async () => {
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

    // x-target-url should not reach the upstream
    assert.equal(upstream.requests[0].headers["x-target-url"], undefined);
  });

  it("skips capturing utility endpoints", async () => {
    upstream.setResponse({ body: '{"count":42}' });

    await proxyRequest(handler, {
      method: "POST",
      path: "/v1/count_tokens",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "test", messages: [] }),
    });

    // Should not be stored
    assert.equal(store.getCapturedRequests().length, 0);
  });

  it("captures streaming responses", async () => {
    // Simulate SSE response
    const sseBody = [
      'data: {"type":"message_start","message":{"model":"claude-sonnet-4","usage":{"input_tokens":10}}}',
      'data: {"type":"content_block_delta","delta":{"text":"hi"}}',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}',
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
      body: JSON.stringify({
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });

    assert.equal(res.status, 200);
    assert.ok(res.body.includes("message_start"));

    // Store should capture as streaming
    assert.equal(store.getCapturedRequests().length, 1);
    const captured = store.getCapturedRequests()[0];
    assert.ok(captured.requestBytes > 0);
    assert.ok(captured.responseBytes > 0);
  });

  it("extracts source from URL path prefix", async () => {
    upstream.setResponse({
      body: JSON.stringify({
        model: "claude-sonnet-4",
        stop_reason: "end_turn",
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    });

    await proxyRequest(handler, {
      method: "POST",
      path: "/claude/v1/messages",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

    assert.equal(store.getCapturedRequests().length, 1);
    assert.equal(store.getCapturedRequests()[0].source, "claude");
  });

  it("forwards GET requests without body parsing", async () => {
    upstream.setResponse({
      body: JSON.stringify({ data: [{ id: "model-1" }] }),
    });

    const res = await proxyRequest(handler, {
      method: "GET",
      path: "/v1/models",
    });

    assert.equal(res.status, 200);
    const parsed = JSON.parse(res.body);
    assert.ok(Array.isArray(parsed.data));

    // GET should not be captured in store
    assert.equal(store.getCapturedRequests().length, 0);
  });
});
