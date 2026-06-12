import fs from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { injectSessionTagIntoProxyEnv } from "../cli-utils.js";
import type { ToolConfig } from "../types.js";
import { prepareBrytiDataDir as prepareBrytiDataDirDefault } from "./bryti-config.js";
import { preparePiAgentDir as preparePiAgentDirDefault } from "./pi-config.js";

interface PrepareBrytiOptions {
  targetDirPrefix?: string;
  proxyUrl: string;
  sessionTag: string;
}

interface PreparePiOptions {
  targetDirPrefix?: string;
  proxyUrl: string;
  sessionTag: string;
}

export interface ChildLaunchPlanOptions {
  commandName: string;
  commandArguments: string[];
  toolConfig: ToolConfig;
  useMitm: boolean;
  sessionTag: string;
  baseEnv?: NodeJS.ProcessEnv;
  proxyUrl: string;
  cwd?: string;
  nodeExecPath?: string;
  certPath?: string;
  platform?: NodeJS.Platform;
  certExists?: (path: string) => boolean;
  fileExists?: (path: string) => boolean;
  prepareBrytiDataDir?: (options: PrepareBrytiOptions) => string;
  preparePiAgentDir?: (options: PreparePiOptions) => string;
}

export interface ChildLaunchPlan {
  sessionTag: string;
  env: NodeJS.ProcessEnv;
  allArgs: string[];
  spawnCommand: string;
  spawnArgs: string[];
  warnings: string[];
  mitmCertWarningPath?: string;
  piAgentDirToCleanup?: string;
  brytiDataDirToCleanup?: string;
}

/**
 * Build the child process command, args, and environment without spawning it.
 * This keeps proxy env tagging and temp config setup testable outside cli.ts.
 */
export function prepareChildLaunch(
  options: ChildLaunchPlanOptions,
): ChildLaunchPlan {
  const allArgs = [
    ...options.toolConfig.extraArgs,
    ...options.commandArguments,
  ];
  const env: NodeJS.ProcessEnv = {
    ...(options.baseEnv ?? process.env),
    ...options.toolConfig.childEnv,
  };
  const warnings: string[] = [];
  let piAgentDirToCleanup: string | undefined;
  let brytiDataDirToCleanup: string | undefined;
  const certPath =
    options.certPath ?? join(homedir(), ".mitmproxy", "mitmproxy-ca-cert.pem");
  const certExists = options.certExists ?? fs.existsSync;
  const fileExists = options.fileExists ?? fs.existsSync;
  const cwd = options.cwd ?? process.cwd();
  const nodeExecPath = options.nodeExecPath ?? process.execPath;
  const platform = options.platform ?? process.platform;
  const prepareBrytiDataDir =
    options.prepareBrytiDataDir ?? prepareBrytiDataDirDefault;
  const preparePiAgentDir =
    options.preparePiAgentDir ?? preparePiAgentDirDefault;

  if (!options.toolConfig.needsMitm) {
    if (options.commandName === "bryti") {
      env.BRYTI_DATA_DIR = prepareBrytiDataDir({
        targetDirPrefix: env.BRYTI_DATA_DIR,
        proxyUrl: options.proxyUrl,
        sessionTag: options.sessionTag,
      });
      brytiDataDirToCleanup = env.BRYTI_DATA_DIR;
    }
    Object.assign(
      env,
      injectSessionTagIntoProxyEnv(env, options.sessionTag, options.proxyUrl),
    );
  }

  let mitmCertWarningPath: string | undefined;
  if (options.toolConfig.needsMitm) {
    if (certExists(certPath)) {
      for (const key of Object.keys(env)) {
        if (env[key] === "[CA_CERT_PATH]") env[key] = certPath;
      }
      if (platform === "darwin" && options.commandName === "codex") {
        mitmCertWarningPath = certPath;
      }
    } else {
      warnings.push(
        `Warning: mitmproxy CA cert not found at ${certPath}. Run 'mitmdump' once to generate it.`,
      );
    }
  }

  if (options.commandName === "pi" && !options.useMitm) {
    env.PI_CODING_AGENT_DIR = preparePiAgentDir({
      targetDirPrefix: env.PI_CODING_AGENT_DIR,
      proxyUrl: options.proxyUrl,
      sessionTag: options.sessionTag,
    });
    piAgentDirToCleanup = env.PI_CODING_AGENT_DIR;
  }

  let spawnCommand = options.commandName;
  let spawnArgs = allArgs;
  const localBrytiCli = resolve(cwd, "dist", "cli.js");
  if (options.commandName === "bryti" && fileExists(localBrytiCli)) {
    spawnCommand = nodeExecPath;
    spawnArgs = [localBrytiCli, ...allArgs];
  }

  return {
    sessionTag: options.sessionTag,
    env,
    allArgs,
    spawnCommand,
    spawnArgs,
    warnings,
    mitmCertWarningPath,
    piAgentDirToCleanup,
    brytiDataDirToCleanup,
  };
}
