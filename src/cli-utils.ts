import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig } from "./config.js";
import type { MitmConfig, ToolConfig } from "./types.js";
import { VERSION } from "./version.generated.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Known tool config: env vars for the child process, extra CLI args, server env vars, and whether mitmproxy is needed
const config = loadConfig();

const PROXY_PORT = Number.isNaN(config.proxy.port) ? 4040 : config.proxy.port;
const PROXY_URL = `http://localhost:${PROXY_PORT}`;

const UI_PORT = Number.isNaN(config.ui.port) ? 4041 : config.ui.port;
const UI_URL = `http://localhost:${UI_PORT}`;

const PI_AGENT_DIR_PREFIX = "/tmp/context-lens-pi-agent-";
const BRYTI_DATA_DIR_PREFIX = "/tmp/context-lens-bryti-";
const COMMAND_ALIASES: Record<string, string> = {
  cc: "claude",
  cx: "codex",
  gm: "gemini",
  oc: "opencode",
};

const KNOWN_PRIVACY_LEVELS = ["minimal", "standard", "full"] as const;
type PrivacyLevel = (typeof KNOWN_PRIVACY_LEVELS)[number];

const KNOWN_REDACT_PRESETS = ["secrets", "pii", "strict"] as const;
type RedactPreset = (typeof KNOWN_REDACT_PRESETS)[number];

function isRedactPreset(value: string): value is RedactPreset {
  return (KNOWN_REDACT_PRESETS as readonly string[]).includes(value);
}

export interface ParsedCliArgs {
  showHelp: boolean;
  showVersion: boolean;
  noOpen: boolean;
  noUi: boolean;
  noUpdateCheck: boolean;
  useMitm: boolean;
  privacyLevel?: string;
  redactPreset?: RedactPreset;
  rehydrate?: boolean;
  commandName?: string;
  commandArguments: string[];
  error?: string;
}

function isPrivacyLevel(value: string): value is PrivacyLevel {
  return (KNOWN_PRIVACY_LEVELS as readonly string[]).includes(value);
}

const TOOL_CONFIG: Record<string, ToolConfig> = {
  claude: {
    childEnv: { ANTHROPIC_BASE_URL: `${PROXY_URL}/claude` },
    extraArgs: [],
    serverEnv: {},
    needsMitm: false,
  },
  codex: {
    // Codex (v0.101+) is a Rust binary that connects directly to
    // chatgpt.com over HTTPS. It ignores chatgpt_base_url for subscription
    // mode and does not support OPENAI_BASE_URL (OAuth token lacks scopes).
    //
    // We use mitmproxy as a forward HTTPS proxy to intercept traffic.
    // The mitmproxy addon captures requests and POSTs them to the
    // analysis server's ingest API.
    childEnv: {},
    extraArgs: [],
    serverEnv: {},
    needsMitm: true,
  },
  cline: {
    // Cline with Anthropic OAuth routes through api.cline.bot (their own
    // backend), not directly to api.anthropic.com. Setting ANTHROPIC_BASE_URL
    // has no effect in OAuth mode, so we use mitmproxy to intercept the
    // HTTPS traffic to api.cline.bot and capture the /v1/messages calls.
    //
    // Cline is a Node.js process. Node ignores SSL_CERT_FILE and requires
    // NODE_EXTRA_CA_CERTS to trust the mitmproxy CA certificate.
    childEnv: {},
    extraArgs: [],
    serverEnv: {},
    needsMitm: true,
  },
  copilot: {
    // GitHub Copilot CLI (@github/copilot) supports COPILOT_API_URL to
    // redirect all API traffic to a custom endpoint. We point it at the
    // reverse proxy so captures work without mitmproxy.
    //
    // The proxy needs to forward openai-classified traffic to
    // api.githubcopilot.com instead of api.openai.com, so we override
    // UPSTREAM_OPENAI_URL in the server (proxy) environment.
    childEnv: { COPILOT_API_URL: `${PROXY_URL}/copilot` },
    extraArgs: [],
    serverEnv: { UPSTREAM_OPENAI_URL: "https://api.githubcopilot.com" },
    needsMitm: false,
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
  opencode: {
    // OpenCode connects directly to each provider's official API over HTTPS
    // and cannot be redirected via base URL env vars alone when using multiple
    // providers simultaneously. We use mitmproxy as a forward HTTPS proxy so
    // all provider traffic is captured regardless of which model is active.
    childEnv: {},
    extraArgs: [],
    serverEnv: {},
    needsMitm: true,
  },
  gemini: {
    childEnv: {
      GOOGLE_GEMINI_BASE_URL: `${PROXY_URL}/gemini/`, // API-key auth path
      GOOGLE_VERTEX_BASE_URL: `${PROXY_URL}/gemini/`, // Vertex AI auth path
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
    // Allow x-target-url header so providers with non-standard upstreams
    // (e.g. opencode, kilo) can tell the proxy their real destination URL.
    serverEnv: { CONTEXT_LENS_ALLOW_TARGET_OVERRIDE: "1" },
    needsMitm: false,
  },
  bryti: {
    // Bryti reads base_url from its config.yml, not env vars. We point it at
    // a temporary data dir where cli.ts writes a proxy-aware config.yml copy.
    // Everything else in the temp dir is symlinked back to the real data dir
    // so all runtime writes (history, memory DB, etc.) go to the right place.
    childEnv: {
      BRYTI_DATA_DIR: BRYTI_DATA_DIR_PREFIX,
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

export function resolveCommandAlias(commandName: string): string {
  return COMMAND_ALIASES[commandName] || commandName;
}

export function parseCliArgs(args: string[]): ParsedCliArgs {
  let showHelp = false;
  let showVersion = false;
  let noOpen = false;
  let noUi = false;
  let noUpdateCheck = false;
  let useMitm = false;
  let privacyLevel: string | undefined;
  let redactPreset: RedactPreset | undefined;
  let rehydrate = false;
  let explicitSeparator = false;
  let commandStartIndex = -1;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      explicitSeparator = true;
      commandStartIndex = i + 1;
      break;
    }
    if (!arg.startsWith("-")) {
      commandStartIndex = i;
      break;
    }
    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      showVersion = true;
      continue;
    }
    if (arg === "--no-open") {
      noOpen = true;
      continue;
    }
    if (arg === "--no-ui") {
      noUi = true;
      continue;
    }
    if (arg === "--no-update-check") {
      noUpdateCheck = true;
      continue;
    }
    if (arg === "--mitm") {
      useMitm = true;
      continue;
    }
    if (arg === "--redact") {
      redactPreset = "secrets";
      continue;
    }
    if (arg === "--rehydrate") {
      rehydrate = true;
      continue;
    }
    if (arg.startsWith("--redact=")) {
      const value = arg.split("=", 2)[1];
      if (!isRedactPreset(value)) {
        return {
          showHelp,
          showVersion,
          noOpen,
          noUi,
          noUpdateCheck,
          useMitm,
          commandArguments: [],
          error: `Error: Invalid redact preset '${value}'. Must be one of: ${KNOWN_REDACT_PRESETS.join(", ")}`,
        };
      }
      redactPreset = value;
      continue;
    }
    if (arg === "--privacy") {
      if (i + 1 >= args.length) {
        return {
          showHelp,
          showVersion,
          noOpen,
          noUi,
          noUpdateCheck,
          useMitm,
          commandArguments: [],
          error:
            "Error: Missing value for --privacy. Expected one of: minimal, standard, full",
        };
      }
      privacyLevel = args[i + 1];
      i++;
      continue;
    }
    if (arg.startsWith("--privacy=")) {
      privacyLevel = arg.split("=", 2)[1];
      continue;
    }
    return {
      showHelp,
      showVersion,
      noOpen,
      noUi,
      noUpdateCheck,
      useMitm,
      commandArguments: [],
      error: `Error: Unknown option '${arg}'. Run 'context-lens --help' for usage.`,
    };
  }

  if (privacyLevel && !isPrivacyLevel(privacyLevel)) {
    return {
      showHelp,
      showVersion,
      noOpen,
      noUi,
      noUpdateCheck,
      useMitm,
      commandArguments: [],
      error: `Error: Invalid privacy level '${privacyLevel}'. Must be one of: ${KNOWN_PRIVACY_LEVELS.join(", ")}`,
    };
  }

  const rawCommand =
    commandStartIndex >= 0 ? args[commandStartIndex] : undefined;
  const commandName = rawCommand ? resolveCommandAlias(rawCommand) : undefined;
  const commandArguments =
    commandStartIndex >= 0 ? args.slice(commandStartIndex + 1) : [];

  if (explicitSeparator && !rawCommand && !showHelp && !showVersion) {
    return {
      showHelp,
      showVersion,
      noOpen,
      noUi,
      noUpdateCheck,
      useMitm,
      privacyLevel,
      redactPreset,
      rehydrate,
      commandArguments: [],
      error: "Error: No command specified after --",
    };
  }

  return {
    showHelp,
    showVersion,
    noOpen,
    noUi,
    noUpdateCheck,
    useMitm,
    privacyLevel,
    redactPreset,
    rehydrate,
    commandName,
    commandArguments,
  };
}

export function formatHelpText(): string {
  return [
    `context-lens v${VERSION}`,
    "",
    "Usage:",
    "  context-lens [global-options] [tool-or-command] [args...]",
    "  context-lens [global-options] -- [command] [args...]",
    "  context-lens [global-options]   (no command = standalone mode)",
    "  context-lens doctor",
    "  context-lens stop",
    "  context-lens background <start|stop|status> [--no-ui]",
    "  context-lens analyze <session.lhar> [options]",
    "",
    "Examples:",
    "  context-lens claude",
    "  context-lens codex",
    "  context-lens cline",
    "  context-lens copilot",
    "  context-lens opencode",
    "  context-lens gm",
    "  context-lens bryti",
    "  context-lens --privacy=minimal aider --model claude-sonnet-4",
    "  context-lens -- python my_agent.py",
    "  context-lens doctor",
    "  context-lens stop",
    "  context-lens background start --no-ui",
    "  context-lens analyze ~/.context-lens/data/claude-abc123.lhar",
    "  context-lens analyze session.lhar --json --main-only",
    "  context-lens analyze session.lhar --composition=pre-compaction",
    "",
    "Global options:",
    "  -h, --help             Show this help text",
    "  -v, --version          Show version",
    "  --privacy <level>      Set privacy level: minimal|standard|full",
    `  --no-open              Don't auto-open ${UI_URL}`,
    "  --no-ui                Run proxy only (no analysis/web UI server)",
    "  --no-update-check      Skip npm update check for this run",
    "  --mitm                 Use mitmproxy for interception instead of base URL override (only recommend forcing for Pi)",
    "  --redact[=preset]      Strip sensitive data before capture (experimental). Preset: secrets|pii|strict (default: secrets)",
    "  --rehydrate            With --redact: restore original values in responses (off by default)",
    "",
    "Command aliases:",
    "  cc -> claude",
    "  cx -> codex",
    "  gm -> gemini",
    "  oc -> opencode",
    "",
    "Shell alias (add to ~/.zshrc or ~/.bashrc):",
    "  alias cpi='context-lens pi'",
    "",
    "Environment variables:",
    "  UPSTREAM_OPENAI_URL        Override OpenAI upstream (for OpenAI-compatible APIs)",
    "  UPSTREAM_ANTHROPIC_URL     Override Anthropic upstream",
    "  UPSTREAM_GEMINI_URL        Override Gemini upstream",
    "",
    "Notes:",
    "  - No command starts standalone mode (proxy + analysis/web UI by default).",
    "  - 'codex', 'cline', and 'opencode' use mitmproxy for HTTPS interception (requires mitmproxy; install: pipx install mitmproxy).",
    "  - 'cline' with Anthropic OAuth routes through api.cline.bot; mitmproxy intercepts that traffic.",
    "  - 'copilot' (GitHub Copilot CLI, @github/copilot) uses COPILOT_API_URL to redirect traffic through the proxy; no mitmproxy needed.",
    "  - 'pi --mitm' uses mitmproxy for full interception, useful for subscription-based models (openai-codex provider).",
    "  - 'doctor' is a local diagnostics command.",
    "  - 'background' manages detached proxy/web-ui processes.",
    "  - 'analyze' reads an .lhar file and prints session statistics.",
    "",
    "Analyze options:",
    "  --json                    Output as JSON instead of formatted text",
    "  --no-path                 Omit the agent path trace",
    "  --main-only               Only analyze main agent entries",
    "  --composition=last        Composition of the last entry (default)",
    "  --composition=pre-compaction  Composition before each compaction",
    "  --composition=N           Composition at end of user turn N",
  ].join("\n");
}

// Exported for tests (and to keep cli.ts smaller).
export const CLI_CONSTANTS = {
  PROXY_URL,
  PROXY_PORT,
  UI_PORT,
  UI_URL,
  PI_AGENT_DIR_PREFIX,
  BRYTI_DATA_DIR_PREFIX,
  COMMAND_ALIASES,
  KNOWN_PRIVACY_LEVELS,
} as const;
export function getMitmConfig(): MitmConfig {
  const port = Number.isNaN(config.mitm.port) ? 8080 : config.mitm.port;
  return {
    port,
    proxyUrl: `http://localhost:${port}`,
    extraArgs: config.mitm.extraArgs,
    addonPath: join(__dirname, "..", "mitm_addon.py"),
    lensSource: config.mitm.lensSource,
    lensSessionId: config.mitm.lensSessionId,
  };
}
