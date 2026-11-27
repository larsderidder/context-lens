/**
 * Context Lens user configuration.
 *
 * Loaded from ~/.context-lens/config.toml on startup.
 * All settings can be overridden with CLI flags.
 *
 * Precedence: defaults → config file → CLI flags
 */

import fs from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse } from "smol-toml";

export interface ContextLensConfig {
  proxy: {
    port: number;
    redact?: "secrets" | "pii" | "strict";
    rehydrate: boolean;
  };
  ui: {
    port: number;
    noOpen: boolean;
  };
  privacy: {
    level?: "minimal" | "standard" | "full";
  };
  mitm: {
    port: number;
    extraArgs: string[];
    lensSource: string;
    lensSessionId: string;
  };
}

const DEFAULTS: ContextLensConfig = {
  proxy: {
    port: 4040,
    redact: undefined,
    rehydrate: false,
  },
  ui: {
    port: 4041,
    noOpen: false,
  },
  privacy: {
    level: undefined,
  },
  mitm: {
    port: 8080,
    extraArgs: [],
    lensSource: "commandName",
    lensSessionId: "random",
  },
};

export function getConfigPath(): string {
  return join(homedir(), ".context-lens", "config.toml");
}

/**
 * Load and parse the user config file.
 *
 * Returns merged defaults + file values. Missing keys fall back to defaults.
 * Parse errors are logged and defaults are returned.
 */
export function loadConfig(): ContextLensConfig {
  const configPath = getConfigPath();

  if (!fs.existsSync(configPath)) {
    return structuredClone(DEFAULTS);
  }

  let raw: unknown;
  try {
    const text = fs.readFileSync(configPath, "utf8");
    raw = parse(text);
  } catch (err: unknown) {
    console.warn(
      `Warning: Could not parse config file ${configPath}:`,
      err instanceof Error ? err.message : String(err),
    );
    return structuredClone(DEFAULTS);
  }

  return mergeConfig(raw);
}

const VALID_REDACT = new Set(["secrets", "pii", "strict"]);
const VALID_PRIVACY = new Set(["minimal", "standard", "full"]);

type RawSection = {
  port?: unknown;
  redact?: unknown;
  rehydrate?: unknown;
  no_open?: unknown;
  level?: unknown;
  extra_args?: unknown;
  lens_source?: unknown;
  lens_session_id?: unknown;
};

function section(value: unknown): RawSection | null {
  return typeof value === "object" && value !== null
    ? (value as RawSection)
    : null;
}

function mergeConfig(raw: unknown): ContextLensConfig {
  const cfg = structuredClone(DEFAULTS);
  if (typeof raw !== "object" || raw === null) return cfg;
  const r = raw as {
    proxy?: unknown;
    ui?: unknown;
    privacy?: unknown;
    mitm?: unknown;
  };

  const proxy = section(r.proxy);
  if (proxy) {
    if (typeof proxy.port === "number") cfg.proxy.port = proxy.port;
    if (typeof proxy.redact === "string" && VALID_REDACT.has(proxy.redact)) {
      cfg.proxy.redact = proxy.redact as ContextLensConfig["proxy"]["redact"];
    }
    if (typeof proxy.rehydrate === "boolean") {
      cfg.proxy.rehydrate = proxy.rehydrate;
    }
  }

  const ui = section(r.ui);
  if (ui) {
    if (typeof ui.port === "number") cfg.ui.port = ui.port;
    if (typeof ui.no_open === "boolean") cfg.ui.noOpen = ui.no_open;
  }

  const privacy = section(r.privacy);
  if (privacy) {
    if (typeof privacy.level === "string" && VALID_PRIVACY.has(privacy.level)) {
      cfg.privacy.level =
        privacy.level as ContextLensConfig["privacy"]["level"];
    }
  }

  const mitm = section(r.mitm);
  if (mitm) {
    if (typeof mitm.port === "number") cfg.mitm.port = mitm.port;
    if (Array.isArray(mitm.extra_args)) {
      cfg.mitm.extraArgs = mitm.extra_args
        .filter((v) => v !== null && v !== undefined)
        .map((v) => String(v));
    }
    if (typeof mitm.lens_source === "string") {
      cfg.mitm.lensSource = mitm.lens_source;
    }
    if (typeof mitm.lens_session_id === "string") {
      cfg.mitm.lensSessionId = mitm.lens_session_id;
    }
  }

  return cfg;
}

/**
 * Generate a commented example config file.
 */
export function exampleConfig(): string {
  return [
    "# Context Lens configuration",
    "# Location: ~/.context-lens/config.toml",
    "# All settings can be overridden with CLI flags.",
    "",
    "[proxy]",
    "# port = 4040",
    '# redact = "secrets"   # secrets | pii | strict',
    "# rehydrate = false",
    "",
    "[mitm]",
    "# port = 8080",
    '# extra_args = ["--set", "connection_strategy=lazy"]',
    '# lens_source = "commandName"   # commandName | auto | <fixed string>',
    '# lens_session_id = "random"    # random | none | <fixed string>',
    "",
    "[ui]",
    "# port = 4041",
    "# no_open = false",
    "",
    "[privacy]",
    '# level = "standard"   # minimal | standard | full',
  ].join("\n");
}
