import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import { homedir, platform } from "node:os";
import { delimiter, join } from "node:path";

import { CLI_CONSTANTS } from "../cli-utils.js";
import { loadConfig } from "../config.js";
import { VERSION } from "../version.generated.js";
import { isBackgroundRunning, readBackgroundState } from "./background.js";

export async function isPortListening(port: number): Promise<boolean> {
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

export function findBinaryOnPath(
  binary: string,
  pathValue = process.env.PATH || "",
  exists: (path: string) => boolean = fs.existsSync,
): string | null {
  const dirs = pathValue.split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    const full = join(dir, binary);
    if (exists(full)) return full;
  }
  return null;
}

export function checkWritableDir(targetDir: string): boolean {
  try {
    fs.mkdirSync(targetDir, { recursive: true });
    fs.accessSync(targetDir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(
  lockfile = "/tmp/context-lens.lock",
): Promise<number> {
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
    } catch {}
  }

  const contextDir = join(homedir(), ".context-lens");
  const dataDir = join(contextDir, "data");
  report("context dir writable", checkWritableDir(contextDir), contextDir);
  report("data dir writable", checkWritableDir(dataDir), dataDir);

  const bg = readBackgroundState();
  if (!bg) {
    report("background state", true, "not running");
  } else {
    const bgRunning = isBackgroundRunning(bg);
    report(
      "background state",
      bgRunning,
      bgRunning ? "running" : "stale state file",
    );
  }

  const lockfileExists = fs.existsSync(lockfile);
  report(
    "lockfile",
    true,
    lockfileExists ? `${lockfile} present` : `${lockfile} absent`,
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
