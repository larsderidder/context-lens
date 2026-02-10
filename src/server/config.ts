import path from 'node:path';

import type { Upstreams } from '../types.js';

export interface ServerConfig {
  upstreams: Upstreams;
  bindHost: string;
  allowTargetOverride: boolean;
  dataDir: string;
  stateFile: string;
  maxSessions: number;
  maxCompactMessages: number;
}

export function loadServerConfig(baseDir: string): ServerConfig {
  // Upstream targets — configurable via env vars
  const UPSTREAM_OPENAI_URL = process.env.UPSTREAM_OPENAI_URL || 'https://api.openai.com/v1';
  const UPSTREAM_ANTHROPIC_URL = process.env.UPSTREAM_ANTHROPIC_URL || 'https://api.anthropic.com';
  const UPSTREAM_CHATGPT_URL = process.env.UPSTREAM_CHATGPT_URL || 'https://chatgpt.com';
  const UPSTREAM_GEMINI_URL = process.env.UPSTREAM_GEMINI_URL || 'https://generativelanguage.googleapis.com';
  const UPSTREAM_GEMINI_CODE_ASSIST_URL = process.env.UPSTREAM_GEMINI_CODE_ASSIST_URL || 'https://cloudcode-pa.googleapis.com';

  // Safety defaults:
  // - Bind only to localhost unless explicitly overridden.
  // - Do not honor `x-target-url` unless explicitly enabled (prevents accidental open-proxy/SSRF).
  const bindHost = process.env.CONTEXT_LENS_BIND_HOST || '127.0.0.1';
  const allowTargetOverride = process.env.CONTEXT_LENS_ALLOW_TARGET_OVERRIDE === '1';

  const dataDir = path.join(baseDir, '..', 'data');

  return {
    upstreams: {
      openai: UPSTREAM_OPENAI_URL,
      anthropic: UPSTREAM_ANTHROPIC_URL,
      chatgpt: UPSTREAM_CHATGPT_URL,
      gemini: UPSTREAM_GEMINI_URL,
      geminiCodeAssist: UPSTREAM_GEMINI_CODE_ASSIST_URL,
    },
    bindHost,
    allowTargetOverride,
    dataDir,
    stateFile: path.join(dataDir, 'state.jsonl'),
    maxSessions: 10,
    maxCompactMessages: 60,
  };
}

