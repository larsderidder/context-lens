import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildMitmArgs } from "../src/cli/mitm.js";
import { getMitmConfig } from "../src/cli-utils.js";

describe("mitmproxy egress", () => {
  it("passes proxy credentials separately from the upstream address", () => {
    const args = buildMitmArgs(
      getMitmConfig({}),
      "http://user:p%40ss@localhost:8888",
    );
    assert.deepEqual(args.slice(-4), [
      "--mode",
      "upstream:http://localhost:8888",
      "--upstream-auth",
      "user:p@ss",
    ]);
  });
  it("keeps regular capture mode without an upstream proxy", () => {
    const args = buildMitmArgs(getMitmConfig({}));
    assert.ok(args.includes("--listen-port"));
    assert.ok(!args.includes("--mode"));
  });

  it("chains HTTP and HTTPS proxies without changing the capture listener", () => {
    for (const proxy of ["http://localhost:8888", "https://localhost:8888"]) {
      const args = buildMitmArgs(getMitmConfig({}), proxy);
      assert.deepEqual(args.slice(-2), ["--mode", `upstream:${proxy}`]);
      assert.ok(args.includes("-s"));
    }
  });

  it("rejects mode overrides instead of allowing a direct listener", () => {
    for (const extraArgs of [
      ["--mode", "regular"],
      ["--mode=regular"],
      ["-mregular"],
      ["--set", "mode=regular"],
      ["--set=mode=regular"],
    ]) {
      assert.throws(
        () =>
          buildMitmArgs(
            { ...getMitmConfig({}), extraArgs },
            "http://localhost:8888",
          ),
        /cannot override/,
      );
    }
  });
});
