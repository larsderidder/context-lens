import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectProvider, detectApiFormat, parseContextInfo, estimateCost, resolveTargetUrl
} from '../src/core.js';

describe('Gemini support', () => {
  describe('detectProvider', () => {
    it('detects gemini from :generateContent path', () => {
      assert.equal(detectProvider('/v1beta/models/gemini-pro:generateContent', {}), 'gemini');
    });

    it('detects gemini from :streamGenerateContent path', () => {
      assert.equal(detectProvider('/v1beta/models/gemini-pro:streamGenerateContent', {}), 'gemini');
    });

    it('detects gemini from /v1beta/models/ path', () => {
      assert.equal(detectProvider('/v1beta/models/gemini-1.5-flash', {}), 'gemini');
    });

    it('detects gemini from /v1internal: path (Code Assist)', () => {
      assert.equal(detectProvider('/v1internal:predict', {}), 'gemini');
    });

    it('detects gemini from x-goog-api-key header', () => {
      assert.equal(detectProvider('/any/path', { 'x-goog-api-key': 'abc' }), 'gemini');
    });
  });

  describe('detectApiFormat', () => {
    it('detects gemini format for various paths', () => {
      assert.equal(detectApiFormat('/v1beta/models/gemini-pro:generateContent'), 'gemini');
      assert.equal(detectApiFormat('/v1internal:predict'), 'gemini');
    });
  });

  describe('parseContextInfo (Gemini)', () => {
    it('parses basic gemini request', () => {
      const body = {
        contents: [
          {
            role: 'user',
            parts: [{ text: 'Hello Gemini' }]
          }
        ],
        systemInstruction: {
          parts: [{ text: 'You are a helpful assistant' }]
        },
        tools: [
          {
            functionDeclarations: [
              {
                name: 'get_weather',
                parameters: { type: 'object', properties: { location: { type: 'string' } } }
              }
            ]
          }
        ]
      };
      const info = parseContextInfo('gemini', body, 'gemini');
      assert.equal(info.provider, 'gemini');
      assert.equal(info.systemPrompts.length, 1);
      assert.equal(info.systemPrompts[0].content, 'You are a helpful assistant');
      assert.equal(info.messages.length, 1);
      assert.equal(info.messages[0].role, 'user');
      assert.equal(info.messages[0].content, 'Hello Gemini');
      assert.equal(info.tools.length, 1);
      assert.equal((info.tools[0] as any).name, 'get_weather');
    });

    it('parses gemini request with multiple parts', () => {
      const body = {
        contents: [
          {
            role: 'user',
            parts: [
              { text: 'Part 1' },
              { text: 'Part 2' }
            ]
          }
        ]
      };
      const info = parseContextInfo('gemini', body, 'gemini');
      assert.equal(info.messages[0].content, 'Part 1\nPart 2');
      assert.equal(info.messages[0].contentBlocks?.length, 2);
    });

    it('handles Gemini Code Assist wrapped request', () => {
      const body = {
        request: {
          contents: [{ parts: [{ text: 'Code assist request' }] }]
        }
      };
      const info = parseContextInfo('gemini', body, 'gemini');
      assert.equal(info.messages.length, 1);
      assert.equal(info.messages[0].content, 'Code assist request');
    });

    it('unwraps functionResponse output wrapper', () => {
      const body = {
        contents: [
          {
            role: 'model',
            parts: [{ functionCall: { id: 'call-1', name: 'run_shell_command', args: { command: 'ls' } } }]
          },
          {
            role: 'user',
            parts: [{ functionResponse: { id: 'call-1', name: 'run_shell_command', response: { output: 'file1.txt\nfile2.txt' } } }]
          },
        ]
      };
      const info = parseContextInfo('gemini', body, 'gemini');
      assert.equal(info.messages.length, 2);
      // tool_use should have the id and name
      const toolUse = info.messages[0].contentBlocks?.[0] as any;
      assert.equal(toolUse.type, 'tool_use');
      assert.equal(toolUse.id, 'call-1');
      assert.equal(toolUse.name, 'run_shell_command');
      // tool_result should unwrap {output: "..."} to just the text
      const toolResult = info.messages[1].contentBlocks?.[0] as any;
      assert.equal(toolResult.type, 'tool_result');
      assert.equal(toolResult.tool_use_id, 'call-1');
      assert.equal(toolResult.content, 'file1.txt\nfile2.txt');
    });

    it('unwraps functionResponse error wrapper', () => {
      const body = {
        contents: [
          {
            role: 'user',
            parts: [{ functionResponse: { id: 'call-2', name: 'read_file', response: { error: 'File not found' } } }]
          },
        ]
      };
      const info = parseContextInfo('gemini', body, 'gemini');
      const toolResult = info.messages[0].contentBlocks?.[0] as any;
      assert.equal(toolResult.content, 'File not found');
    });
  });

  describe('estimateCost (Gemini)', () => {
    it('calculates cost for gemini-1.5-pro', () => {
      // 1M input @ $1.25 + 1M output @ $5 = $6.25
      const cost = estimateCost('gemini-1.5-pro', 1_000_000, 1_000_000);
      assert.equal(cost, 6.25);
    });

    it('calculates cost for gemini-2.0-flash', () => {
      // 1M input @ $0.10 + 1M output @ $0.40 = $0.50
      const cost = estimateCost('gemini-2.0-flash', 1_000_000, 1_000_000);
      assert.equal(cost, 0.50);
    });
  });

  describe('resolveTargetUrl (Gemini)', () => {
    const upstreams = {
      openai: 'https://api.openai.com/v1',
      anthropic: 'https://api.anthropic.com',
      chatgpt: 'https://chatgpt.com',
      gemini: 'https://generativelanguage.googleapis.com',
      geminiCodeAssist: 'https://cloudcode-pa.googleapis.com',
    };

    it('routes standard gemini paths', () => {
      const result = resolveTargetUrl({ pathname: '/v1beta/models/gemini-pro:generateContent' }, {}, upstreams);
      assert.equal(result.targetUrl, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent');
      assert.equal(result.provider, 'gemini');
    });

    it('routes code assist gemini paths', () => {
      const result = resolveTargetUrl({ pathname: '/v1internal:predict' }, {}, upstreams);
      assert.equal(result.targetUrl, 'https://cloudcode-pa.googleapis.com/v1internal:predict');
      assert.equal(result.provider, 'gemini');
    });
  });
});
