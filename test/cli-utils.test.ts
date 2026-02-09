import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getToolConfig, CLI_CONSTANTS } from '../src/cli-utils.js';

describe('cli-utils', () => {
  it('returns known tool configs', () => {
    const claude = getToolConfig('claude');
    assert.equal(claude.needsMitm, false);
    assert.equal(claude.childEnv.ANTHROPIC_BASE_URL, `${CLI_CONSTANTS.PROXY_URL}/claude`);

    const aider = getToolConfig('aider');
    assert.equal(aider.needsMitm, false);
    assert.equal(aider.childEnv.ANTHROPIC_BASE_URL, `${CLI_CONSTANTS.PROXY_URL}/aider`);
    assert.equal(aider.childEnv.OPENAI_BASE_URL, `${CLI_CONSTANTS.PROXY_URL}/aider`);

    const codex = getToolConfig('codex');
    assert.equal(codex.needsMitm, true);
    assert.equal(codex.childEnv.https_proxy, CLI_CONSTANTS.MITM_PROXY_URL);
    assert.ok(String(codex.childEnv.SSL_CERT_FILE).includes('.mitmproxy'));
  });

  it('falls back for unknown tools', () => {
    const cfg = getToolConfig('mytool');
    assert.equal(cfg.needsMitm, false);
    assert.equal(cfg.childEnv.ANTHROPIC_BASE_URL, `${CLI_CONSTANTS.PROXY_URL}/mytool`);
    assert.equal(cfg.childEnv.OPENAI_BASE_URL, `${CLI_CONSTANTS.PROXY_URL}/mytool`);
  });
});

