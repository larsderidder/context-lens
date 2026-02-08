import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  estimateTokens, detectProvider, detectApiFormat,
  parseContextInfo, getContextLimit, extractSource, resolveTargetUrl,
  extractReadableText, extractWorkingDirectory, extractUserPrompt, extractSessionId,
  computeAgentKey, computeFingerprint, extractConversationLabel, detectSource,
  CONTEXT_LIMITS, SOURCE_SIGNATURES, API_PATH_SEGMENTS,
} from '../src/core.js';

// Load fixtures via readFileSync (avoids JSON import attribute complexity)
const fixturesDir = join(process.cwd(), 'test', 'fixtures');
const anthropicBasic = JSON.parse(readFileSync(join(fixturesDir, 'anthropic-basic.json'), 'utf-8'));
const codexResponses = JSON.parse(readFileSync(join(fixturesDir, 'codex-responses.json'), 'utf-8'));
const claudeSession = JSON.parse(readFileSync(join(fixturesDir, 'claude-session.json'), 'utf-8'));
const openaiChat = JSON.parse(readFileSync(join(fixturesDir, 'openai-chat.json'), 'utf-8'));

// --- estimateTokens ---

describe('estimateTokens', () => {
  it('estimates string tokens as chars/4', () => {
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('abcde'), 2); // ceil(5/4)
    assert.equal(estimateTokens('hello world!'), 3); // ceil(12/4)
  });

  it('returns 0 for null/undefined/empty', () => {
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
    assert.equal(estimateTokens(''), 0);
  });

  it('stringifies objects before counting', () => {
    const obj = { key: 'value' };
    const expected = Math.ceil(JSON.stringify(obj).length / 4);
    assert.equal(estimateTokens(obj), expected);
  });
});

// --- detectProvider ---

describe('detectProvider', () => {
  it('detects anthropic from /v1/messages path', () => {
    assert.equal(detectProvider('/v1/messages', {}), 'anthropic');
  });

  it('detects anthropic from /v1/complete path', () => {
    assert.equal(detectProvider('/v1/complete', {}), 'anthropic');
  });

  it('detects anthropic from anthropic-version header', () => {
    assert.equal(detectProvider('/some/path', { 'anthropic-version': '2024-01-01' }), 'anthropic');
  });

  it('detects openai from /responses path', () => {
    assert.equal(detectProvider('/responses', {}), 'openai');
  });

  it('detects openai from /chat/completions path', () => {
    assert.equal(detectProvider('/chat/completions', {}), 'openai');
  });

  it('detects openai from Bearer sk- header', () => {
    assert.equal(detectProvider('/anything', { authorization: 'Bearer sk-abc123' }), 'openai');
  });

  it('detects chatgpt from /backend-api/ path', () => {
    assert.equal(detectProvider('/backend-api/codex/responses', {}), 'chatgpt');
  });

  it('detects chatgpt from /api/ path', () => {
    assert.equal(detectProvider('/api/codex/responses', {}), 'chatgpt');
  });

  it('returns unknown for unrecognized paths', () => {
    assert.equal(detectProvider('/unknown/path', {}), 'unknown');
  });
});

// --- detectApiFormat ---

describe('detectApiFormat', () => {
  it('detects anthropic-messages', () => {
    assert.equal(detectApiFormat('/v1/messages'), 'anthropic-messages');
  });

  it('detects chatgpt-backend', () => {
    assert.equal(detectApiFormat('/backend-api/codex/responses'), 'chatgpt-backend');
    assert.equal(detectApiFormat('/api/codex/responses'), 'chatgpt-backend');
  });

  it('detects responses API', () => {
    assert.equal(detectApiFormat('/responses'), 'responses');
  });

  it('detects chat-completions', () => {
    assert.equal(detectApiFormat('/chat/completions'), 'chat-completions');
  });

  it('returns unknown for unrecognized paths', () => {
    assert.equal(detectApiFormat('/v1/models'), 'unknown');
  });
});

// --- extractSource ---

describe('extractSource', () => {
  it('extracts source prefix from path', () => {
    const result = extractSource('/claude/v1/messages');
    assert.equal(result.source, 'claude');
    assert.equal(result.cleanPath, '/v1/messages');
  });

  it('extracts custom source prefix', () => {
    const result = extractSource('/my-tool/responses');
    assert.equal(result.source, 'my-tool');
    assert.equal(result.cleanPath, '/responses');
  });

  it('does not treat API path segments as source', () => {
    for (const seg of ['v1', 'responses', 'chat', 'models', 'embeddings', 'backend-api', 'api']) {
      const result = extractSource(`/${seg}/something`);
      assert.equal(result.source, null, `should not treat /${seg} as source`);
      assert.equal(result.cleanPath, `/${seg}/something`);
    }
  });

  it('returns null source for paths with no prefix', () => {
    const result = extractSource('/v1/messages');
    assert.equal(result.source, null);
    assert.equal(result.cleanPath, '/v1/messages');
  });

  it('returns null source for single-segment paths', () => {
    const result = extractSource('/responses');
    assert.equal(result.source, null);
    assert.equal(result.cleanPath, '/responses');
  });

  it('decodes URI-encoded source', () => {
    const result = extractSource('/my%20tool/v1/messages');
    assert.equal(result.source, 'my tool');
  });
});

// --- parseContextInfo ---

describe('parseContextInfo', () => {
  describe('anthropic format', () => {
    it('parses system prompt, tools, and messages', () => {
      const info = parseContextInfo('anthropic', anthropicBasic, 'anthropic-messages');
      assert.equal(info.provider, 'anthropic');
      assert.equal(info.model, 'claude-sonnet-4-20250514');
      assert.equal(info.systemPrompts.length, 1);
      assert.ok(info.systemPrompts[0].content.includes('helpful assistant'));
      assert.equal(info.tools.length, 1);
      assert.equal((info.tools[0] as any).name, 'get_weather');
      assert.equal(info.messages.length, 3);
      assert.equal(info.messages[0].role, 'user');
      assert.ok(info.systemTokens > 0);
      assert.ok(info.toolsTokens > 0);
      assert.ok(info.messagesTokens > 0);
      assert.equal(info.totalTokens, info.systemTokens + info.toolsTokens + info.messagesTokens);
    });

    it('preserves content blocks for array content', () => {
      const info = parseContextInfo('anthropic', claudeSession, 'anthropic-messages');
      // First user message has array content
      assert.ok(info.messages[0].contentBlocks);
      assert.equal(info.messages[0].contentBlocks!.length, 2);
      // Assistant message has array content with tool_use
      assert.ok(info.messages[1].contentBlocks);
    });

    it('handles missing optional fields', () => {
      const info = parseContextInfo('anthropic', { model: 'claude-3', messages: [] }, 'anthropic-messages');
      assert.equal(info.systemPrompts.length, 0);
      assert.equal(info.tools.length, 0);
      assert.equal(info.messages.length, 0);
      assert.equal(info.totalTokens, 0);
    });
  });

  describe('responses API format', () => {
    it('parses instructions, input array, and tools', () => {
      const info = parseContextInfo('openai', codexResponses, 'responses');
      assert.equal(info.systemPrompts.length, 1);
      assert.ok(info.systemPrompts[0].content.includes('coding assistant'));
      assert.ok(info.messages.length >= 4); // user + assistant messages from input
      assert.equal(info.tools.length, 1);
    });

    it('handles string input', () => {
      const body = { model: 'gpt-4o', input: 'Hello world' };
      const info = parseContextInfo('openai', body, 'responses');
      assert.equal(info.messages.length, 1);
      assert.equal(info.messages[0].content, 'Hello world');
    });

    it('separates system messages from input array', () => {
      const body = {
        model: 'gpt-4o',
        input: [
          { role: 'system', content: 'Be helpful' },
          { role: 'user', content: 'Hi' },
        ],
      };
      const info = parseContextInfo('openai', body, 'responses');
      assert.equal(info.systemPrompts.length, 1);
      assert.equal(info.messages.length, 1);
    });
  });

  describe('openai chat completions', () => {
    it('separates system/developer messages from user/assistant', () => {
      const info = parseContextInfo('openai', openaiChat, 'chat-completions');
      assert.equal(info.systemPrompts.length, 1);
      assert.ok(info.systemPrompts[0].content.includes('expert software developer'));
      // user + assistant + user = 3 non-system messages
      assert.equal(info.messages.length, 3);
      assert.equal(info.tools.length, 1);
    });

    it('handles developer role as system', () => {
      const body = {
        model: 'gpt-4o',
        messages: [
          { role: 'developer', content: 'System instruction' },
          { role: 'user', content: 'Hi' },
        ],
      };
      const info = parseContextInfo('openai', body, 'chat-completions');
      assert.equal(info.systemPrompts.length, 1);
      assert.equal(info.systemPrompts[0].content, 'System instruction');
    });

    it('handles legacy functions field', () => {
      const body = {
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: 'Hi' }],
        functions: [{ name: 'search', description: 'Search the web' }],
      };
      const info = parseContextInfo('openai', body, 'chat-completions');
      assert.equal(info.tools.length, 1);
      assert.equal((info.tools[0] as any).name, 'search');
    });
  });

  describe('chatgpt backend', () => {
    it('parses instructions and input array', () => {
      const body = {
        model: 'gpt-4o',
        instructions: 'Be a coder',
        input: [
          { role: 'user', content: 'Fix the bug' },
        ],
      };
      const info = parseContextInfo('chatgpt', body, 'chatgpt-backend');
      assert.equal(info.systemPrompts.length, 1);
      assert.equal(info.messages.length, 1);
    });

    it('handles both instructions and system fields', () => {
      const body = {
        model: 'gpt-4o',
        instructions: 'Instruction 1',
        system: 'System 2',
        input: [{ role: 'user', content: 'Hi' }],
      };
      const info = parseContextInfo('chatgpt', body, 'chatgpt-backend');
      assert.equal(info.systemPrompts.length, 2);
    });
  });

  describe('empty body', () => {
    it('returns zeroed info for empty body', () => {
      const info = parseContextInfo('unknown', {}, 'unknown');
      assert.equal(info.model, 'unknown');
      assert.equal(info.totalTokens, 0);
      assert.equal(info.messages.length, 0);
    });
  });
});

// --- getContextLimit ---

describe('getContextLimit', () => {
  it('returns correct limit for exact model names', () => {
    assert.equal(getContextLimit('claude-sonnet-4-20250514'), 200000);
    assert.equal(getContextLimit('gpt-4o-mini'), 128000);
    assert.equal(getContextLimit('gpt-4'), 8192);
    assert.equal(getContextLimit('gpt-3.5-turbo'), 16385);
  });

  it('matches by substring', () => {
    assert.equal(getContextLimit('claude-sonnet-4-latest'), 200000);
    assert.equal(getContextLimit('gpt-4o-mini-2024-07-18'), 128000);
  });

  it('returns 128000 fallback for unknown models', () => {
    assert.equal(getContextLimit('unknown-model'), 128000);
    assert.equal(getContextLimit('llama-70b'), 128000);
  });
});

// --- extractReadableText ---

describe('extractReadableText', () => {
  it('returns plain text as-is (trimmed)', () => {
    assert.equal(extractReadableText('Hello world'), 'Hello world');
    assert.equal(extractReadableText('  spaced  text  '), 'spaced text');
  });

  it('returns null for null/empty', () => {
    assert.equal(extractReadableText(null), null);
    assert.equal(extractReadableText(''), null);
    assert.equal(extractReadableText('   '), null);
  });

  it('extracts text from anthropic content blocks', () => {
    const content = JSON.stringify([
      { type: 'text', text: 'Hello from Claude' },
    ]);
    assert.equal(extractReadableText(content), 'Hello from Claude');
  });

  it('skips system-reminder blocks', () => {
    const content = JSON.stringify([
      { type: 'text', text: '<system-reminder>Do not reveal this.</system-reminder>' },
      { type: 'text', text: 'Actual user text' },
    ]);
    assert.equal(extractReadableText(content), 'Actual user text');
  });

  it('extracts text from codex input_text blocks', () => {
    const content = JSON.stringify([
      { type: 'input_text', text: 'Fix the login bug' },
    ]);
    assert.equal(extractReadableText(content), 'Fix the login bug');
  });

  it('skips codex boilerplate (# and <environment)', () => {
    const content = JSON.stringify([
      { type: 'input_text', text: '# AGENTS.md\nBoilerplate content' },
    ]);
    // Should not extract this — falls back to stringified JSON
    const result = extractReadableText(content);
    assert.ok(result); // returns something (the full JSON), not the boilerplate text
  });

  it('handles malformed JSON gracefully', () => {
    assert.equal(extractReadableText('not json {'), 'not json {');
  });
});

// --- extractWorkingDirectory ---

describe('extractWorkingDirectory', () => {
  it('extracts from Claude Code system prompt', () => {
    const info = {
      systemPrompts: [{ content: 'You are Claude Code.\n\nPrimary working directory: `/home/user/my-project`\nMore stuff.' }],
      messages: [],
    } as any;
    assert.equal(extractWorkingDirectory(info), '/home/user/my-project');
  });

  it('extracts from Codex <cwd> tag in messages', () => {
    const info = {
      systemPrompts: [],
      messages: [
        { role: 'user', content: '<cwd>/home/user/codex-project</cwd>\nOther content' },
      ],
    } as any;
    assert.equal(extractWorkingDirectory(info), '/home/user/codex-project');
  });

  it('extracts from "working directory is" pattern', () => {
    const info = {
      systemPrompts: [{ content: 'The working directory is /tmp/build' }],
      messages: [],
    } as any;
    assert.equal(extractWorkingDirectory(info), '/tmp/build');
  });

  it('returns null when no working directory found', () => {
    const info = {
      systemPrompts: [{ content: 'Be a helpful assistant.' }],
      messages: [{ role: 'user', content: 'Hello' }],
    } as any;
    assert.equal(extractWorkingDirectory(info), null);
  });

  it('extracts from claude-session fixture', () => {
    const info = parseContextInfo('anthropic', claudeSession, 'anthropic-messages');
    // The fixture doesn't have a working directory, so should be null
    assert.equal(extractWorkingDirectory(info), null);
  });
});

// --- extractUserPrompt ---

describe('extractUserPrompt', () => {
  it('skips AGENTS.md and environment boilerplate', () => {
    const messages = [
      { role: 'user', content: JSON.stringify([{ type: 'input_text', text: '# AGENTS.md\nStuff' }]), tokens: 0 },
      { role: 'user', content: JSON.stringify([{ type: 'input_text', text: '<environment_context>\nOS: Linux' }]), tokens: 0 },
      { role: 'user', content: JSON.stringify([{ type: 'input_text', text: 'Fix the login bug' }]), tokens: 0 },
    ];
    const result = extractUserPrompt(messages);
    assert.ok(result);
    assert.ok(result.includes('Fix the login bug'));
  });

  it('returns null when only boilerplate exists', () => {
    const messages = [
      { role: 'user', content: JSON.stringify([{ type: 'input_text', text: '# AGENTS.md' }]), tokens: 0 },
    ];
    assert.equal(extractUserPrompt(messages), null);
  });

  it('skips non-user messages', () => {
    const messages = [
      { role: 'assistant', content: JSON.stringify([{ type: 'input_text', text: 'Real text' }]), tokens: 0 },
      { role: 'user', content: JSON.stringify([{ type: 'input_text', text: 'User prompt' }]), tokens: 0 },
    ];
    const result = extractUserPrompt(messages);
    assert.ok(result!.includes('User prompt'));
  });

  it('returns null for non-input_text messages', () => {
    const messages = [
      { role: 'user', content: 'plain text, not JSON wrapped', tokens: 0 },
    ];
    assert.equal(extractUserPrompt(messages), null);
  });
});

// --- extractSessionId ---

describe('extractSessionId', () => {
  it('extracts session ID from metadata.user_id', () => {
    const raw = { metadata: { user_id: 'user_abc_session_550e8400-e29b-41d4-a716-446655440000' } };
    assert.equal(extractSessionId(raw), 'session_550e8400-e29b-41d4-a716-446655440000');
  });

  it('returns null when no session in user_id', () => {
    assert.equal(extractSessionId({ metadata: { user_id: 'user_abc123' } }), null);
  });

  it('returns null when no metadata', () => {
    assert.equal(extractSessionId({}), null);
    assert.equal(extractSessionId(null), null);
  });
});

// --- computeFingerprint ---

describe('computeFingerprint', () => {
  it('uses session ID when available', () => {
    const info = parseContextInfo('anthropic', claudeSession, 'anthropic-messages');
    const fp = computeFingerprint(info, claudeSession, new Map());
    assert.ok(fp);
    assert.equal(fp!.length, 16);
  });

  it('produces same fingerprint for same session', () => {
    const info1 = parseContextInfo('anthropic', claudeSession, 'anthropic-messages');
    const info2 = parseContextInfo('anthropic', claudeSession, 'anthropic-messages');
    const fp1 = computeFingerprint(info1, claudeSession, new Map());
    const fp2 = computeFingerprint(info2, claudeSession, new Map());
    assert.equal(fp1, fp2);
  });

  it('uses response ID chaining when available', () => {
    const map = new Map<string, string>();
    map.set('resp_123', 'existing-convo-fp');
    const body = { previous_response_id: 'resp_123', model: 'gpt-4o', input: 'test' };
    const info = parseContextInfo('openai', body, 'responses');
    const fp = computeFingerprint(info, body, map);
    assert.equal(fp, 'existing-convo-fp');
  });

  it('skips codex boilerplate for fingerprint', () => {
    const info = parseContextInfo('openai', codexResponses, 'responses');
    const fp = computeFingerprint(info, codexResponses, new Map());
    assert.ok(fp);
    assert.equal(fp!.length, 16);
  });

  it('produces content-based fingerprint for simple messages', () => {
    const body = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Be helpful' },
        { role: 'user', content: 'Hello' },
      ],
    };
    const info = parseContextInfo('openai', body, 'chat-completions');
    const fp = computeFingerprint(info, body, new Map());
    assert.ok(fp);
    assert.equal(fp!.length, 16);
  });

  it('same content produces same fingerprint', () => {
    const body = {
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: 'Be helpful' },
        { role: 'user', content: 'Hello' },
      ],
    };
    const info1 = parseContextInfo('openai', body, 'chat-completions');
    const info2 = parseContextInfo('openai', body, 'chat-completions');
    assert.equal(
      computeFingerprint(info1, body, new Map()),
      computeFingerprint(info2, body, new Map())
    );
  });

  it('different content produces different fingerprint', () => {
    const body1 = { model: 'gpt-4o', messages: [{ role: 'user', content: 'Hello' }] };
    const body2 = { model: 'gpt-4o', messages: [{ role: 'user', content: 'Goodbye' }] };
    const info1 = parseContextInfo('openai', body1, 'chat-completions');
    const info2 = parseContextInfo('openai', body2, 'chat-completions');
    assert.notEqual(
      computeFingerprint(info1, body1, new Map()),
      computeFingerprint(info2, body2, new Map())
    );
  });

  it('returns null when no content to fingerprint', () => {
    const info = parseContextInfo('unknown', {}, 'unknown');
    assert.equal(computeFingerprint(info, {}, new Map()), null);
  });
});

// --- computeAgentKey ---

describe('computeAgentKey', () => {
  it('computes hash from first readable user text', () => {
    const info = parseContextInfo('anthropic', anthropicBasic, 'anthropic-messages');
    const key = computeAgentKey(info);
    assert.ok(key);
    assert.equal(key!.length, 12);
  });

  it('returns same key for same first user message', () => {
    const info1 = parseContextInfo('anthropic', anthropicBasic, 'anthropic-messages');
    const info2 = parseContextInfo('anthropic', anthropicBasic, 'anthropic-messages');
    assert.equal(computeAgentKey(info1), computeAgentKey(info2));
  });

  it('returns null when no user messages', () => {
    const info = parseContextInfo('unknown', {}, 'unknown');
    assert.equal(computeAgentKey(info), null);
  });
});

// --- extractConversationLabel ---

describe('extractConversationLabel', () => {
  it('extracts label from first user message', () => {
    const info = parseContextInfo('anthropic', anthropicBasic, 'anthropic-messages');
    const label = extractConversationLabel(info);
    assert.ok(label.includes('weather'));
  });

  it('skips codex boilerplate and finds real prompt', () => {
    const info = parseContextInfo('openai', codexResponses, 'responses');
    const label = extractConversationLabel(info);
    assert.ok(label.includes('login bug'));
  });

  it('truncates long labels to 80 chars', () => {
    const longMsg = 'a'.repeat(200);
    const body = { model: 'gpt-4o', messages: [{ role: 'user', content: longMsg }] };
    const info = parseContextInfo('openai', body, 'chat-completions');
    const label = extractConversationLabel(info);
    assert.ok(label.length <= 80);
    assert.ok(label.endsWith('...'));
  });

  it('returns "Unnamed conversation" for no messages', () => {
    const info = parseContextInfo('unknown', {}, 'unknown');
    assert.equal(extractConversationLabel(info), 'Unnamed conversation');
  });
});

// --- detectSource ---

describe('detectSource', () => {
  it('returns existing source if already tagged', () => {
    const info = parseContextInfo('anthropic', anthropicBasic, 'anthropic-messages');
    assert.equal(detectSource(info, 'my-tool'), 'my-tool');
  });

  it('detects aider from system prompt', () => {
    const info = parseContextInfo('openai', openaiChat, 'chat-completions');
    const source = detectSource(info, null);
    assert.equal(source, 'aider');
  });

  it('detects claude from system prompt', () => {
    const info = parseContextInfo('anthropic', claudeSession, 'anthropic-messages');
    const source = detectSource(info, null);
    assert.equal(source, 'claude');
  });

  it('passes through "unknown" source to allow auto-detection', () => {
    const info = parseContextInfo('openai', openaiChat, 'chat-completions');
    const source = detectSource(info, 'unknown');
    assert.equal(source, 'aider'); // auto-detected from system prompt
  });

  it('returns "unknown" when no signature matches', () => {
    const info = parseContextInfo('anthropic', anthropicBasic, 'anthropic-messages');
    const source = detectSource(info, null);
    assert.equal(source, 'unknown');
  });
});

// --- resolveTargetUrl ---

describe('resolveTargetUrl', () => {
  const upstreams = {
    openai: 'https://api.openai.com/v1',
    anthropic: 'https://api.anthropic.com',
    chatgpt: 'https://chatgpt.com',
  };

  it('routes anthropic paths to anthropic upstream', () => {
    const result = resolveTargetUrl({ pathname: '/v1/messages' }, {}, upstreams);
    assert.equal(result.targetUrl, 'https://api.anthropic.com/v1/messages');
    assert.equal(result.provider, 'anthropic');
  });

  it('routes openai paths to openai upstream', () => {
    const result = resolveTargetUrl({ pathname: '/responses' }, {}, upstreams);
    assert.equal(result.targetUrl, 'https://api.openai.com/v1/responses');
    assert.equal(result.provider, 'openai');
  });

  it('routes chatgpt paths to chatgpt upstream', () => {
    const result = resolveTargetUrl({ pathname: '/backend-api/codex/responses' }, {}, upstreams);
    assert.equal(result.targetUrl, 'https://chatgpt.com/backend-api/codex/responses');
    assert.equal(result.provider, 'chatgpt');
  });

  it('uses x-target-url header when provided', () => {
    const headers = { 'x-target-url': 'https://custom.api.com/v1/messages' };
    const result = resolveTargetUrl({ pathname: '/v1/messages' }, headers, upstreams);
    assert.equal(result.targetUrl, 'https://custom.api.com/v1/messages');
  });

  it('preserves query string in target URL', () => {
    const result = resolveTargetUrl({ pathname: '/v1/messages', search: '?beta=true' }, {}, upstreams);
    assert.equal(result.targetUrl, 'https://api.anthropic.com/v1/messages?beta=true');
  });

  it('handles missing query string gracefully', () => {
    const result = resolveTargetUrl({ pathname: '/v1/messages', search: null }, {}, upstreams);
    assert.equal(result.targetUrl, 'https://api.anthropic.com/v1/messages');
  });
});
