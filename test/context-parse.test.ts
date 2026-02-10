import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseContextInfo } from '../src/core.js';
import { anthropicBasic, codexResponses, claudeSession, openaiChat } from './helpers/fixtures.js';

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

