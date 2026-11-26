import assert from "node:assert/strict";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { ingestCapture } from "../src/analysis/ingest.js";
import { CaptureWatcher } from "../src/analysis/watcher.js";
import { parseLharContent } from "../src/lhar.js";
import type { LharRecord } from "../src/lhar-types.generated.js";
import type { CaptureData } from "../src/proxy/capture.js";
import { Store } from "../src/server/store.js";
import { createApp } from "../src/server/webui.js";
import type { PrivacyLevel } from "../src/types.js";

const body = {
  model: "unknown-export-model",
  system: "system instructions".repeat(100),
  tools: [
    {
      name: "read_file",
      description: "Read file",
      input_schema: { type: "object", properties: {} },
    },
  ],
  messages: Array.from({ length: 5 }, (_, i) => ({
    role: "user",
    content: `message ${i} ${"payload".repeat(100)}`,
  })),
  max_tokens: 123,
};
const responseBody = {
  content: [{ type: "text", text: "complete response".repeat(100) }],
  usage: { input_tokens: 120, output_tokens: 10 },
};

for (const retention of ["full", "standard", "minimal"] as const) {
  it(`exports retained ${retention} payloads after compaction and reload`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lens-export-"));
    const opts = {
      dataDir: dir,
      stateFile: path.join(dir, "state.jsonl"),
      maxSessions: 10,
      maxCompactMessages: 1,
      privacy: retention,
    };
    try {
      let store = new Store(opts);
      const app = createApp(store, "test");
      const ingest = await app.request("/api/ingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: "export-capture",
          timestamp: new Date().toISOString(),
          provider: "anthropic",
          apiFormat: "anthropic-messages",
          source: "test",
          path: "/v1/messages",
          targetUrl: "https://api.anthropic.com/v1/messages",
          requestBody: body,
          responseBody: JSON.stringify(responseBody),
          responseIsStreaming: false,
          responseStatus: 200,
          requestHeaders: {
            authorization: "test-placeholder",
            "x-request-id": "kept",
          },
          responseHeaders: {
            "set-cookie": "test-cookie",
            "x-response-id": "kept",
          },
          requestBytes: 100,
          responseBytes: 200,
          timings: {
            total_ms: 10,
            wait_ms: 5,
            receive_ms: 5,
            send_ms: 0,
            connect_ms: 0,
            dns_ms: 0,
            tls_ms: 0,
          },
        }),
      });
      assert.equal(ingest.status, 200, await ingest.text());
      for (const reload of [false, true]) {
        if (reload) {
          // Simulate pre-fix detail files: archives must remain authoritative.
          for (const name of readdirSync(path.join(dir, "details"))) {
            const file = path.join(dir, "details", name);
            const detail = JSON.parse(readFileSync(file, "utf8"));
            delete detail.exportRecord;
            writeFileSync(file, JSON.stringify(detail));
          }
          for (const name of readdirSync(dir).filter((name) =>
            name.endsWith(".lhar"),
          )) {
            const file = path.join(dir, name);
            const content = readFileSync(file, "utf8");
            const update = parseLharContent(content).entries[0];
            update.usage_ext.cost_usd = 99;
            update.context_lens.window_size = 1;
            if (retention !== "minimal") {
              update.http.request_headers["x-archive-update"] = "last";
            }
            writeFileSync(file, `${content}${JSON.stringify(update)}\n`);
          }
          store = new Store(opts);
          store.loadState();
        }
        assert.equal(store.getCapturedRequests()[0].rawBody, undefined);
        store.getCapturedRequests()[0].contextLimit = 500_000;
        for (const privacy of [
          "full",
          "standard",
          "minimal",
        ] as PrivacyLevel[]) {
          for (const format of ["lhar", "lhar.json"]) {
            const result = await createApp(store, "test").request(
              `/api/export/${format}?privacy=${privacy}`,
            );
            assert.equal(result.status, 200);
            const text = await result.text();
            let records: LharRecord[];
            if (format === "lhar") {
              records = text
                .trim()
                .split("\n")
                .map((line) => JSON.parse(line))
                .filter((record) => record.type === "entry");
            } else {
              records = JSON.parse(text).lhar.entries;
            }
            assert.equal(records.length, 1);
            assert.deepEqual(parseLharContent(text).entries, records);
            const record = records[0];
            assert.equal(record.usage_ext.cost_usd, null);
            assert.equal(record.context_lens.window_size, 500_000);
            assert.equal(
              store.getCapturedRequests()[0].contextInfo.systemPrompts.length,
              0,
            );
            assert.equal(
              store.getCapturedRequests()[0].contextInfo.messages.length,
              1,
            );
            if (privacy === "full" && retention === "full") {
              assert.deepEqual(record.raw.request_body, body);
              assert.deepEqual(record.raw.response_body, responseBody);
            } else {
              assert.equal(record.raw.request_body, null);
              assert.equal(record.raw.response_body, null);
            }
            assert.equal(record.context_lens.tool_definitions?.length, 1);
            assert.ok(!text.includes("test-placeholder"));
            assert.ok(!text.includes("test-cookie"));
            if (privacy === "minimal" || retention === "minimal") {
              assert.deepEqual(record.http.request_headers, {});
            } else {
              assert.equal(record.http.request_headers["x-request-id"], "kept");
              if (reload) {
                assert.equal(
                  record.http.request_headers["x-archive-update"],
                  "last",
                );
              }
            }
          }
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

it("reimports watched captures from both exports without losing full payloads or zero costs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lens-export-watch-"));
  const opts = {
    dataDir: path.join(dir, "data"),
    stateFile: path.join(dir, "data", "state.jsonl"),
    maxSessions: 10,
    maxCompactMessages: 1,
    privacy: "full" as const,
  };
  const capture: CaptureData = {
    timestamp: new Date().toISOString(),
    sessionId: null,
    method: "POST",
    path: "/v1/messages",
    provider: "anthropic",
    apiFormat: "anthropic-messages",
    source: "test",
    targetUrl: "https://api.anthropic.com/v1/messages",
    requestHeaders: {},
    requestBody: body,
    requestBytes: 100,
    responseHeaders: {},
    responseBody: JSON.stringify(responseBody),
    responseIsStreaming: false,
    responseStatus: 400,
    responseBytes: 200,
    timings: { send_ms: 0, wait_ms: 0, receive_ms: 0, total_ms: 0 },
  };
  let watcher: CaptureWatcher | undefined;
  try {
    // Real proxy CaptureData uses flat requestBody/responseBody, not nested body strings.
    writeFileSync(path.join(dir, "capture.json"), JSON.stringify(capture));
    let store = new Store(opts);
    watcher = new CaptureWatcher({
      captureDir: dir,
      onCapture: (data) => ingestCapture(store, data),
    });
    watcher.start();
    assert.ok(!readdirSync(dir).includes("capture.json"));
    assert.equal(store.getCapturedRequests()[0].costUsd, 0);
    for (const format of ["lhar", "lhar.json"]) {
      const exported = await createApp(store, "test").request(
        `/api/export/${format}?privacy=full`,
      );
      const record = parseLharContent(await exported.text()).entries[0];
      assert.equal(record.usage_ext.cost_usd, 0);
      assert.deepEqual(record.raw.request_body, body);
      assert.deepEqual(record.raw.response_body, responseBody);
      const imported = new Store({
        ...opts,
        dataDir: path.join(dir, `import-${format}`),
        stateFile: path.join(dir, `import-${format}`, "state.jsonl"),
      });
      ingestCapture(imported, {
        ...capture,
        requestBody: record.raw.request_body,
        responseBody: JSON.stringify(record.raw.response_body),
      });
      const reexport = await createApp(imported, "test").request(
        `/api/export/${format}?privacy=full`,
      );
      const roundTrip = parseLharContent(await reexport.text()).entries[0];
      assert.deepEqual(roundTrip.raw, record.raw);
    }
    store = new Store(opts);
    store.loadState();
    const entry = store.getCapturedRequests()[0];
    assert.equal(entry.costUsd, 0);
    // With all authoritative payload copies removed, never export compact usage as a raw response.
    for (const name of readdirSync(opts.dataDir)) {
      if (name.endsWith(".lhar")) {
        rmSync(path.join(opts.dataDir, name));
      }
    }
    const detailFile = path.join(opts.dataDir, "details", `${entry.id}.json`);
    const detail = JSON.parse(readFileSync(detailFile, "utf8"));
    delete detail.exportRecord;
    writeFileSync(detailFile, JSON.stringify(detail));
    assert.deepEqual((await store.getExportRecord(entry, "full")).raw, {
      request_body: null,
      response_body: null,
    });
  } finally {
    watcher?.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
