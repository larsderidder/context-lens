import assert from "node:assert/strict";
import fs, {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import {
  estimateCost,
  parseContextInfo,
  rescaleContextTokens,
} from "../src/core.js";
import { parseCodexSession } from "../src/importers/codex.js";
import { importSessions } from "../src/importers/index.js";
import { parseResponseUsage } from "../src/lhar.js";
import { estimatePpqCost } from "../src/server/ppq-pricing.js";
import { projectEntry } from "../src/server/projection.js";
import { Store } from "../src/server/store.js";
import type { ResponseData } from "../src/types.js";

function fixtures(fresh: number, cached: number) {
  return [
    {
      name: "Responses",
      provider: "openai",
      format: "responses",
      model: "gpt-4o",
      response: {
        usage: {
          input_tokens: 100_000,
          input_tokens_details: { cached_tokens: cached },
          output_tokens: 20,
        },
      },
      event(response: ResponseData) {
        return { type: "response.completed", response };
      },
    },
    {
      name: "Chat Completions",
      provider: "openai",
      format: "chat-completions",
      model: "gpt-4o",
      response: {
        usage: {
          prompt_tokens: 100_000,
          prompt_tokens_details: { cached_tokens: cached },
          completion_tokens: 20,
        },
      },
      event(response: ResponseData) {
        return { choices: [], ...response };
      },
    },
    {
      name: "Anthropic",
      provider: "anthropic",
      format: "anthropic-messages",
      model: "claude-sonnet-4",
      response: {
        usage: {
          input_tokens: fresh,
          cache_read_input_tokens: cached,
          cache_creation_input_tokens: 2_000,
          output_tokens: 20,
        },
      },
      event(response: ResponseData) {
        return { type: "message_start", message: response };
      },
    },
    {
      name: "Gemini",
      provider: "gemini",
      format: "gemini",
      model: "gemini-2.0-flash",
      response: {
        usageMetadata: {
          promptTokenCount: 100_000,
          cachedContentTokenCount: cached,
          candidatesTokenCount: 20,
        },
      },
      event(response: ResponseData) {
        return response;
      },
    },
  ] as const;
}

function temporaryStore(privacy: "standard" | "full" = "full") {
  const dir = mkdtempSync(path.join(tmpdir(), "context-lens-usage-"));
  const stateFile = path.join(dir, "state.jsonl");
  const options = {
    dataDir: dir,
    stateFile,
    maxSessions: 10,
    maxCompactMessages: 2,
    privacy,
  };
  return { dir, stateFile, options, store: new Store(options) };
}

function streaming(events: unknown[]): ResponseData {
  return {
    streaming: true,
    chunks: events
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join(""),
  };
}

describe("provider usage accounting", () => {
  it("preserves PPQ's inclusive input billing and unknown-price semantics", async () => {
    const pricing = { input_per_1M_tokens: 2, output_per_1M_tokens: 4 };
    for (const resolvedPrice of [pricing, null]) {
      const { dir, options } = temporaryStore();
      const store = new Store({
        ...options,
        ppqPricingLookup: async () => resolvedPrice,
      });
      try {
        const context = parseContextInfo(
          "openai",
          { model: "gpt-4o", input: "Synthetic context" },
          "responses",
        );
        const entry = store.storeRequest(
          context,
          fixtures(0, 100_000)[0].response,
          "fixture",
          undefined,
          {
            httpStatus: 200,
            targetUrl: "https://api.ppq.ai/v1/responses",
          },
        );
        assert.equal(entry.costUsd, null);
        await setImmediate();
        assert.equal(
          entry.costUsd,
          estimatePpqCost(resolvedPrice, 100_000, 20),
        );
        assert.equal(entry.contextInfo.totalTokens, 100_000);
        assert.equal(parseResponseUsage(entry.response).inputTokens, 0);
        const restored = new Store(options);
        restored.loadState();
        assert.equal(restored.getCapturedRequests()[0].costUsd, entry.costUsd);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
  for (const [fresh, cached] of [
    [10_000, 90_000],
    [0, 100_000],
  ]) {
    for (const fixture of fixtures(fresh, cached)) {
      for (const stream of [false, true]) {
        let encoding = "JSON";
        if (stream) {
          encoding = "SSE";
        }
        it(`${fixture.name} preserves ${fresh} fresh tokens (${encoding}) through export and reload`, async () => {
          const { dir, options, store } = temporaryStore();
          try {
            let response: ResponseData = fixture.response;
            if (stream) {
              response = streaming([
                fixture.event(fixture.response),
                fixture.event({ usage: {}, usageMetadata: {} }),
              ]);
            }
            const usage = parseResponseUsage(response);
            let cacheWrite = 0;
            if (fixture.provider === "anthropic") {
              cacheWrite = 2_000;
            }
            assert.equal(usage.hasInputTokens, true);
            assert.equal(usage.inputTokens, fresh);
            assert.equal(usage.cacheReadTokens, cached);
            assert.equal(usage.cacheWriteTokens, cacheWrite);
            assert.equal(usage.outputTokens, 20);
            const body = {
              model: fixture.model,
              messages: [{ role: "user", content: "Synthetic context" }],
              input: [{ role: "user", content: "Synthetic context" }],
              contents: [
                { role: "user", parts: [{ text: "Synthetic context" }] },
              ],
            };
            const context = parseContextInfo(
              fixture.provider,
              body,
              fixture.format,
            );
            const entry = store.storeRequest(
              context,
              response,
              "fixture",
              body,
            );
            const total = 100_000 + cacheWrite;
            const cost = estimateCost(
              fixture.model,
              fresh,
              20,
              cached,
              cacheWrite,
            );
            assert.equal(entry.contextInfo.totalTokens, total);
            assert.equal(entry.costUsd, cost);
            assert.equal(
              projectEntry(entry, entry.contextInfo).usage?.inputTokens,
              fresh,
            );
            assert.equal(
              entry.composition.reduce((sum, item) => sum + item.tokens, 0),
              total,
            );
            const exported = await store.getExportRecord(entry, "full");
            assert.equal(exported.gen_ai.usage.input_tokens, fresh);
            assert.equal(exported.usage_ext.cache_read_tokens, cached);
            assert.equal(exported.usage_ext.cost_usd, cost);
            assert.equal(exported.context_lens.growth.cumulative_tokens, total);
            assert.ok(exported.raw.response_body);

            const restored = new Store(options);
            restored.loadState();
            const [loaded] = restored.getCapturedRequests();
            assert.equal(loaded.contextInfo.totalTokens, total);
            assert.equal(loaded.costUsd, cost);
            assert.equal(
              parseResponseUsage(loaded.response).inputTokens,
              fresh,
            );
            const record = await restored.getExportRecord(loaded, "standard");
            assert.equal(record.gen_ai.usage.input_tokens, fresh);
            assert.equal(record.raw.response_body, null);
          } finally {
            rmSync(dir, { recursive: true, force: true });
          }
        });
      }
    }
  }

  it("accumulates split OpenAI counts without subtracting cache twice", () => {
    for (const events of [
      [
        { input_tokens: 100_000 },
        { input_tokens_details: { cached_tokens: 90_000 } },
      ],
      [
        { input_tokens_details: { cached_tokens: 90_000 } },
        { input_tokens: 100_000 },
      ],
    ]) {
      const response = streaming(
        [...events, {}, { output_tokens: 20 }, {}].map((usage) => ({
          response: { usage },
        })),
      );
      const usage = parseResponseUsage(response);
      assert.equal(usage.inputTokens, 10_000);
      assert.equal(usage.cacheReadTokens, 90_000);
      assert.equal(usage.outputTokens, 20);
    }
  });

  it("accepts actual zero counters after nonzero SSE counts", () => {
    const usage = parseResponseUsage(
      streaming([
        {
          response: {
            usage: {
              input_tokens: 100,
              output_tokens: 10,
              input_tokens_details: { cached_tokens: 50 },
              output_tokens_details: { reasoning_tokens: 5 },
            },
          },
        },
        {
          response: {
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        },
        { response: { usage: {} } },
      ]),
    );
    assert.equal(usage.hasInputTokens, true);
    assert.equal(usage.inputTokens, 0);
    assert.equal(usage.outputTokens, 0);
    assert.equal(usage.cacheReadTokens, 0);
    assert.equal(usage.thinkingTokens, 0);
  });

  for (const response of [
    { raw: true },
    { usage: {} },
    { usage: { input_tokens: 0, output_tokens: 0 } },
  ]) {
    it(`distinguishes absent usage from zero usage: ${JSON.stringify(response)}`, async () => {
      const { dir, options, store } = temporaryStore();
      try {
        const context = parseContextInfo(
          "openai",
          { model: "gpt-4o", input: "Synthetic context" },
          "responses",
        );
        const estimated = context.totalTokens;
        const actual = parseResponseUsage(response).hasInputTokens;
        const entry = store.storeRequest(context, response, "fixture");
        let expected = estimated;
        if (actual) {
          expected = 0;
        }
        assert.equal(entry.contextInfo.totalTokens, expected);
        assert.equal(entry.costUsd, estimateCost("gpt-4o", expected, 0));
        assert.equal(
          (await store.getExportRecord(entry, "standard")).gen_ai.usage
            .input_tokens,
          expected,
        );
        assert.equal(projectEntry(entry, context).usage !== null, actual);
        const restored = new Store(options);
        restored.loadState();
        const [loaded] = restored.getCapturedRequests();
        assert.equal(
          parseResponseUsage(loaded.response).hasInputTokens,
          actual,
        );
        assert.equal(loaded.contextInfo.totalTokens, expected);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("legacy cached usage repair", () => {
  for (const outputTokens of [0, 20]) {
    it(`preserves legacy estimates when only ${outputTokens} output tokens were known`, () => {
      const { dir, stateFile, options, store } = temporaryStore("standard");
      try {
        const context = parseContextInfo(
          "openai",
          { model: "gpt-4o", input: "Synthetic context" },
          "responses",
        );
        const entry = store.storeRequest(
          context,
          { usage: { output_tokens: outputTokens } },
          "fixture",
        );
        const estimated = entry.contextInfo.totalTokens;
        const cost = entry.costUsd;
        const lines = readFileSync(stateFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        const saved = lines.find((line) => line.type === "entry").data;
        delete saved.response._contextLensUsageVersion;
        saved.response.usage.input_tokens = 0;
        writeFileSync(
          stateFile,
          `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
        );
        const restored = new Store(options);
        restored.loadState();
        const [loaded] = restored.getCapturedRequests();
        assert.equal(loaded.contextInfo.totalTokens, estimated);
        assert.equal(loaded.costUsd, cost);
        assert.equal(parseResponseUsage(loaded.response).hasInputTokens, false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
  for (const stream of [false, true]) {
    for (const privacy of ["standard", "full"] as const) {
      let encoding = "JSON";
      if (stream) {
        encoding = "SSE";
      }
      it(`repairs only retained ${privacy} ${encoding} evidence, once`, async (t) => {
        const { dir, stateFile, options, store } = temporaryStore(privacy);
        try {
          const fixture = fixtures(10_000, 90_000)[0];
          let response: ResponseData = fixture.response;
          if (stream) {
            response = streaming([fixture.event(response)]);
          }
          const context = parseContextInfo(
            "openai",
            { model: "gpt-4o", input: "Synthetic context" },
            "responses",
          );
          store.storeRequest(context, response, "fixture");
          const lines = readFileSync(stateFile, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          const saved = lines.find((line) => line.type === "entry").data;
          delete saved.response._contextLensUsageVersion;
          saved.response.usage.input_tokens = 100_000;
          rescaleContextTokens(saved.contextInfo, 190_000);
          saved.costUsd = estimateCost("gpt-4o", 100_000, 20, 90_000);
          writeFileSync(
            stateFile,
            `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
          );
          const detailPath = path.join(dir, "details", `${saved.id}.json`);
          const detail = JSON.parse(readFileSync(detailPath, "utf8"));
          rescaleContextTokens(detail.contextInfo, 190_000);
          // Old retained export metadata must not override corrected current metadata.
          detail.exportRecord.gen_ai.usage.input_tokens = 100_000;
          detail.exportRecord.usage_ext.cost_usd = saved.costUsd;
          writeFileSync(detailPath, JSON.stringify(detail));

          const restored = new Store(options);
          restored.loadState();
          const [entry] = restored.getCapturedRequests();
          let expectedInput = 100_000;
          let expectedTotal = 190_000;
          let expectedCost = saved.costUsd;
          if (privacy === "full") {
            expectedInput = 10_000;
            expectedTotal = 100_000;
            expectedCost = estimateCost("gpt-4o", 10_000, 20, 90_000);
          }
          assert.equal(
            parseResponseUsage(entry.response).inputTokens,
            expectedInput,
          );
          assert.equal(entry.contextInfo.totalTokens, expectedTotal);
          assert.equal(entry.costUsd, expectedCost);
          assert.equal(
            restored.getEntryDetail(entry.id)?.totalTokens,
            expectedTotal,
          );
          const exported = await restored.getExportRecord(entry, "full");
          assert.equal(exported.gen_ai.usage.input_tokens, expectedInput);
          assert.equal(exported.usage_ext.cost_usd, expectedCost);
          assert.deepEqual(exported.raw, detail.exportRecord.raw);
          const state = readFileSync(stateFile, "utf8");
          const reads = t.mock.method(fs, "readFileSync");
          const reloaded = new Store(options);
          reloaded.loadState();
          assert.equal(
            reloaded.getCapturedRequests()[0].contextInfo.totalTokens,
            expectedTotal,
          );
          assert.equal(readFileSync(stateFile, "utf8"), state);
          assert.equal(
            reads.mock.calls.filter((call) => call.arguments[0] === detailPath)
              .length,
            0,
            "legacy details must not be reread after an unsuccessful repair",
          );
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }
});

describe("imported cached usage", () => {
  for (const [fresh, cached] of [
    [10_000, 90_000],
    [0, 100_000],
  ]) {
    it(`imports Codex with ${fresh} fresh input and retains cache usage`, () => {
      const { dir, options, store } = temporaryStore();
      const home = process.env.HOME;
      const userProfile = process.env.USERPROFILE;
      try {
        const sessionsDir = path.join(dir, ".codex", "sessions");
        mkdirSync(sessionsDir, { recursive: true });
        const file = path.join(sessionsDir, "fixture.jsonl");
        const timestamp = "2026-01-01T00:00:00.000Z";
        writeFileSync(
          file,
          [
            {
              timestamp,
              type: "session_meta",
              payload: { id: "usage-fixture", cwd: "/synthetic" },
            },
            { timestamp, type: "turn_context", payload: { model: "gpt-4o" } },
            {
              timestamp,
              type: "response_item",
              payload: {
                type: "message",
                role: "user",
                content: "Synthetic context",
              },
            },
            {
              timestamp,
              type: "response_item",
              payload: {
                type: "message",
                role: "assistant",
                content: "Synthetic response",
              },
            },
            {
              timestamp,
              type: "event_msg",
              payload: {
                type: "token_count",
                info: {
                  last_token_usage: {
                    input_tokens: 100_000,
                    cached_input_tokens: cached,
                    output_tokens: 20,
                  },
                },
              },
            },
          ]
            .map((line) => JSON.stringify(line))
            .join("\n"),
        );
        const session = parseCodexSession(file);
        assert.equal(session?.turns[0].inputTokens, fresh);
        assert.equal(session?.turns[0].cacheReadTokens, cached);
        // Discovery is confined to this synthetic home, including absent Claude sessions.
        process.env.HOME = dir;
        process.env.USERPROFILE = dir;
        const summaries = importSessions(store);
        assert.equal(
          summaries.find((summary) => summary.source === "codex")?.imported,
          1,
        );
        const [entry] = store.getCapturedRequests();
        assert.equal(entry.contextInfo.totalTokens, 100_000);
        assert.equal(parseResponseUsage(entry.response).inputTokens, fresh);
        assert.equal(
          parseResponseUsage(entry.response).cacheReadTokens,
          cached,
        );
        assert.equal(entry.costUsd, estimateCost("gpt-4o", fresh, 20, cached));
        const restored = new Store(options);
        restored.loadState();
        assert.equal(
          restored.getCapturedRequests()[0].contextInfo.totalTokens,
          100_000,
        );
      } finally {
        if (home === undefined) {
          delete process.env.HOME;
        } else {
          process.env.HOME = home;
        }
        if (userProfile === undefined) {
          delete process.env.USERPROFILE;
        } else {
          process.env.USERPROFILE = userProfile;
        }
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
