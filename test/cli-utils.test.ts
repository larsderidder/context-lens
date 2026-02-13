import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CLI_CONSTANTS,
  formatHelpText,
  getToolConfig,
  parseCliArgs,
  resolveCommandAlias,
} from "../src/cli-utils.js";
import { VERSION } from "../src/version.generated.js";

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

  it("parses global flags, aliases, and command args", () => {
    const parsed = parseCliArgs([
      "--privacy=minimal",
      "--no-open",
      "--no-ui",
      "gm",
      "--model",
      "gemini-2.5-flash",
    ]);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.privacyLevel, "minimal");
    assert.equal(parsed.noOpen, true);
    assert.equal(parsed.noUi, true);
    assert.equal(parsed.commandName, "gemini");
    assert.deepEqual(parsed.commandArguments, ["--model", "gemini-2.5-flash"]);
  });

  it("supports -- separator command mode", () => {
    const parsed = parseCliArgs(["--", "python", "agent.py"]);
    assert.equal(parsed.error, undefined);
    assert.equal(parsed.commandName, "python");
    assert.deepEqual(parsed.commandArguments, ["agent.py"]);
  });

  it("returns parser errors for invalid options", () => {
    const unknownFlag = parseCliArgs(["--wat"]);
    assert.match(unknownFlag.error || "", /Unknown option/);

    const missingPrivacy = parseCliArgs(["--privacy"]);
    assert.match(missingPrivacy.error || "", /Missing value for --privacy/);

    const badPrivacy = parseCliArgs(["--privacy=unsafe"]);
    assert.match(badPrivacy.error || "", /Invalid privacy level/);

    const emptySeparator = parseCliArgs(["--"]);
    assert.match(emptySeparator.error || "", /No command specified after --/);
  });

  it("resolves known aliases and keeps unknown names", () => {
    assert.equal(resolveCommandAlias("cc"), "claude");
    assert.equal(resolveCommandAlias("cpi"), "pi");
    assert.equal(resolveCommandAlias("cx"), "codex");
    assert.equal(resolveCommandAlias("gm"), "gemini");
    assert.equal(resolveCommandAlias("python"), "python");
  });

  it("renders help text with key options", () => {
    const help = formatHelpText();
    assert.match(help, new RegExp(`context-lens v${VERSION}`));
    assert.match(help, /--no-ui/);
    assert.match(help, /--no-update-check/);
    assert.match(help, /context-lens doctor/);
    assert.match(help, /background <start\|stop\|status>/);
    assert.match(help, /cc -> claude/);
    assert.match(help, /cpi -> pi/);
  });
});
