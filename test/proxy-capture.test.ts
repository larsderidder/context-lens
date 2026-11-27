import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  type CaptureData,
  createCaptureIngestor,
  createCaptureWriter,
} from "../src/proxy/capture.js";

function makeCaptureData(overrides?: Partial<CaptureData>): CaptureData {
  return {
    timestamp: new Date().toISOString(),
    method: "POST",
    path: "/v1/messages",
    source: null,
    provider: "anthropic",
    apiFormat: "anthropic-messages",
    targetUrl: "https://api.anthropic.com/v1/messages",
    requestHeaders: { "content-type": "application/json" },
    requestBody: { model: "test", messages: [] },
    requestBytes: 100,
    responseStatus: 200,
    responseHeaders: { "content-type": "application/json" },
    responseBody: '{"ok":true}',
    responseIsStreaming: false,
    responseBytes: 50,
    timings: { send_ms: 10, wait_ms: 100, receive_ms: 20, total_ms: 130 },
    sessionId: null,
    ...overrides,
  };
}

describe("proxy/capture", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "capture-test-"));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it("creates the capture directory if it does not exist", () => {
    const subdir = join(dir, "nested", "captures");
    const writer = createCaptureWriter(subdir);
    writer.write(makeCaptureData());
    assert.ok(existsSync(subdir));
  });

  it("writes valid JSON capture files", () => {
    const writer = createCaptureWriter(dir);
    writer.write(makeCaptureData({ provider: "anthropic" }));

    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(files.length, 1);

    const data = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));
    assert.equal(data.provider, "anthropic");
    assert.equal(data.method, "POST");
    assert.equal(data.path, "/v1/messages");
    assert.deepEqual(data.requestBody, { model: "test", messages: [] });
  });

  it("writes files with timestamp-sequence names", () => {
    const writer = createCaptureWriter(dir);
    writer.write(makeCaptureData());
    writer.write(makeCaptureData());
    writer.write(makeCaptureData());

    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
    assert.equal(files.length, 3);

    // Files should be naturally sorted (timestamp + counter)
    for (const f of files) {
      assert.match(f, /^\d+-\d{6}\.json$/);
    }

    // Sequence numbers should increment
    const seqs = files.map((f) => parseInt(f.split("-")[1], 10));
    assert.deepEqual(seqs, [0, 1, 2]);
  });

  it("does not leave .tmp files on success", () => {
    const writer = createCaptureWriter(dir);
    writer.write(makeCaptureData());

    const allFiles = readdirSync(dir);
    const tmpFiles = allFiles.filter((f) => f.endsWith(".tmp"));
    assert.equal(tmpFiles.length, 0);
  });

  it("returns the filename on success", () => {
    const writer = createCaptureWriter(dir);
    const filename = writer.write(makeCaptureData());
    assert.ok(filename);
    assert.match(filename!, /\.json$/);
    assert.ok(existsSync(join(dir, filename!)));
  });

  it("preserves all capture fields round-trip", () => {
    const writer = createCaptureWriter(dir);
    const original = makeCaptureData({
      source: "claude",
      responseIsStreaming: true,
      requestBody: {
        model: "claude-sonnet-4",
        messages: [{ role: "user", content: "hi" }],
      },
    });
    writer.write(original);

    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    const loaded = JSON.parse(readFileSync(join(dir, files[0]), "utf8"));

    assert.equal(loaded.source, "claude");
    assert.equal(loaded.responseIsStreaming, true);
    assert.equal(loaded.requestBody.model, "claude-sonnet-4");
    assert.equal(loaded.timings.total_ms, 130);
  });

  it("delivers captures directly even when the global agent uses a proxy", {
    timeout: 5000,
  }, async (t) => {
    let proxyRequests = 0;
    const proxy = http.createServer((req, res) => {
      proxyRequests++;
      req.resume();
      res.end();
    });
    const ingest = http.createServer();
    for (const server of [proxy, ingest]) {
      t.after(
        () =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      );
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
    }
    const proxyPort = (proxy.address() as AddressInfo).port;
    const ingestPort = (ingest.address() as AddressInfo).port;
    const globalAgent = http.globalAgent;
    http.globalAgent = new http.Agent({
      proxyEnv: { HTTP_PROXY: `http://127.0.0.1:${proxyPort}`, NO_PROXY: "" },
    });
    t.after(() => {
      http.globalAgent.destroy();
      http.globalAgent = globalAgent;
    });
    const url = `http://127.0.0.1:${ingestPort}/api/ingest?source=test`;

    // Confirm the ambient agent really sends requests through the proxy.
    await new Promise<void>((resolve, reject) => {
      http
        .get(url, (res) => {
          res.resume();
          res.on("end", resolve);
        })
        .on("error", reject);
    });
    assert.equal(proxyRequests, 1);

    const received = new Promise<{ path: string | undefined; body: string }>(
      (resolve) => {
        ingest.once("request", (req, res) => {
          let body = "";
          req.setEncoding("utf8");
          req.on("data", (chunk: string) => {
            body += chunk;
          });
          req.on("end", () => {
            res.end("{}");
            resolve({ path: req.url, body });
          });
        });
      },
    );
    const capture = makeCaptureData();
    createCaptureIngestor(url).post(capture);
    const result = await received;
    assert.equal(result.path, "/api/ingest?source=test");
    assert.deepEqual(JSON.parse(result.body), capture);
    assert.equal(
      proxyRequests,
      1,
      "capture delivery must bypass the global proxy agent",
    );
  });
});
