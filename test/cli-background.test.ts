import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type BackgroundRuntime,
  backgroundStatus,
  backgroundStop,
  isSafeBackgroundPid,
  parseBackgroundArgs,
  parseBackgroundState,
} from "../src/cli/background.js";

function makeRuntime(state: string | null, alivePids = new Set<number>()) {
  const logs: string[] = [];
  const errors: string[] = [];
  const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  let cleared = false;

  const runtime: BackgroundRuntime = {
    readStateText: () => state,
    writeStateText: () => {},
    clearState: () => {
      cleared = true;
      state = null;
    },
    pidAlive: (pid) => alivePids.has(pid),
    kill: (pid, signal) => killed.push({ pid, signal }),
    spawnDetached: () => ({ pid: 1234, unref: () => {} }),
    sleep: async () => {},
    nowIso: () => "2026-01-01T00:00:00.000Z",
    log: (message) => logs.push(message),
    error: (message) => errors.push(message),
    proxyPath: "/app/proxy.js",
    analysisPath: "/app/analysis.js",
    proxyUrl: "http://localhost:4040",
    uiUrl: "http://localhost:4041",
    env: {},
  };

  return { runtime, logs, errors, killed, wasCleared: () => cleared };
}

describe("cli background manager", () => {
  it("parses background command args", () => {
    assert.deepEqual(parseBackgroundArgs([], false), {
      action: "status",
      noUi: false,
    });
    assert.deepEqual(parseBackgroundArgs(["start", "--no-ui"], false), {
      action: "start",
      noUi: true,
    });
    assert.deepEqual(parseBackgroundArgs(["start"], true), {
      action: "start",
      noUi: true,
    });
    assert.deepEqual(parseBackgroundArgs(["restart"], false), {
      error: "Error: background command requires one of: start, stop, status",
    });
  });

  it("rejects unsafe PID values from background state", () => {
    for (const pid of [0, 1, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.equal(
        isSafeBackgroundPid(pid),
        false,
        `pid ${pid} should be unsafe`,
      );
    }
    assert.equal(isSafeBackgroundPid(2), true);
    assert.equal(isSafeBackgroundPid(42_000), true);
  });

  it("rejects background state with unsafe PIDs", () => {
    assert.equal(
      parseBackgroundState(
        JSON.stringify({
          proxyPid: 1,
          analysisPid: null,
          noUi: true,
          startedAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
      null,
    );
    assert.equal(
      parseBackgroundState(
        JSON.stringify({
          proxyPid: 2222,
          analysisPid: 0,
          noUi: false,
          startedAt: "2026-01-01T00:00:00.000Z",
        }),
      ),
      null,
    );
  });

  it("does not kill unsafe PIDs when stopping", () => {
    const { runtime, logs, killed, wasCleared } = makeRuntime(
      JSON.stringify({
        proxyPid: 1,
        analysisPid: null,
        noUi: true,
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const code = backgroundStop(runtime);

    assert.equal(code, 0);
    assert.deepEqual(killed, []);
    assert.equal(wasCleared(), true);
    assert.deepEqual(logs, [
      "Background status: stale state found (invalid PID)",
    ]);
  });

  it("kills only safe PIDs when stopping valid background state", () => {
    const { runtime, logs, killed, wasCleared } = makeRuntime(
      JSON.stringify({
        proxyPid: 2222,
        analysisPid: 3333,
        noUi: false,
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const code = backgroundStop(runtime);

    assert.equal(code, 0);
    assert.deepEqual(killed, [
      { pid: 2222, signal: "SIGTERM" },
      { pid: 3333, signal: "SIGTERM" },
    ]);
    assert.equal(wasCleared(), true);
    assert.deepEqual(logs, ["Background services stopped."]);
  });

  it("clears stale state on status", () => {
    const { runtime, logs, wasCleared } = makeRuntime(
      JSON.stringify({
        proxyPid: 2222,
        analysisPid: null,
        noUi: true,
        startedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const code = backgroundStatus(runtime);

    assert.equal(code, 0);
    assert.equal(wasCleared(), true);
    assert.deepEqual(logs, [
      "Background status: stale state found (not running)",
    ]);
  });
});
