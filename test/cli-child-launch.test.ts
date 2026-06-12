import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import { prepareChildLaunch } from "../src/cli/child-launch.js";
import type { ToolConfig } from "../src/types.js";

const reverseProxyTool: ToolConfig = {
  childEnv: {
    ANTHROPIC_BASE_URL: "http://localhost:4040/custom",
  },
  extraArgs: ["--verbose"],
  serverEnv: {},
  needsMitm: false,
};

const mitmTool: ToolConfig = {
  childEnv: {
    SSL_CERT_FILE: "[CA_CERT_PATH]",
  },
  extraArgs: [],
  serverEnv: {},
  needsMitm: true,
};

describe("child launch planning", () => {
  it("injects session tags into reverse proxy env vars", () => {
    const plan = prepareChildLaunch({
      commandName: "custom",
      commandArguments: ["hello"],
      toolConfig: reverseProxyTool,
      useMitm: false,
      sessionTag: "deadbeef",
      baseEnv: {},
      proxyUrl: "http://localhost:4040",
      cwd: "/repo",
      nodeExecPath: "/usr/bin/node",
      certPath: "/cert.pem",
      certExists: () => false,
      fileExists: () => false,
    });

    assert.deepEqual(plan.spawnArgs, ["--verbose", "hello"]);
    assert.equal(
      plan.env.ANTHROPIC_BASE_URL,
      "http://localhost:4040/custom/deadbeef",
    );
    assert.equal(plan.sessionTag, "deadbeef");
  });

  it("fills mitm CA placeholders when the certificate exists", () => {
    const plan = prepareChildLaunch({
      commandName: "codex",
      commandArguments: [],
      toolConfig: mitmTool,
      useMitm: true,
      sessionTag: "deadbeef",
      baseEnv: {},
      proxyUrl: "http://localhost:4040",
      cwd: "/repo",
      nodeExecPath: "/usr/bin/node",
      certPath: "/cert.pem",
      certExists: () => true,
      fileExists: () => false,
      platform: "darwin",
    });

    assert.equal(plan.env.SSL_CERT_FILE, "/cert.pem");
    assert.equal(plan.mitmCertWarningPath, "/cert.pem");
    assert.deepEqual(plan.warnings, []);
  });

  it("uses the local Bryti dist CLI in dev mode", () => {
    const brytiTool: ToolConfig = {
      childEnv: { BRYTI_DATA_DIR: "/tmp/context-lens-bryti-" },
      extraArgs: [],
      serverEnv: {},
      needsMitm: false,
    };
    const plan = prepareChildLaunch({
      commandName: "bryti",
      commandArguments: ["serve"],
      toolConfig: brytiTool,
      useMitm: false,
      sessionTag: "deadbeef",
      baseEnv: {},
      proxyUrl: "http://localhost:4040",
      cwd: "/repo",
      nodeExecPath: "/usr/bin/node",
      certPath: "/cert.pem",
      certExists: () => false,
      fileExists: (candidate) =>
        candidate === path.join("/repo", "dist", "cli.js"),
      prepareBrytiDataDir: () => "/tmp/bryti-prepared",
    });

    assert.equal(plan.spawnCommand, "/usr/bin/node");
    assert.deepEqual(plan.spawnArgs, [
      path.join("/repo", "dist", "cli.js"),
      "serve",
    ]);
    assert.equal(plan.env.BRYTI_DATA_DIR, "/tmp/bryti-prepared");
    assert.equal(plan.brytiDataDirToCleanup, "/tmp/bryti-prepared");
  });
});
