import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Never load or reset a developer's captures while running browser tests.
const dir = mkdtempSync(path.join(tmpdir(), "context-lens-e2e-"));
const entrypoint = fileURLToPath(
  new URL("../dist/analysis/server.js", import.meta.url),
);
const server = spawn(process.execPath, [entrypoint], {
  stdio: "inherit",
  env: {
    ...process.env,
    CONTEXT_LENS_BIND_HOST: "127.0.0.1",
    CONTEXT_LENS_ANALYSIS_PORT: "14042",
    CONTEXT_LENS_CAPTURE_DIR: path.join(dir, "captures"),
    CONTEXT_LENS_DATA_DIR: path.join(dir, "data"),
    CONTEXT_LENS_PRIVACY: "standard",
    CONTEXT_LENS_MAX_SESSIONS: "200",
    CONTEXT_LENS_MAX_COMPACT_MESSAGES: "60",
  },
});

process.on("SIGINT", () => server.kill("SIGINT"));
process.on("SIGTERM", () => server.kill("SIGTERM"));
server.on("error", (error) => {
  console.error(error);
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = 1;
});
server.on("exit", (code) => {
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = code ?? 1;
});
