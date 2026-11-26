import assert from "node:assert/strict";
import {
  createReadStream,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";
import { parseContextInfo } from "../src/core.js";
import { parseLharContent } from "../src/lhar.js";
import { ExportArchive } from "../src/server/export-archive.js";
import { Store } from "../src/server/store.js";
import { createApp } from "../src/server/webui.js";

function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), "lens-archive-"));
  const store = new Store({
    dataDir: dir,
    stateFile: path.join(dir, "state.jsonl"),
    maxSessions: 10,
    maxCompactMessages: 1,
    privacy: "full",
  });
  const body = {
    model: "unknown",
    system: "retained",
    messages: [{ role: "user", content: "hello" }],
  };
  const entry = store.storeRequest(
    parseContextInfo("anthropic", body, "anthropic-messages"),
    { content: [{ type: "text", text: "original é 🐈" }] },
    "test",
    body,
  );
  const filename = readdirSync(dir).find((name) => name.endsWith(".lhar"));
  assert.ok(filename);
  const file = path.join(dir, filename);
  const record = parseLharContent(readFileSync(file, "utf8")).entries[0];
  const detailFile = path.join(dir, "details", `${entry.id}.json`);
  const detail = JSON.parse(readFileSync(detailFile, "utf8"));
  delete detail.exportRecord;
  writeFileSync(detailFile, JSON.stringify(detail));
  return { dir, store, entry, file, record, detailFile, detail };
}

for (const duplicate of [false, true]) {
  it(`exports a valid UTF-8 EOF record without newline (duplicate=${duplicate})`, async () => {
    const f = fixture();
    try {
      const updated = structuredClone(f.record);
      updated.raw.response_body = { content: "latest é 🐈" };
      let content = "";
      if (duplicate) {
        content = `${JSON.stringify(f.record)}\r\n`;
      }
      writeFileSync(f.file, content + JSON.stringify(updated));
      for (const format of ["lhar", "lhar.json"]) {
        const response = await createApp(f.store, "test").request(
          `/api/export/${format}?privacy=full`,
        );
        assert.equal(response.status, 200);
        const records = parseLharContent(await response.text()).entries;
        assert.equal(records.length, 1);
        assert.deepEqual(records[0].raw, updated.raw);
      }
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
}

for (const missing of ["http", "context_lens", "raw", "gen_ai"] as const) {
  it(`ignores malformed retained records missing ${missing} without truncating HTTP exports`, async () => {
    const f = fixture();
    try {
      const bad: Record<string, unknown> = { ...f.record };
      delete bad[missing];
      writeFileSync(
        f.detailFile,
        JSON.stringify({ ...f.detail, exportRecord: bad }),
      );
      for (const validPrevious of [true, false]) {
        let prefix = "";
        if (validPrevious) {
          prefix = `${JSON.stringify(f.record)}\n`;
        }
        writeFileSync(f.file, prefix + JSON.stringify(bad));
        for (const format of ["lhar", "lhar.json"]) {
          for (const privacy of ["full", "standard", "minimal"]) {
            const response = await createApp(f.store, "test").request(
              `/api/export/${format}?privacy=${privacy}`,
            );
            assert.equal(response.status, 200);
            const text = await response.text();
            if (format === "lhar.json") {
              assert.ok(JSON.parse(text).lhar);
            }
            const records = parseLharContent(text).entries;
            assert.equal(records.length, 1);
            if (validPrevious && privacy === "full") {
              assert.deepEqual(records[0].raw, f.record.raw);
            } else {
              assert.deepEqual(records[0].raw, {
                request_body: null,
                response_body: null,
              });
            }
          }
        }
      }
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
}

it("destroys an active archive scan on abort before consuming the remaining file", async () => {
  const f = fixture();
  try {
    writeFileSync(f.file, `${JSON.stringify(f.record)}\n`.repeat(1000));
    const controller = new AbortController();
    let input: ReturnType<typeof createReadStream> | undefined;
    const archive = new ExportArchive(controller.signal, (file) => {
      input = createReadStream(file, { highWaterMark: 1024 });
      input.once("data", () => controller.abort());
      return input;
    });
    await assert.rejects(
      archive.read(
        f.file,
        f.entry.timestamp,
        f.entry.contextInfo.model,
        f.entry.source,
      ),
      { name: "AbortError" },
    );
    assert.ok(input?.destroyed);
    assert.ok(input.bytesRead > 0);
    assert.ok(input.bytesRead < statSync(f.file).size);
    await assert.rejects(
      archive.read(
        f.file,
        f.entry.timestamp,
        f.entry.contextInfo.model,
        f.entry.source,
      ),
      { name: "AbortError" },
    );
  } finally {
    rmSync(f.dir, { recursive: true, force: true });
  }
});

for (const disconnect of ["request", "body"]) {
  it(`propagates ${disconnect} cancellation to active export hydration`, {
    timeout: 5000,
  }, async () => {
    const f = fixture();
    try {
      const controller = new AbortController();
      let markStarted = () => {};
      let markStopped = () => {};
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const stopped = new Promise<void>((resolve) => {
        markStopped = resolve;
      });
      const original = f.store.getExportRecord.bind(f.store);
      f.store.getExportRecord = async (
        entry,
        privacy,
        archive = new ExportArchive(),
      ) => {
        const signal = archive.signal;
        assert.ok(signal);
        markStarted();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        markStopped();
        signal.throwIfAborted();
        return original(entry, privacy, archive);
      };
      const response = await createApp(f.store, "test").request(
        new Request("http://localhost/api/export/lhar.json?privacy=full", {
          signal: controller.signal,
        }),
      );
      await started;
      assert.ok(response.body);
      if (disconnect === "request") {
        controller.abort();
      } else {
        await response.body.cancel();
      }
      await stopped;
      if (disconnect === "request") {
        await response.body.cancel();
      }
    } finally {
      rmSync(f.dir, { recursive: true, force: true });
    }
  });
}
