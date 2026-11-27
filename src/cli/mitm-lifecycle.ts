import { type ChildProcess, spawn } from "node:child_process";
import net from "node:net";

/** Isolate MITM from terminal interrupts while retaining readiness pipes and exit cleanup. */
export function spawnMitmProcess(
  args: string[],
  env: NodeJS.ProcessEnv,
  command = "mitmdump",
): ChildProcess {
  const child = spawn(command, args, {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  const stopOnExit = () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }
  };
  process.once("exit", stopOnExit);
  const removeExitHook = () => {
    process.removeListener("exit", stopOnExit);
  };
  child.once("exit", removeExitHook);
  child.once("error", removeExitHook);
  return child;
}

/** Check binding, not just connection refusal, before launching any capture servers. */
export async function assertMitmPortAvailable(port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error("MITM port is unavailable")));
    server.listen(port, () => server.close(() => resolve()));
  });
}

/** Accept readiness only from our addon's running hook; fail on every child exit. */
export function monitorMitm(
  child: ChildProcess,
  token: string,
  onReady: () => void,
  onFailure: () => void,
): void {
  let ready = false;
  let output = "";
  const timeout = setTimeout(onFailure, 15_000);
  child.stdout?.on("data", (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-4096);
    const marker = `CONTEXT_LENS_MITM_READY:${token}`;
    if (
      !ready &&
      (output.includes(`${marker}\n`) || output.includes(`${marker}\r\n`))
    ) {
      ready = true;
      clearTimeout(timeout);
      onReady();
    }
  });
  child.once("exit", () => {
    clearTimeout(timeout);
    onFailure();
  });
  child.once("error", () => {
    clearTimeout(timeout);
    onFailure();
  });
}
