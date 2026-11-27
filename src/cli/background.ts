import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CLI_CONSTANTS } from "../cli-utils.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface BackgroundState {
  proxyPid: number;
  analysisPid: number | null;
  noUi: boolean;
  startedAt: string;
}

export interface DetachedProcess {
  pid?: number;
  unref: () => void;
}

export interface BackgroundRuntime {
  readStateText: () => string | null;
  writeStateText: (text: string) => void;
  clearState: () => void;
  pidAlive: (pid: number) => boolean;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  spawnDetached: (
    command: string,
    args: string[],
    env: NodeJS.ProcessEnv,
  ) => DetachedProcess;
  sleep: (ms: number) => Promise<void>;
  nowIso: () => string;
  log: (message: string) => void;
  error: (message: string) => void;
  proxyPath: string;
  analysisPath: string;
  proxyUrl: string;
  uiUrl: string;
  env: NodeJS.ProcessEnv;
}

export function getBackgroundStatePath(): string {
  return join(homedir(), ".context-lens", "background.json");
}

function ensureContextLensDir(): void {
  fs.mkdirSync(join(homedir(), ".context-lens"), { recursive: true });
}

export function isSafeBackgroundPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isSafeInteger(pid) && pid > 1;
}

export function parseBackgroundState(
  raw: string | null,
): BackgroundState | null {
  if (raw == null) return null;

  try {
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      isSafeBackgroundPid(parsed.proxyPid) &&
      (parsed.analysisPid === null ||
        isSafeBackgroundPid(parsed.analysisPid)) &&
      typeof parsed.noUi === "boolean" &&
      typeof parsed.startedAt === "string"
    ) {
      return parsed as BackgroundState;
    }
  } catch {}

  return null;
}

export function parseBackgroundArgs(
  args: string[],
  globalNoUi: boolean,
): { action: "start" | "stop" | "status"; noUi: boolean } | { error: string } {
  const actionArg = args[0] || "status";
  if (!["start", "stop", "status"].includes(actionArg)) {
    return {
      error: "Error: background command requires one of: start, stop, status",
    };
  }
  const localNoUi = args.includes("--no-ui");
  return {
    action: actionArg as "start" | "stop" | "status",
    noUi: globalNoUi || localNoUi,
  };
}

export function createNodeBackgroundRuntime(): BackgroundRuntime {
  return {
    readStateText: () => {
      try {
        return fs.readFileSync(getBackgroundStatePath(), "utf8");
      } catch {
        return null;
      }
    },
    writeStateText: (text: string) => {
      ensureContextLensDir();
      fs.writeFileSync(getBackgroundStatePath(), text);
    },
    clearState: () => {
      try {
        fs.unlinkSync(getBackgroundStatePath());
      } catch {}
    },
    pidAlive: (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    },
    kill: (pid: number, signal: NodeJS.Signals) => {
      process.kill(pid, signal);
    },
    spawnDetached: (
      command: string,
      args: string[],
      env: NodeJS.ProcessEnv,
    ) => {
      const child = spawn(command, args, {
        stdio: "ignore",
        detached: true,
        env,
      });
      child.unref();
      return child as ChildProcess & DetachedProcess;
    },
    sleep: async (ms: number) => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    },
    nowIso: () => new Date().toISOString(),
    log: (message: string) => console.log(message),
    error: (message: string) => console.error(message),
    proxyPath: join(__dirname, "..", "proxy", "server.js"),
    analysisPath: join(__dirname, "..", "analysis", "server.js"),
    proxyUrl: CLI_CONSTANTS.PROXY_URL,
    uiUrl: CLI_CONSTANTS.UI_URL,
    env: process.env,
  };
}

export function readBackgroundState(
  runtime: BackgroundRuntime = createNodeBackgroundRuntime(),
): BackgroundState | null {
  return parseBackgroundState(runtime.readStateText());
}

function stateText(state: BackgroundState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

export function isBackgroundRunning(
  state: BackgroundState,
  runtime: BackgroundRuntime = createNodeBackgroundRuntime(),
): boolean {
  const proxyAlive = runtime.pidAlive(state.proxyPid);
  const analysisAlive =
    state.analysisPid == null || runtime.pidAlive(state.analysisPid);
  return proxyAlive && analysisAlive;
}

export async function runBackgroundCommand(
  args: string[],
  globalNoUi: boolean,
  runtime: BackgroundRuntime = createNodeBackgroundRuntime(),
): Promise<number> {
  const parsed = parseBackgroundArgs(args, globalNoUi);
  if ("error" in parsed) {
    runtime.error(parsed.error);
    return 1;
  }
  if (parsed.action === "status") {
    return backgroundStatus(runtime);
  }
  if (parsed.action === "stop") {
    return backgroundStop(runtime);
  }
  return backgroundStart(parsed.noUi, runtime);
}

export function backgroundStatus(
  runtime: BackgroundRuntime = createNodeBackgroundRuntime(),
): number {
  const raw = runtime.readStateText();
  if (!raw) {
    runtime.log("Background status: not running");
    return 0;
  }

  const state = parseBackgroundState(raw);
  if (!state) {
    runtime.log("Background status: stale state found (invalid PID)");
    runtime.clearState();
    return 0;
  }

  const running = isBackgroundRunning(state, runtime);
  if (!running) {
    runtime.log("Background status: stale state found (not running)");
    runtime.clearState();
    return 0;
  }

  runtime.log("Background status: running");
  runtime.log(`  proxy pid: ${state.proxyPid}`);
  if (state.analysisPid != null) {
    runtime.log(`  analysis pid: ${state.analysisPid}`);
  } else {
    runtime.log("  analysis: disabled (--no-ui)");
  }
  runtime.log(`  started: ${state.startedAt}`);
  return 0;
}

export function backgroundStop(
  runtime: BackgroundRuntime = createNodeBackgroundRuntime(),
): number {
  const raw = runtime.readStateText();
  if (!raw) {
    runtime.log("Background status: not running");
    return 0;
  }

  const state = parseBackgroundState(raw);
  if (!state) {
    runtime.log("Background status: stale state found (invalid PID)");
    runtime.clearState();
    return 0;
  }

  const pids = [state.proxyPid, state.analysisPid].filter(
    (pid): pid is number => isSafeBackgroundPid(pid),
  );
  for (const pid of pids) {
    try {
      runtime.kill(pid, "SIGTERM");
    } catch {}
  }
  runtime.clearState();
  runtime.log("Background services stopped.");
  return 0;
}

export async function backgroundStart(
  noUi: boolean,
  runtime: BackgroundRuntime = createNodeBackgroundRuntime(),
): Promise<number> {
  const existing = readBackgroundState(runtime);
  if (existing && isBackgroundRunning(existing, runtime)) {
    runtime.log("Background status: already running");
    runtime.log(`  proxy pid: ${existing.proxyPid}`);
    return 0;
  }
  if (existing) runtime.clearState();

  const proxyEnv: NodeJS.ProcessEnv = {
    ...runtime.env,
    CONTEXT_LENS_CLI: "1",
    ...(noUi ? {} : { CONTEXT_LENS_ANALYSIS_URL: runtime.uiUrl }),
  };
  const proxy = runtime.spawnDetached("node", [runtime.proxyPath], proxyEnv);

  let analysis: DetachedProcess | null = null;
  if (!noUi) {
    analysis = runtime.spawnDetached("node", [runtime.analysisPath], {
      ...runtime.env,
      CONTEXT_LENS_CLI: "1",
    });
  }

  await runtime.sleep(150);

  const proxyPid = proxy.pid ?? 0;
  const analysisPid = analysis?.pid ?? null;
  if (!isSafeBackgroundPid(proxyPid) || !runtime.pidAlive(proxyPid)) {
    runtime.error("Failed to start proxy in background.");
    return 1;
  }
  if (
    analysisPid != null &&
    (!isSafeBackgroundPid(analysisPid) || !runtime.pidAlive(analysisPid))
  ) {
    runtime.error("Failed to start analysis server in background.");
    try {
      runtime.kill(proxyPid, "SIGTERM");
    } catch {}
    return 1;
  }

  runtime.writeStateText(
    stateText({
      proxyPid,
      analysisPid,
      noUi,
      startedAt: runtime.nowIso(),
    }),
  );

  runtime.log("Background services started.");
  runtime.log(`  proxy: ${runtime.proxyUrl} (pid ${proxyPid})`);
  if (analysisPid != null) {
    runtime.log(`  analysis/web UI: ${runtime.uiUrl} (pid ${analysisPid})`);
  } else {
    runtime.log("  analysis/web UI: disabled (--no-ui)");
  }
  return 0;
}
