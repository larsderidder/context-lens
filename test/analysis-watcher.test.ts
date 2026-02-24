import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { CaptureWatcher } from "../src/analysis/watcher.js";
import type { CaptureData } from "../src/proxy/capture.js";

function makeCaptureJson(overrides?: Partial<CaptureData>): string {
  const data: CaptureData = {
    timestamp: new Date().toISOString(),
    method: "POST",
    path: "/v1/messages",
    source: null,
    provider: "anthropic",
    apiFormat: "anthropic-messages",
    targetUrl: "https://api.anthropic.com/v1/messages",
    requestHeaders: {},
    requestBody: { model: "test", messages: [] },
    requestBytes: 100,
    responseStatus: 200,
    responseHeaders: {},
    responseBody: '{"ok":true}',
    responseIsStreaming: false,
    responseBytes: 50,
    timings: { send_ms: 1, wait_ms: 2, receive_ms: 3, total_ms: 6 },
    sessionId: null,
    ...overrides,
  };
  return JSON.stringify(data);
}

describe("analysis/watcher", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "watcher-test-"));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it("replays existing capture files on start", () => {
    // Pre-populate capture files
    writeFileSync(
      join(dir, "1000-000000.json"),
      makeCaptureJson({ provider: "anthropic" }),
    );
    writeFileSync(
      join(dir, "1001-000001.json"),
      makeCaptureJson({ provider: "openai" }),
    );

    const captured: CaptureData[] = [];
    const watcher = new CaptureWatcher({
      captureDir: dir,
      onCapture: (c) => captured.push(c),
      deleteAfterProcessing: false,
    });

    watcher.start();
    watcher.stop();

    assert.equal(captured.length, 2);
    assert.equal(captured[0].provider, "anthropic");
    assert.equal(captured[1].provider, "openai");
  });

  it("replays in sorted order", () => {
    writeFileSync(
      join(dir, "2000-000001.json"),
      makeCaptureJson({ source: "second" }),
    );
    writeFileSync(
      join(dir, "1000-000000.json"),
      makeCaptureJson({ source: "first" }),
    );

    const sources: (string | null)[] = [];
    const watcher = new CaptureWatcher({
      captureDir: dir,
      onCapture: (c) => sources.push(c.source),
      deleteAfterProcessing: false,
    });

    watcher.start();
    watcher.stop();

    assert.deepEqual(sources, ["first", "second"]);
  });

  it("ignores .tmp files", () => {
    writeFileSync(join(dir, "1000-000000.json"), makeCaptureJson());
    writeFileSync(join(dir, "1001-000001.json.tmp"), makeCaptureJson());

    const captured: CaptureData[] = [];
    const watcher = new CaptureWatcher({
      captureDir: dir,
      onCapture: (c) => captured.push(c),
      deleteAfterProcessing: false,
    });

    watcher.start();
    watcher.stop();

    assert.equal(captured.length, 1);
  });

  it("deletes capture files after processing when enabled", () => {
    writeFileSync(join(dir, "1000-000000.json"), makeCaptureJson());

    const watcher = new CaptureWatcher({
      captureDir: dir,
      onCapture: () => {},
      deleteAfterProcessing: true,
    });

    watcher.start();
    watcher.stop();

    const remaining = readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(remaining.length, 0);
  });

  it("keeps capture files when deleteAfterProcessing is false", () => {
    writeFileSync(join(dir, "1000-000000.json"), makeCaptureJson());

    const watcher = new CaptureWatcher({
      captureDir: dir,
      onCapture: () => {},
      deleteAfterProcessing: false,
    });

    watcher.start();
    watcher.stop();

    const remaining = readdirSync(dir).filter((f) => f.endsWith(".json"));
    assert.equal(remaining.length, 1);
  });

  it("does not process the same file twice", () => {
    writeFileSync(join(dir, "1000-000000.json"), makeCaptureJson());

    let count = 0;
    const watcher = new CaptureWatcher({
      captureDir: dir,
      onCapture: () => count++,
      deleteAfterProcessing: false,
    });

    watcher.start();
    // Manually trigger a scan (simulating fs.watch firing twice)
    (watcher as any).scanForNew();
    watcher.stop();

    assert.equal(count, 1);
  });

  it("handles empty capture directory", () => {
    const captured: CaptureData[] = [];
    const watcher = new CaptureWatcher({
      captureDir: dir,
      onCapture: (c) => captured.push(c),
      deleteAfterProcessing: false,
    });

    watcher.start();
    watcher.stop();

    assert.equal(captured.length, 0);
  });

  it("creates capture directory if it does not exist", () => {
    const subdir = join(dir, "nested", "captures");
    assert.ok(!existsSync(subdir));

    const watcher = new CaptureWatcher({
      captureDir: subdir,
      onCapture: () => {},
      deleteAfterProcessing: false,
    });

    watcher.start();
    watcher.stop();

    assert.ok(existsSync(subdir));
  });

  it("picks up new files via polling", async () => {
    const captured: CaptureData[] = [];
    const watcher = new CaptureWatcher({
      captureDir: dir,
      onCapture: (c) => captured.push(c),
      deleteAfterProcessing: false,
      pollInterval: 50,
    });

    watcher.start();

    // Write a file after the watcher started
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(
      join(dir, "9999-000000.json"),
      makeCaptureJson({ source: "late" }),
    );

    // Wait for poll to pick it up
    await new Promise((resolve) => setTimeout(resolve, 150));
    watcher.stop();

    assert.equal(captured.length, 1);
    assert.equal(captured[0].source, "late");
  });
});
