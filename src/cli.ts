#!/usr/bin/env node

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CLI_CONSTANTS,
  formatHelpText,
  getMitmConfig,
  getToolConfig,
  parseCliArgs,
} from "./cli-utils.js";
import { loadConfig } from "./config.js";
import { VERSION } from "./version.generated.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Known tool config: env vars for the child process, extra CLI args, server env vars, and whether mitmproxy is needed
// Note: actual tool config lives in cli-utils.ts so it can be unit-tested without importing this entrypoint.

function resolveLensSource(setting: string, commandName: string): string {
  if (setting === "commandName") return commandName;
  if (setting === "auto") return "";
  return setting; // fixed string
}

function resolveLensSessionId(setting: string): string {
  if (setting === "random") return randomBytes(4).toString("hex");
  if (setting === "none") return "";
  return setting; // fixed string
}
const LOCKFILE = "/tmp/context-lens.lock";

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
  CONTEXT_LENS_INGEST_URL: CLI_CONSTANTS.UI_URL + "/api/ingest",
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
    // if mitm is specified on the CLI or the tool always requires mitm we replace the normal reverse_proxy/forced provider urls with forward proxy redirection.
    toolConfig = {
      ...toolConfig,
      childEnv: {
        https_proxy: mitmConfig.proxyUrl,
        NPM_CONFIG_HTTPS_PROXY: mitmConfig.proxyUrl,
        WSS_PROXY: mitmConfig.proxyUrl,
        NODE_USE_ENV_PROXY: "1",

        //these are all filled in with the CA cert path
        SSL_CERT_FILE: "[CA_CERT_PATH]",
        NODE_EXTRA_CA_CERTS: "[CA_CERT_PATH]",
        REQUESTS_CA_BUNDLE: "[CA_CERT_PATH]",
      },
      needsMitm: true,
    };
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

  // Increment reference count in lockfile
  function incrementRefCount(): number {
    try {
      let count = 0;
      if (fs.existsSync(LOCKFILE)) {
        const data = fs.readFileSync(LOCKFILE, "utf8");
        count = parseInt(data, 10) || 0;
      }
      fs.writeFileSync(LOCKFILE, String(count + 1));
      return count + 1;
    } catch (err: unknown) {
      console.error(
        "Warning: failed to update lockfile:",
        err instanceof Error ? err.message : String(err),
      );
      return 1;
    }
  }

  // If the proxy isn't actually running but a lockfile exists, it's stale (e.g. prior crash).
  function clearStaleLockfile(): void {
    try {
      if (fs.existsSync(LOCKFILE)) fs.unlinkSync(LOCKFILE);
    } catch (err: unknown) {
      console.error(
        "Warning: failed to clear stale lockfile:",
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Decrement reference count in lockfile
  function decrementRefCount(): number {
    try {
      if (!fs.existsSync(LOCKFILE)) return 0;
      const data = fs.readFileSync(LOCKFILE, "utf8");
      const count = Math.max(0, (parseInt(data, 10) || 1) - 1);
      if (count === 0) {
        fs.unlinkSync(LOCKFILE);
      } else {
        fs.writeFileSync(LOCKFILE, String(count));
      }
      return count;
    } catch (err: unknown) {
      console.error(
        "Warning: failed to update lockfile:",
        err instanceof Error ? err.message : String(err),
      );
      return 0;
    }
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
      incrementRefCount();
      proxyReady = true;
      analysisReady = !requiresAnalysis || analysisAlreadyRunning;
      shouldShutdownServers = false;
      checkBothReady();
      return;
    }

    console.log("🔍 Starting Context Lens proxy and analysis server...");
    // Clear stale lockfile if servers aren't actually running
    if (!proxyAlreadyRunning) clearStaleLockfile();
    incrementRefCount();
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
        decrementRefCount();
        process.exit(1);
      });

      proxyProcess.on("exit", (code) => {
        if (!proxyReady) {
          console.error("Proxy exited unexpectedly");
          decrementRefCount();
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
        decrementRefCount();
        process.exit(1);
      });

      analysisProcess.on("exit", (code) => {
        if (!analysisReady) {
          console.error("Analysis server exited unexpectedly");
          decrementRefCount();
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
    mitmProcess.on("error", (err) => {
      console.error("Failed to start mitmproxy:", err.message);
      console.error("Install it: pipx install mitmproxy");
      cleanup(1);
    });
    mitmProcess.on("exit", (code) => {
      if (!mitmReady) {
        console.error("mitmproxy exited unexpectedly");
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
    // Inject extra args (e.g. codex -c chatgpt_base_url=...) before user args

    const allArgs = [...toolConfig.extraArgs, ...commandArguments];
    if (commandName) {
      console.log(`\n🚀 Launching: ${commandName} ${allArgs.join(" ")}\n`);
    }

    const childEnv = {
      ...process.env,
      ...toolConfig.childEnv,
    };

    // Embed a per-invocation session ID into proxy base URLs so that separate
    // CLI runs are always grouped into distinct conversations, even when they
    // start with identical prompts. The session ID is injected as a path
    // segment after the source tag, which extractSource() picks up as a
    // stable conversation key for the lifetime of this process.
    //
    // Format: http://localhost:4040/<source>/<session-id>/
    // Example: http://localhost:4040/gemini/a1b2c3d4/
    //
    // Codex uses mitmproxy and has its own chaining via previous_response_id.
    // Claude Code and Pi embed their own session IDs in request metadata.
    // Tools without built-in session IDs (Gemini, Aider, custom) rely on this.
    const sessionTag = randomBytes(4).toString("hex"); // 8 hex chars
    if (!toolConfig.needsMitm) {
      // For bryti, the proxy URL is baked into config.yml (not an env var),
      // so the session tag loop below won't reach it. Pass it to prepareBrytiDataDir
      // so it can embed the tag directly into the patched config.yml base_url.
      if (commandName === "bryti") {
        childEnv.BRYTI_DATA_DIR = prepareBrytiDataDir(
          childEnv.BRYTI_DATA_DIR,
          sessionTag,
        );
      }
      for (const key of Object.keys(childEnv)) {
        const val = childEnv[key];
        if (typeof val !== "string") continue;
        // Match any value that points at our proxy and ends with /<source> or /<source>/
        const proxyBase = `${CLI_CONSTANTS.PROXY_URL}/`;
        if (!val.startsWith(proxyBase)) continue;
        const hadTrailingSlash = val.endsWith("/");
        const after = val.slice(proxyBase.length).replace(/\/$/, "");
        // Only inject if the remaining path is just the source tag (no session already)
        if (after && !after.includes("/")) {
          const suffix = hadTrailingSlash ? "/" : "";
          childEnv[key] = `${proxyBase}${after}/${sessionTag}${suffix}`;
        }
      }
    }

    // Fill in mitmproxy CA cert path for tools that need HTTPS interception.
    // Any childEnv value set to "[CA_CERT_PATH]" is replaced with the actual path.
    if (toolConfig.needsMitm) {
      const certPath = join(homedir(), ".mitmproxy", "mitmproxy-ca-cert.pem");
      if (fs.existsSync(certPath)) {
        for (const key of Object.keys(childEnv)) {
          if (childEnv[key] === "[CA_CERT_PATH]") childEnv[key] = certPath;
        }
        // On macOS, Codex is compiled with rustls + native-roots, which reads
        // the system Keychain and ignores SSL_CERT_FILE entirely. If the cert
        // is not trusted in the Keychain, Codex cannot connect through mitmproxy.
        if (platform() === "darwin" && commandName === "codex") {
          warnIfMitmCertNotTrustedMacOs(certPath);
        }
      } else {
        console.error(
          `Warning: mitmproxy CA cert not found at ${certPath}. Run 'mitmdump' once to generate it.`,
        );
      }
    }

    if (commandName === "pi" && !useMitm) {
      childEnv.PI_CODING_AGENT_DIR = preparePiAgentDir(
        childEnv.PI_CODING_AGENT_DIR,
        sessionTag,
      );
    }

    if (!commandName) {
      //we only get here when the user wants mitm but didn't specify a command
      console.log("Press Ctrl+C to stop.");
      process.on("SIGINT", () => cleanup(0));
      process.on("SIGTERM", () => cleanup(0));
      return;
    }
    // For bryti: if dist/cli.js exists in cwd, use it directly (dev mode).
    // Otherwise fall back to the globally installed bryti binary.
    let spawnCommand = commandName;
    let spawnArgs = allArgs;
    if (
      commandName === "bryti" &&
      fs.existsSync(resolve(process.cwd(), "dist", "cli.js"))
    ) {
      spawnCommand = process.execPath; // node
      spawnArgs = [resolve(process.cwd(), "dist", "cli.js"), ...allArgs];
    }

    // Spawn the child process with inherited stdio (interactive)
    // No shell: true. Avoids intermediate process that breaks signal delivery
    childProcess = spawn(spawnCommand, spawnArgs, {
      stdio: "inherit",
      env: childEnv,
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

    // When the child exits (however it happens), clean up and mirror its exit code
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

  /**
   * Copy settings.json to the temp agent dir, resolving any relative package
   * paths to absolute paths so they remain valid from the temp location.
   */
  function rewriteSettingsWithAbsolutePaths(
    sourcePath: string,
    targetPath: string,
    sourceDir: string,
  ): void {
    try {
      const raw = fs.readFileSync(sourcePath, "utf8");
      const settings = JSON.parse(raw);
      if (
        settings &&
        typeof settings === "object" &&
        Array.isArray(settings.packages)
      ) {
        settings.packages = settings.packages.map((pkg: unknown) => {
          if (typeof pkg === "string") {
            return resolvePackagePath(pkg, sourceDir);
          }
          if (pkg && typeof pkg === "object" && "source" in pkg) {
            const obj = pkg as Record<string, unknown>;
            if (typeof obj.source === "string") {
              return {
                ...obj,
                source: resolvePackagePath(obj.source, sourceDir),
              };
            }
          }
          return pkg;
        });
      }
      fs.writeFileSync(targetPath, `${JSON.stringify(settings, null, 2)}\n`);
    } catch {
      // Fall back to symlinking if we can't parse/rewrite
      try {
        fs.symlinkSync(sourcePath, targetPath);
      } catch {}
    }
  }

  /**
   * Resolve a package path to absolute if it is a relative filesystem path.
   * Leaves URLs, npm specifiers (name@version), and already-absolute paths unchanged.
   */
  function resolvePackagePath(pkg: string, baseDir: string): string {
    // Skip tilde paths (pi resolves these against homedir, not baseDir)
    if (pkg.startsWith("~")) return pkg;
    // Skip URLs and npm/git specifiers
    if (/^(https?:|git[@+:]|npm:|github:)/.test(pkg)) return pkg;
    // Skip what looks like a bare npm package name (no slashes or starts with @scope/)
    if (/^@?[a-z0-9][\w.-]*$/i.test(pkg) || /^@[\w.-]+\/[\w.-]+/.test(pkg))
      return pkg;
    // If it's already absolute, leave it
    if (isAbsolute(pkg)) return pkg;
    // Relative path: resolve against the original agent dir
    return resolve(baseDir, pkg);
  }

  function preparePiAgentDir(
    targetDirEnv: string | undefined,
    sessionTag?: string,
  ): string {
    const dirPrefix =
      targetDirEnv && targetDirEnv.length > 0
        ? targetDirEnv
        : join(tmpdir(), "context-lens-pi-agent-");
    const targetDir = fs.mkdtempSync(dirPrefix);
    const homeDir = process.env.HOME || "";
    const sourceDir = join(homeDir, ".pi", "agent");
    const sourceModelsPath = join(sourceDir, "models.json");
    const targetModelsPath = join(targetDir, "models.json");

    try {
      // Keep temp agent dir private to this user.
      fs.chmodSync(targetDir, 0o700);
      piAgentDirToCleanup = targetDir;

      if (fs.existsSync(sourceDir)) {
        for (const entry of fs.readdirSync(sourceDir, {
          withFileTypes: true,
        })) {
          if (entry.name === "models.json") continue;
          // settings.json needs special handling: relative package paths
          // must be resolved against the real agent dir, not the temp dir.
          if (entry.name === "settings.json") {
            rewriteSettingsWithAbsolutePaths(
              join(sourceDir, entry.name),
              join(targetDir, entry.name),
              sourceDir,
            );
            continue;
          }
          const src = join(sourceDir, entry.name);
          const dst = join(targetDir, entry.name);
          fs.symlinkSync(src, dst);
        }
      }

      let modelsConfig: Record<string, unknown> = {};
      if (fs.existsSync(sourceModelsPath)) {
        try {
          const parsed = JSON.parse(fs.readFileSync(sourceModelsPath, "utf8"));
          if (parsed && typeof parsed === "object") {
            modelsConfig = parsed as Record<string, unknown>;
          }
        } catch {
          console.error(
            "Warning: ~/.pi/agent/models.json is not valid JSON; using proxy-only overrides",
          );
        }
      }

      const providers =
        modelsConfig.providers &&
        typeof modelsConfig.providers === "object" &&
        !Array.isArray(modelsConfig.providers)
          ? { ...(modelsConfig.providers as Record<string, unknown>) }
          : {};

      const proxyBaseUrl = sessionTag
        ? `${CLI_CONSTANTS.PROXY_URL}/pi/${sessionTag}`
        : `${CLI_CONSTANTS.PROXY_URL}/pi`;

      // These upstreams are natively understood by the proxy — no target
      // override needed, the proxy routes them correctly by path/format.
      const nativeUpstreams = new Set([
        "https://api.anthropic.com",
        "https://api.openai.com",
        "https://generativelanguage.googleapis.com",
        "https://cloudcode-pa.googleapis.com",
        "https://us-central1-aiplatform.googleapis.com",
      ]);

      // Rewrite every provider that has an external baseUrl, regardless of its
      // key name. For providers whose upstream isn't natively known to the proxy,
      // stash the real URL as x-target-url so the proxy forwards correctly.
      for (const [key, value] of Object.entries(providers)) {
        if (!value || typeof value !== "object" || Array.isArray(value))
          continue;
        const provider = value as Record<string, unknown>;
        const originalBaseUrl =
          typeof provider.baseUrl === "string" ? provider.baseUrl : null;

        // Skip providers with no baseUrl or a local/relative URL
        if (!originalBaseUrl || !originalBaseUrl.startsWith("http")) continue;
        // Skip providers already pointing at the proxy
        if (originalBaseUrl.startsWith("http://localhost")) continue;

        const needsTargetOverride = !nativeUpstreams.has(
          originalBaseUrl.replace(/\/$/, ""),
        );

        const existingHeaders =
          provider.headers &&
          typeof provider.headers === "object" &&
          !Array.isArray(provider.headers)
            ? (provider.headers as Record<string, string>)
            : {};

        providers[key] = {
          ...provider,
          baseUrl: proxyBaseUrl,
          ...(needsTargetOverride
            ? {
                headers: {
                  ...existingHeaders,
                  "x-target-url": originalBaseUrl,
                },
              }
            : {}),
        };
      }

      // The old code explicitly wrote "anthropic" unconditionally; the rewrite
      // in 83225d2 switched to iterating existing providers, which dropped this.
      // Pi uses the built-in anthropic provider by default and it may not appear
      // in models.json at all, so we must always inject it.
      if (!providers.anthropic) {
        providers.anthropic = {
          baseUrl: proxyBaseUrl,
          api: "anthropic-messages",
        };
      } else {
        const ap = providers.anthropic as Record<string, unknown>;
        if (!String(ap.baseUrl ?? "").startsWith("http://localhost")) {
          providers.anthropic = { ...ap, baseUrl: proxyBaseUrl };
        }
      }

      fs.writeFileSync(
        targetModelsPath,
        `${JSON.stringify({ ...modelsConfig, providers }, null, 2)}\n`,
      );
      return targetDir;
    } catch (err: unknown) {
      console.error(
        "Warning: failed to prepare Pi proxy config:",
        err instanceof Error ? err.message : String(err),
      );
      return targetDir;
    }
  }

  /**
   * Create a temporary Bryti data directory with a proxy-aware config.yml.
   *
   * Bryti reads base_url for each model provider from its config.yml and does
   * not respect environment variable overrides. We copy the real config (from
   * the original BRYTI_DATA_DIR or ./data) into a temp dir, rewriting every
   * provider's base_url to point at the context-lens proxy, then set
   * BRYTI_DATA_DIR to the temp dir so Bryti picks up the patched config.
   *
   * The original config is never modified. The temp dir is cleaned up on exit.
   *
   * State dirs (users, history, logs, etc.) are symlinked into the temp dir so
   * bryti's runtime writes go back to the real data dir.
   *
   * The .pi dir is NOT symlinked: bryti regenerates .pi/settings.json on every
   * startup (via ensureDataDirs/writeExtensionSettings), which would append the
   * temp extensions path to the real settings.json and cause duplicate tool
   * registrations on the next run. Instead we copy .pi into the temp dir so
   * bryti reads existing auth/models from there but writes only to temp.
   *
   * files/ is NOT symlinked for the same reason: bryti's writeExtensionSettings
   * would register both the real and temp extensions paths, loading each
   * extension twice and causing tool conflict errors.
   *
   * If no config.yml is found in the source data dir, we warn and fall back to
   * the temp dir without a config patch (bryti will error on its own).
   */
  function prepareBrytiDataDir(
    targetDirEnv: string | undefined,
    sessionTag: string,
  ): string {
    const dirPrefix =
      targetDirEnv && targetDirEnv.length > 0
        ? targetDirEnv
        : join(tmpdir(), "context-lens-bryti-");
    const targetDir = fs.mkdtempSync(dirPrefix);
    brytiDataDirToCleanup = targetDir;

    // Find the real bryti data dir: check BRYTI_DATA_DIR in current env (before
    // our override) or fall back to ./data relative to cwd.
    const realDataDir = resolve(
      process.env.BRYTI_DATA_DIR || join(process.cwd(), "data"),
    );
    const sourceConfigPath = join(realDataDir, "config.yml");

    try {
      if (!fs.existsSync(sourceConfigPath)) {
        console.error(
          `Warning: no Bryti config.yml found at ${sourceConfigPath}. ` +
            "Bryti will start without a proxy-patched config.",
        );
        return targetDir;
      }

      const raw = fs.readFileSync(sourceConfigPath, "utf-8");

      // Patch every `base_url:` value in the YAML that looks like an HTTP(S)
      // URL (or is empty, meaning default Anthropic). We replace all provider
      // base URLs with the proxy URL so all traffic is captured.
      //
      // We do a targeted line-level rewrite rather than full YAML parse+emit to
      // avoid disturbing formatting, comments, or env-var substitution markers
      // (${VAR}) that would fail a raw parse before substitution.
      // Include the session tag in the proxy URL so all requests from this
      // bryti invocation share a stable conversation ID in context-lens.
      const proxyBase = `${CLI_CONSTANTS.PROXY_URL}/bryti/${sessionTag}`;
      const patched = raw
        .split("\n")
        .map((line) => {
          // Match lines like:  base_url: "..." or  base_url: ''  or  base_url:
          // Only rewrite lines that are clearly provider base_url fields.
          const m = line.match(/^(\s*base_url:\s*)(.*)$/);
          if (!m) return line;
          // Preserve the indent + key, replace the value
          return `${m[1]}"${proxyBase}"`;
        })
        .join("\n");

      const targetConfigPath = join(targetDir, "config.yml");
      fs.writeFileSync(targetConfigPath, patched, "utf-8");

      // Symlink state dirs that should persist back to the real data dir.
      // Exclude config.yml (patched above), .pi (copied below), and files/
      // (both contain paths that bryti writes into settings.json on startup,
      // which would corrupt the real settings with temp dir paths).
      const SYMLINK_ENTRIES = [
        "users",
        "history",
        "logs",
        "pending",
        "skills",
        "usage",
        "whatsapp-auth",
        "core-memory.md",
        "sessions",
        "extensions",
      ];
      for (const name of SYMLINK_ENTRIES) {
        const src = join(realDataDir, name);
        if (!fs.existsSync(src)) continue;
        const dst = join(targetDir, name);
        try {
          fs.symlinkSync(src, dst);
        } catch {
          // Non-fatal
        }
      }

      // Copy .pi into the temp dir so bryti reads existing auth/models.json
      // but all writes (including settings.json rewrites) stay in temp.
      const realPiDir = join(realDataDir, ".pi");
      const tempPiDir = join(targetDir, ".pi");
      if (fs.existsSync(realPiDir)) {
        fs.mkdirSync(tempPiDir, { recursive: true });
        for (const entry of fs.readdirSync(realPiDir, {
          withFileTypes: true,
        })) {
          const src = join(realPiDir, entry.name);
          const dst = join(tempPiDir, entry.name);
          try {
            if (entry.isDirectory()) {
              fs.symlinkSync(src, dst);
            } else {
              fs.copyFileSync(src, dst);
            }
          } catch {
            // Non-fatal
          }
        }
      }

      return targetDir;
    } catch (err: unknown) {
      console.error(
        "Warning: failed to prepare Bryti proxy config:",
        err instanceof Error ? err.message : String(err),
      );
      return targetDir;
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

    const remainingRefs = decrementRefCount();

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

interface UpdateCheckCache {
  checkedAt: number;
  latestVersion: string;
}

interface BackgroundState {
  proxyPid: number;
  analysisPid: number | null;
  noUi: boolean;
  startedAt: string;
}

function getBackgroundStatePath(): string {
  return join(homedir(), ".context-lens", "background.json");
}

function ensureContextLensDir(): void {
  fs.mkdirSync(join(homedir(), ".context-lens"), { recursive: true });
}

function readBackgroundState(): BackgroundState | null {
  try {
    const raw = fs.readFileSync(getBackgroundStatePath(), "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.proxyPid === "number" &&
      (typeof parsed.analysisPid === "number" || parsed.analysisPid === null) &&
      typeof parsed.noUi === "boolean" &&
      typeof parsed.startedAt === "string"
    ) {
      return parsed as BackgroundState;
    }
  } catch {}
  return null;
}

function writeBackgroundState(state: BackgroundState): void {
  ensureContextLensDir();
  fs.writeFileSync(
    getBackgroundStatePath(),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

function clearBackgroundState(): void {
  try {
    fs.unlinkSync(getBackgroundStatePath());
  } catch {}
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isBackgroundRunning(state: BackgroundState): boolean {
  const proxyAlive = isPidAlive(state.proxyPid);
  const analysisAlive =
    state.analysisPid == null || isPidAlive(state.analysisPid);
  return proxyAlive && analysisAlive;
}

function parseBackgroundArgs(
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

async function runBackgroundCommand(
  args: string[],
  globalNoUi: boolean,
): Promise<number> {
  const parsed = parseBackgroundArgs(args, globalNoUi);
  if ("error" in parsed) {
    console.error(parsed.error);
    return 1;
  }
  if (parsed.action === "status") {
    return backgroundStatus();
  }
  if (parsed.action === "stop") {
    return backgroundStop();
  }
  return backgroundStart(parsed.noUi);
}

function backgroundStatus(): number {
  const state = readBackgroundState();
  if (!state) {
    console.log("Background status: not running");
    return 0;
  }
  const running = isBackgroundRunning(state);
  if (!running) {
    console.log("Background status: stale state found (not running)");
    clearBackgroundState();
    return 0;
  }
  console.log("Background status: running");
  console.log(`  proxy pid: ${state.proxyPid}`);
  if (state.analysisPid != null) {
    console.log(`  analysis pid: ${state.analysisPid}`);
  } else {
    console.log("  analysis: disabled (--no-ui)");
  }
  console.log(`  started: ${state.startedAt}`);
  return 0;
}

function backgroundStop(): number {
  const state = readBackgroundState();
  if (!state) {
    console.log("Background status: not running");
    return 0;
  }

  const pids = [state.proxyPid, state.analysisPid].filter(
    (pid): pid is number => pid != null,
  );
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
  }
  clearBackgroundState();
  console.log("Background services stopped.");
  return 0;
}

async function backgroundStart(noUi: boolean): Promise<number> {
  const existing = readBackgroundState();
  if (existing && isBackgroundRunning(existing)) {
    console.log("Background status: already running");
    console.log(`  proxy pid: ${existing.proxyPid}`);
    return 0;
  }
  if (existing) clearBackgroundState();

  const proxyPath = join(__dirname, "proxy", "server.js");
  const proxyEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    CONTEXT_LENS_CLI: "1",
    ...(noUi ? {} : { CONTEXT_LENS_ANALYSIS_URL: CLI_CONSTANTS.UI_URL }),
  };
  const proxy = spawn("node", [proxyPath], {
    stdio: "ignore",
    detached: true,
    env: proxyEnv,
  });
  proxy.unref();

  let analysis: ChildProcess | null = null;
  if (!noUi) {
    const analysisPath = join(__dirname, "analysis", "server.js");
    analysis = spawn("node", [analysisPath], {
      stdio: "ignore",
      detached: true,
      env: { ...process.env, CONTEXT_LENS_CLI: "1" },
    });
    analysis.unref();
  }

  // Give children a brief chance to fail immediately (e.g. command not found).
  await new Promise((resolve) => setTimeout(resolve, 150));

  const proxyPid = proxy.pid ?? 0;
  const analysisPid = analysis?.pid ?? null;
  if (!proxyPid || !isPidAlive(proxyPid)) {
    console.error("Failed to start proxy in background.");
    return 1;
  }
  if (analysisPid != null && !isPidAlive(analysisPid)) {
    console.error("Failed to start analysis server in background.");
    try {
      process.kill(proxyPid, "SIGTERM");
    } catch {}
    return 1;
  }

  writeBackgroundState({
    proxyPid,
    analysisPid,
    noUi,
    startedAt: new Date().toISOString(),
  });

  console.log("Background services started.");
  console.log(`  proxy: ${CLI_CONSTANTS.PROXY_URL} (pid ${proxyPid})`);
  if (analysisPid != null) {
    console.log(
      `  analysis/web UI: ${CLI_CONSTANTS.UI_URL} (pid ${analysisPid})`,
    );
  } else {
    console.log("  analysis/web UI: disabled (--no-ui)");
  }
  return 0;
}

async function isPortListening(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = net.connect({ port, host: "localhost" }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(700, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function findBinaryOnPath(binary: string): string | null {
  const pathValue = process.env.PATH || "";
  const dirs = pathValue.split(":").filter(Boolean);
  for (const dir of dirs) {
    const full = join(dir, binary);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

function checkWritableDir(targetDir: string): boolean {
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.accessSync(targetDir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function runAnalyze(args: string[]): Promise<number> {
  // Lazy import to avoid loading analysis code unless needed
  const { readLharFile } = await import("./lhar.js");
  const { analyzeSession, formatSessionAnalysis } = await import("./core.js");

  // Parse analyze-specific arguments
  let filepath: string | undefined;
  let outputJson = false;
  let mainOnly = false;
  let showPath = true;
  let compositionArg: string | undefined;

  for (const arg of args) {
    if (arg === "--json") {
      outputJson = true;
    } else if (arg === "--main-only") {
      mainOnly = true;
    } else if (arg === "--no-path") {
      showPath = false;
    } else if (arg.startsWith("--composition=")) {
      compositionArg = arg.split("=", 1 + 1)[1];
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage: context-lens analyze <session.lhar> [options]",
          "",
          "Analyze an LHAR session file and print detailed statistics.",
          "",
          "Options:",
          "  --json                    Output as JSON",
          "  --no-path                 Omit agent path trace",
          "  --main-only               Only analyze main agent entries",
          "  --composition=last        Composition of last entry (default)",
          "  --composition=pre-compaction  Composition before each compaction",
          "  --composition=N           Composition at end of user turn N",
        ].join("\n"),
      );
      return 0;
    } else if (!arg.startsWith("-")) {
      filepath = arg;
    } else {
      console.error(`Unknown option: ${arg}`);
      return 1;
    }
  }

  if (!filepath) {
    console.error(
      "Error: no session file specified. Usage: context-lens analyze <session.lhar>",
    );
    return 1;
  }

  // Resolve filepath: try as-is, then in ~/.context-lens/data/, then in ./data/
  let resolvedPath = filepath;
  if (!fs.existsSync(resolvedPath)) {
    const homeData = join(homedir(), ".context-lens", "data", filepath);
    const localData = join("data", filepath);
    if (fs.existsSync(homeData)) {
      resolvedPath = homeData;
    } else if (fs.existsSync(localData)) {
      resolvedPath = localData;
    } else {
      console.error(`Error: file not found: ${filepath}`);
      console.error(`  Searched: ${filepath}, ${homeData}, ${localData}`);
      return 1;
    }
  }

  try {
    const { session, entries } = readLharFile(resolvedPath);
    const basename = resolvedPath.split("/").pop() || resolvedPath;
    const analysis = analyzeSession(session, entries, basename, { mainOnly });

    if (outputJson) {
      console.log(JSON.stringify(analysis, null, 2));
    } else {
      const output = formatSessionAnalysis(analysis, {
        showPath,
        composition: compositionArg,
        entries,
      });
      console.log(output);
    }
    return 0;
  } catch (err: unknown) {
    console.error(
      `Error analyzing ${resolvedPath}:`,
      err instanceof Error ? err.message : String(err),
    );
    return 1;
  }
}

async function runDoctor(): Promise<number> {
  let hasFailures = false;
  function report(name: string, ok: boolean, detail: string): void {
    const mark = ok ? "OK" : "FAIL";
    console.log(`[${mark}] ${name}: ${detail}`);
    if (!ok) hasFailures = true;
  }
  function info(name: string, detail: string): void {
    console.log(`[INFO] ${name}: ${detail}`);
  }

  console.log(`Context Lens doctor v${VERSION}`);

  report("node", true, process.version);

  const proxyListening = await isPortListening(CLI_CONSTANTS.PROXY_PORT);
  report(
    `proxy port :${CLI_CONSTANTS.PROXY_PORT}`,
    true,
    proxyListening ? "already running" : "available/not running",
  );

  const analysisListening = await isPortListening(CLI_CONSTANTS.UI_PORT);
  report(
    `analysis port :${CLI_CONSTANTS.UI_PORT}`,
    true,
    analysisListening ? "already running" : "available/not running",
  );

  // mitmproxy is only needed for Codex subscription mode, so report as
  // informational rather than a hard failure.
  const mitmdumpPath = findBinaryOnPath("mitmdump");
  info(
    "mitmdump (Codex, pi --mitm)",
    mitmdumpPath ?? "not found (install: pipx install mitmproxy)",
  );

  const certPath = join(homedir(), ".mitmproxy", "mitmproxy-ca-cert.pem");
  const certExists = fs.existsSync(certPath);
  info(
    "mitm CA cert (Codex, pi --mitm)",
    certExists ? certPath : "not present (run 'mitmdump' once to generate)",
  );
  if (certExists && platform() === "darwin") {
    try {
      const result = spawnSync("security", ["verify-cert", "-c", certPath], {
        stdio: "pipe",
      });
      info(
        "mitm CA cert trusted in macOS Keychain",
        result.status === 0
          ? "yes"
          : `NO — Codex will fail. Fix: sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ${certPath}`,
      );
    } catch {
      // Non-fatal.
    }
  }

  const contextDir = join(homedir(), ".context-lens");
  const dataDir = join(contextDir, "data");
  report("context dir writable", checkWritableDir(contextDir), contextDir);
  report("data dir writable", checkWritableDir(dataDir), dataDir);

  const bg = readBackgroundState();
  if (!bg) {
    report("background state", true, "not running");
  } else {
    report(
      "background state",
      isBackgroundRunning(bg),
      isBackgroundRunning(bg) ? "running" : "stale state file",
    );
  }

  const lockfileExists = fs.existsSync(LOCKFILE);
  report(
    "lockfile",
    true,
    lockfileExists ? `${LOCKFILE} present` : `${LOCKFILE} absent`,
  );

  const configPath = join(homedir(), ".context-lens", "config.toml");
  const configExists = fs.existsSync(configPath);
  info(
    "config file",
    configExists
      ? configPath
      : `not present — create ${configPath} to set defaults`,
  );
  if (configExists) {
    const cfg = loadConfig();
    if (cfg.proxy.redact) info("config: redact", cfg.proxy.redact);
    if (cfg.proxy.rehydrate) info("config: rehydrate", "true");
    if (cfg.ui.noOpen) info("config: no_open", "true");
    if (cfg.privacy.level) info("config: privacy", cfg.privacy.level);
  }

  if (hasFailures) {
    console.log("Doctor result: issues found.");
    return 1;
  }
  console.log("Doctor result: all checks passed.");
  return 0;
}

function checkForUpdate(currentVersion: string): void {
  const cachePath = join(homedir(), ".context-lens", "update-check.json");
  const dayMs = 24 * 60 * 60 * 1000;
  let cached: UpdateCheckCache | null = null;
  try {
    const raw = fs.readFileSync(cachePath, "utf8");
    const parsed = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.checkedAt === "number" &&
      typeof parsed.latestVersion === "string"
    ) {
      cached = parsed as UpdateCheckCache;
    }
  } catch {}

  if (cached && Date.now() - cached.checkedAt < dayMs) {
    if (isNewerVersion(cached.latestVersion, currentVersion)) {
      printUpdateNotice(currentVersion, cached.latestVersion);
    }
    return;
  }

  const req = https.get(
    "https://registry.npmjs.org/context-lens/latest",
    { timeout: 1500 },
    (res) => {
      if (res.statusCode !== 200) return;
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        try {
          const parsed = JSON.parse(body) as { version?: string };
          if (!parsed.version) return;
          const latestVersion = parsed.version;
          try {
            fs.mkdirSync(join(homedir(), ".context-lens"), {
              recursive: true,
            });
            fs.writeFileSync(
              cachePath,
              `${JSON.stringify(
                { checkedAt: Date.now(), latestVersion },
                null,
                2,
              )}\n`,
            );
          } catch {}
          if (isNewerVersion(latestVersion, currentVersion)) {
            printUpdateNotice(currentVersion, latestVersion);
          }
        } catch {}
      });
    },
  );
  req.on("error", () => {});
  req.on("timeout", () => req.destroy());
}

function isNewerVersion(candidate: string, current: string): boolean {
  const a = splitSemver(candidate);
  const b = splitSemver(current);
  for (let i = 0; i < 3; i++) {
    if (a[i] > b[i]) return true;
    if (a[i] < b[i]) return false;
  }
  return false;
}

function splitSemver(version: string): [number, number, number] {
  const [major, minor, patch] = version.split(".", 3).map((part) => {
    const parsed = Number.parseInt(part.replace(/[^0-9].*$/, ""), 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  return [major ?? 0, minor ?? 0, patch ?? 0];
}

function printUpdateNotice(
  currentVersion: string,
  latestVersion: string,
): void {
  console.error(
    `\nUpdate available: context-lens ${currentVersion} -> ${latestVersion}`,
  );
  console.error("Run: npm install -g context-lens");
  console.error(
    "Skip this check: --no-update-check or CONTEXT_LENS_NO_UPDATE_CHECK=1\n",
  );
}
