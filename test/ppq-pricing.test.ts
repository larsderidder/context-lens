import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { estimateCost, parseContextInfo } from "../src/core.js";
import {
  createPpqPricingLookup,
  estimatePpqCost,
  isPpqTarget,
  type PpqPricingLookup,
} from "../src/server/ppq-pricing.js";
import { Store } from "../src/server/store.js";
import type { ResponseData } from "../src/types.js";

const pricing = { input_per_1M_tokens: 2, output_per_1M_tokens: 8 };

function makeStore(lookup: PpqPricingLookup) {
  const dir = mkdtempSync(path.join(tmpdir(), "context-lens-ppq-"));
  const opts = {
    dataDir: dir,
    stateFile: path.join(dir, "state.jsonl"),
    maxSessions: 10,
    maxCompactMessages: 2,
    ppqPricingLookup: lookup,
  };
  return { dir, opts, store: new Store(opts) };
}

function capture(
  store: Store,
  targetUrl: string,
  response?: ResponseData,
  status = 200,
) {
  const body = {
    model: "gpt-4o",
    messages: [{ role: "user", content: "hello" }],
  };
  const context = parseContextInfo("openai", body, "chat-completions");
  return store.storeRequest(
    context,
    response ?? { usage: { prompt_tokens: 1000, completion_tokens: 250 } },
    "test",
    body,
    { targetUrl, httpStatus: status },
  );
}

const ppqUrl = "https://api.ppq.ai/v1/chat/completions";

describe("PPQ pricing", () => {
  it("matches only the API hostname", () => {
    assert.equal(isPpqTarget(ppqUrl), true);
    assert.equal(
      isPpqTarget("https://API.PPQ.AI:443/v1/chat/completions"),
      true,
    );
    for (const url of [
      "https://api.ppq.ai.evil.test/v1",
      "https://api.ppq.ai@evil.test/v1",
      "https://evil.test/api.ppq.ai",
      "https://evil.test/?host=ppq.ai",
      "https://ppq.ai/v1",
      "not a URL",
      "file://api.ppq.ai/v1",
      null,
    ]) {
      assert.equal(isPpqTarget(url), false, String(url));
    }
  });

  it("fetches lazily once, coalesces lookups, and uses a bounded HTTPS request", async () => {
    let calls = 0;
    const lookup = createPpqPricingLookup(async (url, options) => {
      calls++;
      assert.equal(url, "https://api.ppq.ai/v1/models");
      assert.equal(options?.redirect, "error");
      assert.ok(options?.signal instanceof AbortSignal);
      return Response.json({ data: [{ id: "gpt-4o", pricing }] });
    });
    assert.equal(calls, 0);
    assert.deepEqual(await Promise.all([lookup("gpt-4o"), lookup("gpt-4o")]), [
      pricing,
      pricing,
    ]);
    assert.equal(await lookup("missing"), null);
    assert.equal(calls, 1);
    assert.equal(estimatePpqCost(pricing, 1000, 250), 0.004);
    assert.equal(
      estimatePpqCost(
        { input_per_1M_tokens: 0, output_per_1M_tokens: 0 },
        1000,
        250,
      ),
      0,
    );
  });

  it("rejects malformed and invalid model pricing without discarding valid rows", async () => {
    const invalid = [null, {}, "2", -1, Number.NaN, Number.POSITIVE_INFINITY];
    // Return parsed external data directly so non-JSON finite values are also checked.
    const rows = invalid.flatMap((value, index) => [
      {
        id: `input-${index}`,
        pricing: { input_per_1M_tokens: value, output_per_1M_tokens: 8 },
      },
      {
        id: `output-${index}`,
        pricing: { input_per_1M_tokens: 2, output_per_1M_tokens: value },
      },
    ]);
    const lookup = createPpqPricingLookup(async () => {
      const response = Response.json({});
      response.json = async () => ({
        data: [
          null,
          {},
          { id: 42, pricing },
          ...rows,
          { id: "valid", pricing },
        ],
      });
      return response;
    });
    for (const row of rows) {
      assert.equal(await lookup(row.id), null);
    }
    assert.deepEqual(await lookup("valid"), pricing);
    assert.equal(estimatePpqCost(pricing, -1, 1), null);
    assert.equal(estimatePpqCost(pricing, Number.POSITIVE_INFINITY, 1), null);
  });

  it("returns unknown on HTTP, network, malformed JSON and envelope failures without retries", async () => {
    const fetchers: (typeof fetch)[] = [
      async () => {
        throw new Error("offline");
      },
      async () => new Response("unavailable", { status: 503 }),
      async () => new Response("not JSON"),
      async () => Response.json({ data: {} }),
      async () => Response.json(null),
    ];
    for (const fetcher of fetchers) {
      let calls = 0;
      const lookup = createPpqPricingLookup(async (...args) => {
        calls++;
        return fetcher(...args);
      });
      assert.equal(await lookup("gpt-4o"), null);
      assert.equal(await lookup("gpt-4o"), null);
      assert.equal(calls, 1);
    }
  });
});

describe("Store PPQ costs", () => {
  for (const streaming of [false, true]) {
    let format = "JSON";
    if (streaming) {
      format = "streaming";
    }
    it(`prices ${format} usage and persists the resolved cost`, async () => {
      const { dir, opts, store } = makeStore(async () => pricing);
      try {
        let response: ResponseData = {
          usage: { prompt_tokens: 1000, completion_tokens: 250 },
          choices: [],
        };
        if (streaming) {
          response = {
            streaming: true,
            chunks: `data: ${JSON.stringify(response)}\n\ndata: [DONE]\n\n`,
          };
        }
        const entry = capture(store, ppqUrl, response);
        assert.equal(entry.costUsd, null);
        await setImmediate();
        assert.equal(entry.costUsd, 0.004);
        const restored = new Store(opts);
        restored.loadState();
        assert.equal(restored.getCapturedRequests()[0].costUsd, 0.004);
        const filename = readdirSync(dir).find((name) =>
          name.endsWith(".lhar"),
        );
        assert.ok(filename);
        assert.match(readFileSync(path.join(dir, filename), "utf8"), /0\.004/);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("does not look up pricing at construction, reload, nonPPQ, spoofed URLs or HTTP failures", async () => {
    let calls = 0;
    const { dir, opts, store } = makeStore(async () => {
      calls++;
      return pricing;
    });
    try {
      assert.equal(calls, 0);
      for (const url of [
        "https://api.openai.com/v1/chat/completions",
        "https://api.ppq.ai.evil.test/v1",
        "https://evil.test/api.ppq.ai",
      ]) {
        assert.equal(
          capture(store, url).costUsd,
          estimateCost("gpt-4o", 1000, 250),
        );
      }
      assert.equal(capture(store, ppqUrl, undefined, 429).costUsd, 0);
      new Store(opts).loadState();
      await setImmediate();
      assert.equal(calls, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps missing, rejected or invalid pricing unknown through reload", async () => {
    const lookups: PpqPricingLookup[] = [
      async () => null,
      async () => {
        throw new Error("offline");
      },
      async () => ({ input_per_1M_tokens: -1, output_per_1M_tokens: 8 }),
    ];
    for (const lookup of lookups) {
      const { dir, opts, store } = makeStore(lookup);
      try {
        const entry = capture(store, ppqUrl);
        await setImmediate();
        assert.equal(entry.costUsd, null);
        const restored = new Store(opts);
        restored.loadState();
        assert.equal(restored.getCapturedRequests()[0].costUsd, null);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("does not resurrect entries removed while pricing is pending", async () => {
    let resolve!: (value: typeof pricing) => void;
    const pending = new Promise<typeof pricing>((done) => {
      resolve = done;
    });
    const { dir, opts, store } = makeStore(() => pending);
    try {
      capture(store, ppqUrl);
      store.resetAll();
      resolve(pricing);
      await setImmediate();
      const restored = new Store(opts);
      restored.loadState();
      assert.equal(restored.getCapturedRequests().length, 0);
      assert.equal(
        readdirSync(dir).some((name) => name.endsWith(".lhar")),
        false,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
