import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  withoutEgressCredentials,
  withoutMitmAuth,
} from "../src/cli/egress-env.js";
import { buildMitmArgs, buildMitmEnv } from "../src/cli/mitm.js";
import { getMitmConfig } from "../src/cli-utils.js";

describe("mitmproxy egress", () => {
  it("keeps proxy credentials out of argv and scopes them to the MITM environment", () => {
    const proxy = "http://user:p%40ss@localhost:8888";
    const args = buildMitmArgs(getMitmConfig({}), proxy);
    assert.deepEqual(args.slice(-2), [
      "--mode",
      "upstream:http://localhost:8888",
    ]);
    const env = buildMitmEnv({}, proxy);
    assert.equal(env.CONTEXT_LENS_MITM_UPSTREAM_AUTH, "user:p@ss");
    assert.equal(env.CONTEXT_LENS_UPSTREAM_PROXY, undefined);
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

  it("rejects decoded control characters without exposing credentials", () => {
    for (const password of [
      "dummy%00value",
      "dummy%0Avalue",
      "dummy%7Fvalue",
    ]) {
      assert.throws(
        () => buildMitmEnv({}, `http://user:${password}@localhost:8888`),
        {
          message: "Invalid upstream proxy credentials",
        },
      );
    }
  });

  it("removes inherited egress secrets from non-forwarding children", () => {
    const env = withoutEgressCredentials({
      KEEP: "yes",
      CONTEXT_LENS_UPSTREAM_PROXY: "http://user:dummy@localhost:8888",
      CONTEXT_LENS_MITM_UPSTREAM_AUTH: "user:dummy",
      context_lens_upstream_proxy: "http://user:dummy@localhost:8888",
      Context_Lens_Mitm_Upstream_Auth: "user:dummy",
    });
    assert.deepEqual(env, { KEEP: "yes" });
  });
  it("removes MITM auth aliases from the actual proxy environment", () => {
    const env = withoutMitmAuth({
      CONTEXT_LENS_UPSTREAM_PROXY: "http://user:dummy@localhost:8888",
      context_lens_mitm_upstream_auth: "user:dummy",
      Context_Lens_Mitm_Upstream_Auth: "user:dummy",
    });
    assert.deepEqual(env, {
      CONTEXT_LENS_UPSTREAM_PROXY: "http://user:dummy@localhost:8888",
    });
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
