#!/usr/bin/env node

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import { platform } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { runAnalyze } from "./cli/analyze-command.js";
import { backgroundStop, runBackgroundCommand } from "./cli/background.js";
import { prepareChildLaunch } from "./cli/child-launch.js";
import { runDoctor } from "./cli/doctor.js";
import {
  clearStaleLockfile,
  decrementLockRefCount,
  incrementLockRefCount,
} from "./cli/lockfile.js";
import { checkForUpdate } from "./cli/update-check.js";
import {
  CLI_CONSTANTS,
  formatHelpText,
  getMitmConfig,
  getToolConfig,
  parseCliArgs,
  resolveLensSessionId,
  resolveLensSource,
  toMitmToolConfig,
} from "./cli-utils.js";
import { loadConfig } from "./config.js";
import { VERSION } from "./version.generated.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Known tool config lives in cli-utils.ts so it can be unit-tested without importing this entrypoint.
const rawArgs = process.argv.slice(2);
const parsedArgs = parseCliArgs(rawArgs);
if (parsedArgs.error) {
  console.error(parsedArgs.error);
  process.exit(1);
}
if (parsedArgs.showHelp) {
  console.log(formatHelpText());
  process.exit(0);
}
if (parsedArgs.showVersion) {
  console.log(VERSION);
  process.exit(0);
}
// Load user config — CLI flags take precedence over config file values
const userConfig = loadConfig();

const envKeyToValue: Record<string, string> = {
  CONTEXT_LENS_PROXY_PORT: String(CLI_CONSTANTS.PROXY_PORT),
  CONTEXT_LENS_ANALYSIS_PORT: String(CLI_CONSTANTS.UI_PORT),
  CONTEXT_LENS_ANALYSIS_URL: CLI_CONSTANTS.UI_URL,
  CONTEXT_LENS_INGEST_URL: `${CLI_CONSTANTS.UI_URL}/api/ingest`,
};
for (const [key, value] of Object.entries(envKeyToValue)) {
  if (!process.env[key]) process.env[key] = value;
}

const envOverrides: Record<string, string | undefined> = {
  CONTEXT_LENS_PRIVACY: parsedArgs.privacyLevel ?? userConfig.privacy.level,
  CONTEXT_LENS_REDACT: parsedArgs.redactPreset ?? userConfig.proxy.redact,
  CONTEXT_LENS_REHYDRATE:
    (parsedArgs.rehydrate ?? userConfig.proxy.rehydrate) ? "1" : undefined,
};
for (const [key, value] of Object.entries(envOverrides)) {
  if (value !== undefined) process.env[key] = value;
}
if (
  !parsedArgs.noUpdateCheck &&
  process.env.CONTEXT_LENS_NO_UPDATE_CHECK !== "1"
) {
  void checkForUpdate(VERSION);
}
if (parsedArgs.commandName === "analyze") {
  void runAnalyze(parsedArgs.commandArguments).then((exitCode) =>
    process.exit(exitCode),
  );
} else if (parsedArgs.commandName === "doctor") {
  void runDoctor().then((exitCode) => process.exit(exitCode));
} else if (parsedArgs.commandName === "stop") {
  process.exit(backgroundStop());
} else if (parsedArgs.commandName === "background") {
  void runBackgroundCommand(parsedArgs.commandArguments, parsedArgs.noUi).then(
    (exitCode) => process.exit(exitCode),
  );
} else if (!parsedArgs.commandName && !parsedArgs.useMitm) {
  // Warn if PI_CODING_AGENT_DIR is set in the environment but no command was
  // given. The user likely expected this to launch pi — point them to the
  // correct invocation before dropping into standalone mode.
  if (process.env.PI_CODING_AGENT_DIR) {
    console.error(
      "Warning: PI_CODING_AGENT_DIR is set but no command was given.",
    );
    console.error("To capture pi traffic, run: context-lens pi [pi-args...]");
    console.error(
      "Starting standalone mode (proxy + analysis server) instead.",
    );
  }
  if (parsedArgs.noUi) {
    // Standalone mode (no UI): start proxy only
    const proxyPath = join(__dirname, "proxy", "server.js");
    const proxy = spawn("node", [proxyPath], {
      stdio: "inherit",
      env: { ...process.env },
    });
    function shutdownStandaloneProxyOnly(code: number): void {
      if (!proxy.killed) proxy.kill();
      process.exit(code);
    }
    proxy.on("exit", (code) => shutdownStandaloneProxyOnly(code || 0));
    process.on("SIGINT", () => shutdownStandaloneProxyOnly(0));
    process.on("SIGTERM", () => shutdownStandaloneProxyOnly(0));
    process.stdin.resume();
  } else {
    // Standalone mode: start both proxy and analysis server
    const proxyPath = join(__dirname, "proxy", "server.js");
    const analysisPath = join(__dirname, "analysis", "server.js");
    const proxy = spawn("node", [proxyPath], {
      stdio: "inherit",
      env: {
        ...process.env,
        CONTEXT_LENS_ANALYSIS_URL: CLI_CONSTANTS.UI_URL,
      },
    });
    const analysis = spawn("node", [analysisPath], {
      stdio: "inherit",
      env: { ...process.env },
    });
    function shutdownStandalone(code: number): void {
      if (!proxy.killed) proxy.kill();
      if (!analysis.killed) analysis.kill();
      process.exit(code);
    }
    proxy.on("exit", (code) => shutdownStandalone(code || 0));
    analysis.on("exit", (code) => shutdownStandalone(code || 0));
    process.on("SIGINT", () => shutdownStandalone(0));
    process.on("SIGTERM", () => shutdownStandalone(0));
    // Prevent early exit
    process.stdin.resume();
  }
} else {
  const commandName = parsedArgs.commandName ?? "";
  const commandArguments = parsedArgs.commandArguments;
  const noOpen = parsedArgs.noOpen || userConfig.ui.noOpen;
  const noUi = parsedArgs.noUi;
  const useMitm = parsedArgs.useMitm;

  const mitmConfig = getMitmConfig();
  let toolConfig = getToolConfig(commandName);
  if (useMitm || toolConfig.needsMitm) {
    toolConfig = toMitmToolConfig(toolConfig, mitmConfig);
  }

  if (noUi && toolConfig.needsMitm) {
    console.error(
      `Error: --no-ui is not supported for this command because mitm capture requires the analysis ingest API on :${CLI_CONSTANTS.UI_PORT}.`,
    );
    process.exit(1);
  }

  // Check if proxy is already running
  function isProxyRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect(
        { port: CLI_CONSTANTS.PROXY_PORT, host: "localhost" },
        () => {
          socket.end();
          resolve(true);
        },
      );
      socket.on("error", () => resolve(false));
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  let proxyProcess: ChildProcess | null = null;
  let analysisProcess: ChildProcess | null = null;
  let mitmProcess: ChildProcess | null = null;
  let proxyReady = false;
  let analysisReady = false;
  let mitmReady = false;
  let childProcess: ChildProcess | null = null;
  let piAgentDirToCleanup: string | null = null;
  let brytiDataDirToCleanup: string | null = null;
  let shouldShutdownServers = false;
  let cleanupDidRun = false;
  const requiresAnalysis = !noUi;

  function checkBothReady(): void {
    if (proxyReady && analysisReady) {
      maybeStartMitmThenChild();
    }
  }

  // Check if analysis server is already running
  function isAnalysisRunning(): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect(
        { port: CLI_CONSTANTS.UI_PORT, host: "localhost" },
        () => {
          socket.end();
          resolve(true);
        },
      );
      socket.on("error", () => resolve(false));
      socket.setTimeout(1000, () => {
        socket.destroy();
        resolve(false);
      });
    });
  }

  // Start proxy and analysis server (or attach to existing ones)
  async function initializeServers(): Promise<void> {
    const proxyAlreadyRunning = await isProxyRunning();
    const analysisAlreadyRunning = requiresAnalysis
      ? await isAnalysisRunning()
      : false;

    const allRequiredRunning =
      proxyAlreadyRunning && (!requiresAnalysis || analysisAlreadyRunning);

    if (allRequiredRunning) {
      console.log("🔍 Context Lens already running, attaching...");
      incrementLockRefCount();
      proxyReady = true;
      analysisReady = !requiresAnalysis || analysisAlreadyRunning;
      shouldShutdownServers = false;
      checkBothReady();
      return;
    }

    console.log("🔍 Starting Context Lens proxy and analysis server...");
    // Clear stale lockfile if servers aren't actually running
    if (!proxyAlreadyRunning) clearStaleLockfile();
    incrementLockRefCount();
    shouldShutdownServers = true;

    const serverEnv = {
      ...toolConfig.serverEnv,
      ...process.env,
      CONTEXT_LENS_CLI: "1",
      CONTEXT_LENS_ANALYSIS_URL: CLI_CONSTANTS.UI_URL,
    };

    // Start proxy
    if (proxyAlreadyRunning) {
      proxyReady = true;
    } else {
      const proxyPath = join(__dirname, "proxy", "server.js");
      proxyProcess = spawn("node", [proxyPath], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        env: serverEnv,
      });

      proxyProcess.stdout?.on("data", (data: Buffer) => {
        const output = data.toString();
        if (!proxyReady) process.stderr.write(output);
        if (
          (output.includes("Context Lens Proxy running") ||
            output.includes("@contextio/proxy running")) &&
          !proxyReady
        ) {
          proxyReady = true;
          checkBothReady();
        }
      });

      // Always forward stderr so warnings and errors are visible.
      proxyProcess.stderr?.on("data", (data: Buffer) => {
        process.stderr.write(data);
      });

      proxyProcess.on("error", (err) => {
        console.error("Failed to start proxy:", err);
        decrementLockRefCount();
        process.exit(1);
      });

      proxyProcess.on("exit", (code) => {
        if (!proxyReady) {
          console.error("Proxy exited unexpectedly");
          decrementLockRefCount();
          process.exit(code || 1);
        }
      });
    }

    // Start analysis server
    if (!requiresAnalysis) {
      analysisReady = true;
    } else if (analysisAlreadyRunning) {
      analysisReady = true;
    } else {
      const analysisPath = join(__dirname, "analysis", "server.js");
      analysisProcess = spawn("node", [analysisPath], {
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        env: serverEnv,
      });

      analysisProcess.stdout?.on("data", (data: Buffer) => {
        const output = data.toString();
        if (!analysisReady) process.stderr.write(output);
        if (
          output.includes("Context Lens Analysis running") &&
          !analysisReady
        ) {
          analysisReady = true;
          checkBothReady();
        }
      });

      // Always forward stderr so warnings and errors are visible.
      analysisProcess.stderr?.on("data", (data: Buffer) => {
        process.stderr.write(data);
      });

      analysisProcess.on("error", (err) => {
        console.error("Failed to start analysis server:", err);
        decrementLockRefCount();
        process.exit(1);
      });

      analysisProcess.on("exit", (code) => {
        if (!analysisReady) {
          console.error("Analysis server exited unexpectedly");
          decrementLockRefCount();
          process.exit(code || 1);
        }
      });
    }

    // Open browser after a short delay (only when starting new servers)
    if (!noOpen && requiresAnalysis) {
      setTimeout(() => {
        openBrowser(CLI_CONSTANTS.UI_URL);
      }, 1000);
    }

    // If both were already ready (mixed scenario), check now
    checkBothReady();
  }

  initializeServers();

  // Start mitmproxy if needed, then start the child
  function maybeStartMitmThenChild(): void {
    if (!toolConfig.needsMitm) {
      startChild();
      return;
    }

    // Pre-flight: check if the mitm port is already in use.
    // Without this, mitmproxy exits silently and the poll loop connects
    // to whatever is already on that port, falsely reporting success.
    const probe = net.connect(
      { port: mitmConfig.port, host: "localhost" },
      () => {
        probe.end();
        console.error(
          `\nError: port ${mitmConfig.port} is already in use (mitmproxy cannot bind).`,
        );
        console.error(
          `Set a different port in ~/.context-lens/config.toml:\n\n  [mitm]\n  port = 8082\n`,
        );
        cleanup(1);
      },
    );
    probe.on("error", () => {
      // Port is free, proceed
      startMitm();
    });
    probe.setTimeout(500, () => {
      probe.destroy();
      startMitm();
    });
  }

  function startMitm(): void {
    const addonPath = mitmConfig.addonPath;
    console.log(
      "🔒 Starting mitmproxy (forward proxy for HTTPS interception)...",
    );
    mitmProcess = spawn(
      "mitmdump",
      [
        "-s",
        addonPath,
        "--quiet",
        "--listen-port",
        String(mitmConfig.port),
        ...mitmConfig.extraArgs,
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          CONTEXT_LENS_SOURCE: resolveLensSource(
            mitmConfig.lensSource,
            commandName,
          ),
          CONTEXT_LENS_SESSION_ID: resolveLensSessionId(
            mitmConfig.lensSessionId,
          ),
        },
      },
    );
    // Capture stderr so binding errors ("address already in use") are visible.
    let mitmStderr = "";
    if (mitmProcess.stderr) {
      mitmProcess.stderr.on("data", (chunk: Buffer) => {
        mitmStderr += chunk.toString();
      });
    }
    mitmProcess.on("error", (err) => {
      console.error("Failed to start mitmproxy:", err.message);
      console.error("Install it: pipx install mitmproxy");
      cleanup(1);
    });
    mitmProcess.on("exit", (code) => {
      if (!mitmReady) {
        const detail = mitmStderr.trim();
        if (detail) {
          console.error(`mitmproxy failed to start:\n${detail}`);
        } else {
          console.error("mitmproxy exited unexpectedly");
        }
        cleanup(code || 1);
      }
    });
    // Poll until mitmproxy is accepting connections
    const pollMitm = setInterval(() => {
      const socket = net.connect(
        { port: mitmConfig.port, host: "localhost" },
        () => {
          socket.end();
          if (!mitmReady) {
            mitmReady = true;
            clearInterval(pollMitm);
            console.log(`🔒 mitmproxy listening on port ${mitmConfig.port}`);
            startChild();
          }
        },
      );
      socket.on("error", () => {}); // not ready yet
      socket.setTimeout(500, () => socket.destroy());
    }, 200);
  }
  // Start the child command
  function startChild(): void {
    const launch = prepareChildLaunch({
      commandName,
      commandArguments,
      toolConfig,
      useMitm,
      sessionTag: randomBytes(4).toString("hex"),
      proxyUrl: CLI_CONSTANTS.PROXY_URL,
    });

    if (commandName) {
      console.log(
        `\n🚀 Launching: ${commandName} ${launch.allArgs.join(" ")}\n`,
      );
    }
    for (const warning of launch.warnings) {
      console.error(warning);
    }
    if (launch.mitmCertWarningPath) {
      warnIfMitmCertNotTrustedMacOs(launch.mitmCertWarningPath);
    }
    piAgentDirToCleanup = launch.piAgentDirToCleanup ?? null;
    brytiDataDirToCleanup = launch.brytiDataDirToCleanup ?? null;

    if (!commandName) {
      // We only get here when the user wants mitm but didn't specify a command.
      console.log("Press Ctrl+C to stop.");
      process.on("SIGINT", () => cleanup(0));
      process.on("SIGTERM", () => cleanup(0));
      return;
    }

    // Spawn the child process with inherited stdio and no shell. This avoids an
    // intermediate process that would break signal delivery.
    childProcess = spawn(launch.spawnCommand, launch.spawnArgs, {
      stdio: "inherit",
      env: launch.env,
    });

    childProcess.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        console.error(`\nFailed to start '${commandName}': command not found.`);
        if (commandName === "pi") {
          console.error(
            "Install pi: npm install -g @mariozechner/pi-coding-agent",
          );
          console.error(
            "Or run from its directory: context-lens -- node dist/cli.js",
          );
        } else {
          console.error(
            "Try a known tool (claude, codex, gemini, aider, pi) or use:",
          );
          console.error("  context-lens -- <your-command> [args...]");
        }
        cleanup(127);
        return;
      }
      console.error(`\nFailed to start ${commandName}:`, err.message);
      cleanup(1);
    });

    // When the child exits, clean up and mirror its exit code.
    childProcess.on("exit", (code, signal) => {
      cleanup(signal ? 128 + (signal === "SIGINT" ? 2 : 15) : code || 0);
    });

    // After 15 seconds, check whether the proxy has seen any traffic.
    // If not, print a one-time hint so the user knows something may be wrong.
    if (requiresAnalysis) {
      setTimeout(() => {
        if (cleanupDidRun) return;
        const req = http.get(
          `${CLI_CONSTANTS.UI_URL}/api/requests?summary=true`,
          { timeout: 2000 },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk: string) => {
              body += chunk;
            });
            res.on("end", () => {
              try {
                const data = JSON.parse(body);
                if (
                  Array.isArray(data.conversations) &&
                  data.conversations.length === 0
                ) {
                  console.error(
                    "\n⚠️  No API traffic captured yet. If the tool is running, it may not be routing through the proxy.",
                  );
                  if (toolConfig.needsMitm) {
                    console.error(
                      `   Check that ${commandName} is routing through mitmproxy (https_proxy=${mitmConfig.proxyUrl}).\n`,
                    );
                  } else {
                    console.error(
                      `   Check that ${commandName} is using the proxy URL (${CLI_CONSTANTS.PROXY_URL}).\n`,
                    );
                  }
                }
              } catch {}
            });
          },
        );
        req.on("error", () => {});
        req.on("timeout", () => req.destroy());
      }, 15_000);
    }
  }

  // On macOS, Codex uses rustls with native-roots (the system Keychain) and
  // completely ignores SSL_CERT_FILE. If the mitmproxy CA cert is not trusted
  // in the Keychain, Codex will fail to connect through mitmproxy with a
  // "stream disconnected before completion" error. Check and warn.
  function warnIfMitmCertNotTrustedMacOs(certPath: string): void {
    try {
      // `security verify-cert` exits 0 when the cert chain is trusted by macOS.
      const result = spawnSync("security", ["verify-cert", "-c", certPath], {
        stdio: "pipe",
      });
      if (result.status !== 0) {
        console.error(
          "\n⚠️  mitmproxy CA cert is not trusted in the macOS Keychain.",
        );
        console.error(
          "   Codex uses the system certificate store (not SSL_CERT_FILE).",
        );
        console.error("   Run this once to trust it, then retry:");
        console.error(
          `   sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${certPath}\n`,
        );
      }
    } catch {
      // Non-fatal: if 'security' isn't available, skip the check.
    }
  }

  // Open browser (cross-platform)
  function openBrowser(url: string): void {
    let cmd: string;
    let args: string[];

    if (platform() === "darwin") {
      cmd = "open";
      args = [url];
    } else if (platform() === "win32") {
      // `start` is a cmd.exe built-in, not a standalone executable.
      // Using `cmd /c start` works in all Windows shells including MSYS2/Git Bash.
      cmd = "cmd";
      args = ["/c", "start", url];
    } else {
      cmd = "xdg-open";
      args = [url];
    }

    const browserProcess = spawn(cmd, args, {
      stdio: "ignore",
      detached: true,
    });

    // Non-fatal: if the browser can't be opened, just continue.
    browserProcess.on("error", () => {});
    browserProcess.unref(); // Don't wait for browser to close
  }

  // Cleanup on exit
  function cleanup(exitCode: number): void {
    if (cleanupDidRun) return;
    cleanupDidRun = true;

    const remainingRefs = decrementLockRefCount();

    if (mitmProcess && !mitmProcess.killed) {
      mitmProcess.kill();
    }

    if (piAgentDirToCleanup) {
      try {
        fs.rmSync(piAgentDirToCleanup, { recursive: true, force: true });
      } catch (err: unknown) {
        console.error(
          "Warning: failed to clean up temporary Pi config dir:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    if (brytiDataDirToCleanup) {
      try {
        fs.rmSync(brytiDataDirToCleanup, { recursive: true, force: true });
      } catch (err: unknown) {
        console.error(
          "Warning: failed to clean up temporary Bryti data dir:",
          err instanceof Error ? err.message : String(err),
        );
      }
    }

    if (remainingRefs === 0 && shouldShutdownServers) {
      if (proxyProcess && !proxyProcess.killed) proxyProcess.kill();
      if (analysisProcess && !analysisProcess.killed) analysisProcess.kill();
    }

    process.exit(exitCode);
  }

  // Ignore SIGINT in the parent. Let it flow to the child (claude/codex) naturally.
  // The child handles Ctrl+C itself; when it eventually exits, cleanup runs via the 'exit' handler.
  process.on("SIGINT", () => {});

  // SIGTERM: external shutdown request, forward to child
  process.on("SIGTERM", () => {
    if (childProcess && !childProcess.killed) childProcess.kill("SIGTERM");
  });
}
