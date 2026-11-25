import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parse } from "smol-toml";

import { exampleConfig, getConfigPath, loadConfig } from "../src/config.js";

describe("config", () => {
  let home: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    originalHome = process.env.HOME;
    home = mkdtempSync(path.join(tmpdir(), "context-lens-config-test-"));
    process.env.HOME = home;
    mkdirSync(path.join(home, ".context-lens"));
  });

  afterEach(() => {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    rmSync(home, { recursive: true, force: true });
  });

  it("uses defaults when the isolated home has no config file", () => {
    assert.equal(
      getConfigPath(),
      path.join(home, ".context-lens", "config.toml"),
    );
    assert.deepEqual(loadConfig(), {
      proxy: { port: 4040, redact: undefined, rehydrate: false },
      ui: { port: 4041, noOpen: false },
      privacy: { level: undefined },
      mitm: {
        port: 8080,
        extraArgs: [],
        lensSource: "commandName",
        lensSessionId: "random",
      },
    });
  });

  it("parses every supported section from a TOML file", () => {
    writeFileSync(
      getConfigPath(),
      `
[proxy]
port = 5040
redact = "pii"
rehydrate = true
[ui]
port = 5041
no_open = true
[privacy]
level = "minimal"
[mitm]
port = 9080
extra_args = ["--set", "stream_large_bodies=5m"]
lens_source = "manual"
lens_session_id = "fixed-session"
`,
    );
    assert.deepEqual(loadConfig(), {
      proxy: { port: 5040, redact: "pii", rehydrate: true },
      ui: { port: 5041, noOpen: true },
      privacy: { level: "minimal" },
      mitm: {
        port: 9080,
        extraArgs: ["--set", "stream_large_bodies=5m"],
        lensSource: "manual",
        lensSessionId: "fixed-session",
      },
    });
  });

  it("keeps defaults for omitted sections and keys", () => {
    const defaults = loadConfig();
    writeFileSync(getConfigPath(), "[ui]\nno_open = true\n");
    defaults.ui.noOpen = true;
    assert.deepEqual(loadConfig(), defaults);
  });

  it("ignores unsupported values without discarding valid settings", () => {
    const expected = loadConfig();
    writeFileSync(
      getConfigPath(),
      `
[proxy]
port = "5040"
redact = "unsupported"
rehydrate = "true"
[ui]
port = 5041
no_open = 1
[privacy]
level = "public"
[mitm]
port = "9080"
extra_args = "not an array"
lens_source = 1
lens_session_id = false
[unknown]
port = 1234
`,
    );
    expected.ui.port = 5041;
    assert.deepEqual(loadConfig(), expected);
  });

  it("warns and returns defaults for malformed TOML", (t) => {
    const expected = loadConfig();
    const warning = t.mock.method(console, "warn", () => {});
    writeFileSync(getConfigPath(), '[proxy\nport = "unfinished');
    assert.deepEqual(loadConfig(), expected);
    assert.match(
      warning.mock.calls[0].arguments[0],
      /Could not parse config file/,
    );
  });

  it("warns and returns defaults when the config path cannot be read", (t) => {
    const expected = loadConfig();
    const warning = t.mock.method(console, "warn", () => {});
    mkdirSync(getConfigPath());
    assert.deepEqual(loadConfig(), expected);
    assert.equal(warning.mock.callCount(), 1);
  });

  it("returns independent default objects", () => {
    const config = loadConfig();
    config.proxy.port = 1;
    config.mitm.extraArgs.push("changed");
    assert.equal(loadConfig().proxy.port, 4040);
    assert.deepEqual(loadConfig().mitm.extraArgs, []);
  });

  it("emits an example that the upgraded TOML parser accepts", () => {
    assert.doesNotThrow(() => parse(exampleConfig()));
    writeFileSync(getConfigPath(), exampleConfig());
    assert.deepEqual(loadConfig().proxy, {
      port: 4040,
      redact: undefined,
      rehydrate: false,
    });
  });
});
