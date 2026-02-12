import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ToolConfig } from "./types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Known tool config: env vars for the child process, extra CLI args, server env vars, and whether mitmproxy is needed
const PROXY_URL = "http://localhost:4040";
const MITM_PORT = 8080;
const MITM_PROXY_URL = `http://localhost:${MITM_PORT}`;
const PI_AGENT_DIR_PREFIX = "/tmp/context-lens-pi-agent-";

const TOOL_CONFIG: Record<string, ToolConfig> = {
  claude: {
    childEnv: { ANTHROPIC_BASE_URL: `${PROXY_URL}/claude` },
    extraArgs: [],
    serverEnv: {},
    needsMitm: false,
  },
  codex: {
    // Codex subscription uses chatgpt.com with Cloudflare, needs forward proxy (mitmproxy)
    // to intercept HTTPS traffic without breaking TLS fingerprinting.
    childEnv: {
      https_proxy: MITM_PROXY_URL,
      SSL_CERT_FILE: join(
        process.env.HOME || "",
        ".mitmproxy",
        "mitmproxy-ca-cert.pem",
      ),
    },
    extraArgs: [],
    serverEnv: {},
    needsMitm: true,
  },
  aider: {
    childEnv: {
      ANTHROPIC_BASE_URL: `${PROXY_URL}/aider`,
      OPENAI_BASE_URL: `${PROXY_URL}/aider`,
    },
    extraArgs: [],
    serverEnv: {},
    needsMitm: false,
  },
  gemini: {
    childEnv: {
      GOOGLE_GEMINI_BASE_URL: `${PROXY_URL}/gemini/`, // API-key auth path
      CODE_ASSIST_ENDPOINT: `${PROXY_URL}/gemini`, // OAuth/Google login path
    },
    extraArgs: [],
    serverEnv: {},
    needsMitm: false,
  },
  pi: {
    // Pi ignores standard base URL env vars. We point it at a temporary agent
    // directory where cli.ts writes a proxy-aware models.json.
    childEnv: {
      PI_CODING_AGENT_DIR: PI_AGENT_DIR_PREFIX,
    },
    extraArgs: [],
    serverEnv: {},
    needsMitm: false,
  },
};

export function getToolConfig(toolName: string): ToolConfig {
  return (
    TOOL_CONFIG[toolName] || {
      childEnv: {
        ANTHROPIC_BASE_URL: `${PROXY_URL}/${toolName}`,
        OPENAI_BASE_URL: `${PROXY_URL}/${toolName}`,
      },
      extraArgs: [],
      serverEnv: {},
      needsMitm: false,
    }
  );
}

// Exported for tests (and to keep cli.ts smaller).
export const CLI_CONSTANTS = {
  PROXY_URL,
  MITM_PORT,
  MITM_PROXY_URL,
  PI_AGENT_DIR_PREFIX,
  // Resolved relative to compiled output (dist/ or dist-test/), matching cli.ts behavior.
  MITM_ADDON_PATH: join(__dirname, "..", "mitm_addon.py"),
} as const;
