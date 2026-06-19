import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  addProvidersBasedOnAuthJson,
  addProvidersBasedOnEnvVars,
  CLI_CONSTANTS,
  formatHelpText,
  getMitmConfig,
  getToolConfig,
  injectSessionTagIntoProxyEnv,
  parseCliArgs,
  resolveCommandAlias,
  resolveLensSessionId,
  resolveLensSource,
  toMitmToolConfig,
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
    assert.deepEqual(codex.childEnv, {});
    assert.deepEqual(codex.extraArgs, []);

    const pi = getToolConfig("pi");
    assert.equal(pi.needsMitm, false);
    assert.equal(
      pi.childEnv.PI_CODING_AGENT_DIR,
      CLI_CONSTANTS.PI_AGENT_DIR_PREFIX,
    );
    assert.equal(
      CLI_CONSTANTS.PI_AGENT_DIR_PREFIX,
      path.join(tmpdir(), "context-lens-pi-agent-"),
    );

    const bryti = getToolConfig("bryti");
    assert.equal(
      bryti.childEnv.BRYTI_DATA_DIR,
      path.join(tmpdir(), "context-lens-bryti-"),
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
    assert.equal(resolveCommandAlias("cx"), "codex");
    assert.equal(resolveCommandAlias("gm"), "gemini");
    assert.equal(resolveCommandAlias("python"), "python");
  });

  it("renders compact help with only common global options", () => {
    const help = formatHelpText();
    assert.match(help, new RegExp(`context-lens v${VERSION}`));
    assert.match(help, /--no-ui/);
    assert.match(help, /--mitm/);
    assert.match(help, /context-lens doctor/);
    assert.match(help, /background <start\|stop\|status>/);
    assert.match(help, /cc -> claude/);

    assert.doesNotMatch(help, /--no-update-check/);
    assert.doesNotMatch(help, /--privacy/);
    assert.doesNotMatch(help, /--redact/);
    assert.doesNotMatch(help, /--rehydrate/);
    assert.doesNotMatch(help, /alias cpi/);
  });

  it("returns default mitm config", () => {
    const mitm = getMitmConfig();
    assert.equal(mitm.port, 8080);
    assert.equal(mitm.proxyUrl, "http://localhost:8080");
    assert.deepEqual(mitm.extraArgs, []);
    assert.equal(mitm.lensSource, "commandName");
    assert.equal(mitm.lensSessionId, "random");
    assert.ok(mitm.addonPath.endsWith("mitm_addon.py"));
  });

  it("addProvidersBasedOnAuthJson", () => {
    const sampleAuthConfig = { foo: {}, bar: {} };
    const proxyBaseUrl = "localhost";
    const providers = {};
    addProvidersBasedOnAuthJson(sampleAuthConfig, proxyBaseUrl, providers);
    const expectedProvidersValue = {
      foo: { baseUrl: proxyBaseUrl },
      bar: { baseUrl: proxyBaseUrl },
    };
    assert.deepEqual(providers, expectedProvidersValue);
  });

  it("addProvidersBasedOnEnvVars", () => {
    const sampleEnvVars = { FOO: "FOO", OPENROUTER_API_KEY: "BAR" };
    const proxyBaseUrl = "localhost";
    const providers = {};
    addProvidersBasedOnEnvVars(sampleEnvVars, proxyBaseUrl, providers);
    const expectedProvidersValue = {
      openrouter: { baseUrl: proxyBaseUrl },
    };
    assert.deepEqual(providers, expectedProvidersValue);
  });

  it("resolves mitm lens source and session id settings", () => {
    assert.equal(resolveLensSource("commandName", "codex"), "codex");
    assert.equal(resolveLensSource("auto", "codex"), "");
    assert.equal(resolveLensSource("fixed-source", "codex"), "fixed-source");

    assert.equal(
      resolveLensSessionId("none", () => "abcd1234"),
      "",
    );
    assert.equal(
      resolveLensSessionId("fixed-session", () => "abcd1234"),
      "fixed-session",
    );
    assert.equal(
      resolveLensSessionId("random", () => "abcd1234"),
      "abcd1234",
    );
  });

  it("converts reverse-proxy tool config to mitm proxy config", () => {
    const mitm = toMitmToolConfig(getToolConfig("claude"), getMitmConfig());

    assert.equal(mitm.needsMitm, true);
    assert.deepEqual(mitm.extraArgs, []);
    assert.deepEqual(mitm.serverEnv, {});
    assert.equal(mitm.childEnv.https_proxy, "http://localhost:8080");
    assert.equal(mitm.childEnv.NPM_CONFIG_HTTPS_PROXY, "http://localhost:8080");
    assert.equal(mitm.childEnv.WSS_PROXY, "http://localhost:8080");
    assert.equal(mitm.childEnv.NODE_USE_ENV_PROXY, "1");
    assert.equal(mitm.childEnv.SSL_CERT_FILE, "[CA_CERT_PATH]");
    assert.equal(mitm.childEnv.NODE_EXTRA_CA_CERTS, "[CA_CERT_PATH]");
    assert.equal(mitm.childEnv.REQUESTS_CA_BUNDLE, "[CA_CERT_PATH]");
  });

  it("injects session tags only into plain proxy source URLs", () => {
    const childEnv = injectSessionTagIntoProxyEnv(
      {
        ANTHROPIC_BASE_URL: `${CLI_CONSTANTS.PROXY_URL}/claude`,
        GOOGLE_GEMINI_BASE_URL: `${CLI_CONSTANTS.PROXY_URL}/gemini/`,
        ALREADY_TAGGED: `${CLI_CONSTANTS.PROXY_URL}/aider/existing`,
        OTHER_URL: "https://api.example.com/v1",
      },
      "deadbeef",
    );

    assert.equal(
      childEnv.ANTHROPIC_BASE_URL,
      `${CLI_CONSTANTS.PROXY_URL}/claude/deadbeef`,
    );
    assert.equal(
      childEnv.GOOGLE_GEMINI_BASE_URL,
      `${CLI_CONSTANTS.PROXY_URL}/gemini/deadbeef/`,
    );
    assert.equal(
      childEnv.ALREADY_TAGGED,
      `${CLI_CONSTANTS.PROXY_URL}/aider/existing`,
    );
    assert.equal(childEnv.OTHER_URL, "https://api.example.com/v1");
  });
});
