import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { preflightCapture } from "./mitm-preflight.js";

const CLI_PATH = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

// Only options with known arity can be separated safely from initial prompts.
const VALUE_OPTIONS = new Set([
  "-e",
  "--extension",
  "-t",
  "--tools",
  "-xt",
  "--exclude-tools",
  "--models",
  "--api-key",
  "--system-prompt",
  "--append-system-prompt",
  "--skill",
  "--prompt-template",
  "--theme",
  "--use-theme",
  "--tui-mode",
  "--session-dir",
]);
const BOOLEAN_OPTIONS = new Set([
  "-nt",
  "--no-tools",
  "-nbt",
  "--no-builtin-tools",
  "-ne",
  "--no-extensions",
  "--no-mcp",
  "-ns",
  "--no-skills",
  "-np",
  "--no-prompt-templates",
  "--no-themes",
  "-nc",
  "--no-context-files",
  "-a",
  "--approve",
  "-na",
  "--no-approve",
  "--offline",
  "--verbose",
]);
const REPLACED_OPTIONS = new Set([
  "--session",
  "--session-id",
  "--fork",
  "-n",
  "--name",
  "--provider",
  "--model",
  "--thinking",
]);

/** Preserve invocation configuration, never initial prompts or one-shot modes. */
function resumeOptions(args) {
  const preserved = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      break;
    }
    if (!arg.startsWith("-")) {
      continue;
    }
    if (["-c", "--continue", "-r", "--resume"].includes(arg)) {
      continue;
    }
    if (BOOLEAN_OPTIONS.has(arg)) {
      preserved.push(arg);
      continue;
    }
    if (
      VALUE_OPTIONS.has(arg) ||
      REPLACED_OPTIONS.has(arg) ||
      arg === "--mode"
    ) {
      const value = args[++i];
      if (value === undefined || (arg === "--mode" && value !== "text")) {
        throw new Error(
          "Cannot safely resume this Pi invocation. Start Pi interactively with the same configuration through context-lens --mitm -- PI_LAUNCHER.",
        );
      }
      if (VALUE_OPTIONS.has(arg)) {
        preserved.push(arg, value);
      }
      continue;
    }
    // Unknown extension flags may control permissions. Never silently drop them.
    throw new Error(
      "Unsupported Pi option. Start Pi with the same options through context-lens --mitm -- PI_LAUNCHER instead; automatic restart cannot safely preserve this invocation.",
    );
  }
  return preserved;
}

/** Register /context-lens without starting capture until the command is used. */
export default function contextLens(
  pi,
  runtime = process,
  preflight = preflightCapture,
) {
  let restarting = false;
  const invocationCwd = runtime.cwd();
  const invocationArgv = [...runtime.argv];
  const invocationExecArgv = [...runtime.execArgv];

  pi.registerCommand("context-lens", {
    description: "Resume this session with Context Lens HTTPS capture",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("Usage: /context-lens", "warning");
        return;
      }
      if (runtime.env.CONTEXT_LENS_ACTIVE === "1") {
        ctx.ui.notify(
          "This Pi process is already running through Context Lens.",
          "info",
        );
        return;
      }
      if (restarting) {
        return;
      }
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/context-lens requires interactive Pi.", "error");
        return;
      }
      if (
        runtime.platform === "win32" ||
        typeof runtime.execve !== "function"
      ) {
        ctx.ui.notify(
          "Automatic restart requires Linux or macOS with Node.js 22.23.4 or newer.",
          "error",
        );
        return;
      }
      if (!ctx.isIdle()) {
        ctx.ui.notify(
          "Wait for Pi to finish before running /context-lens.",
          "warning",
        );
        return;
      }
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        ctx.ui.notify(
          "This session has no saved session file to resume.",
          "error",
        );
        return;
      }
      restarting = true;
      let options;
      try {
        const launcher = invocationArgv[1];
        if (
          !launcher ||
          !isAbsolute(launcher) ||
          invocationExecArgv.length ||
          ctx.cwd !== invocationCwd
        ) {
          throw new Error(
            "Cannot safely preserve this Pi launcher or working directory. Resume manually using the same launcher and options through context-lens --mitm -- PI_LAUNCHER.",
          );
        }
        try {
          accessSync(runtime.execPath, constants.X_OK);
          accessSync(launcher, constants.R_OK);
          if (
            !/\.[cm]?js$/.test(realpathSync(launcher)) ||
            !statSync(runtime.execPath).isFile() ||
            !statSync(launcher).isFile()
          ) {
            throw new Error("Not a file");
          }
        } catch {
          throw new Error(
            "The current Node executable or Pi launcher is missing, inaccessible, or not a supported JavaScript launcher. Restore it or resume manually with the same options through context-lens --mitm -- PI_LAUNCHER. Pi has not been shut down.",
          );
        }
        options = resumeOptions(invocationArgv.slice(2));
        accessSync(sessionFile, constants.R_OK);
        accessSync(CLI_PATH, constants.R_OK);
        const result = await pi.exec("mitmdump", ["--version"], {
          timeout: 10000,
        });
        if (result.code !== 0) {
          throw new Error("mitmdump is unavailable. Install mitmproxy first.");
        }
        await preflight();
        if (
          !ctx.isIdle() ||
          ctx.cwd !== invocationCwd ||
          ctx.sessionManager.getSessionFile() !== sessionFile
        ) {
          throw new Error(
            "The session changed while checking mitmproxy. Try again when idle.",
          );
        }
      } catch (error) {
        restarting = false;
        ctx.ui.notify(
          `Cannot restart with Context Lens: ${error.message}`,
          "error",
        );
        return;
      }

      const argv = [
        runtime.execPath,
        CLI_PATH,
        "--mitm",
        "--",
        runtime.execPath,
        invocationArgv[1],
        ...options,
        "--session",
        sessionFile,
      ];
      if (ctx.model) {
        argv.push("--provider", ctx.model.provider, "--model", ctx.model.id);
      }
      argv.push("--thinking", pi.getThinkingLevel());
      const cwd = ctx.cwd;
      const env = Object.fromEntries(
        Object.entries(runtime.env).filter(([, value]) => value !== undefined),
      );
      env.CONTEXT_LENS_ACTIVE = "1";

      // Replace Pi only after its shutdown hooks and terminal cleanup have run.
      // Keeping the PID avoids racing the parent shell for terminal input.
      runtime.once("exit", (code) => {
        if (code !== 0) {
          return;
        }
        try {
          runtime.chdir(cwd);
          runtime.execve(runtime.execPath, argv, env);
        } catch (error) {
          runtime.exitCode = 1;
          console.error(`Context Lens restart failed: ${error.message}`);
          console.error(
            `Resume the saved session ${JSON.stringify(sessionFile)} manually with the same Pi launcher and options through context-lens --mitm -- PI_LAUNCHER.`,
          );
        }
      });
      ctx.shutdown();
    },
  });
}
