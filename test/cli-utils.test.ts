import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CLI_CONSTANTS, getToolConfig } from "../src/cli-utils.js";

describe("cli-utils", () => {
  it("returns known tool configs", () => {
    const claude = getToolConfig("claude");
    assert.equal(claude.needsMitm, false);
    assert.equal(
      claude.childEnv.ANTHROPIC_BASE_URL,
      `${CLI_CONSTANTS.PROXY_URL}/claude`,
    );

    const aider = getToolConfig("aider");
    assert.equal(aider.needsMitm, false);
    assert.equal(
      aider.childEnv.ANTHROPIC_BASE_URL,
      `${CLI_CONSTANTS.PROXY_URL}/aider`,
    );
    assert.equal(
      aider.childEnv.OPENAI_BASE_URL,
      `${CLI_CONSTANTS.PROXY_URL}/aider`,
    );

    const codex = getToolConfig("codex");
    assert.equal(codex.needsMitm, true);
    assert.equal(codex.childEnv.https_proxy, CLI_CONSTANTS.MITM_PROXY_URL);
    assert.ok(String(codex.childEnv.SSL_CERT_FILE).includes(".mitmproxy"));

    const pi = getToolConfig("pi");
    assert.equal(pi.needsMitm, false);
    assert.equal(
      pi.childEnv.PI_CODING_AGENT_DIR,
      CLI_CONSTANTS.PI_AGENT_DIR_PREFIX,
    );
  });

  it("falls back for unknown tools", () => {
    const cfg = getToolConfig("mytool");
    assert.equal(cfg.needsMitm, false);
    assert.equal(
      cfg.childEnv.ANTHROPIC_BASE_URL,
      `${CLI_CONSTANTS.PROXY_URL}/mytool`,
    );
    assert.equal(
      cfg.childEnv.OPENAI_BASE_URL,
      `${CLI_CONSTANTS.PROXY_URL}/mytool`,
    );
  });
});
