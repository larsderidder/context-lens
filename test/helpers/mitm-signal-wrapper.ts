import { spawn } from "node:child_process";

import { monitorMitm, spawnMitmProcess } from "../../src/cli/mitm-lifecycle.js";

process.on("SIGINT", () => {});
const mitm = spawnMitmProcess(
  JSON.parse(process.argv[3]),
  process.env,
  process.argv[2],
);
mitm.stderr?.resume();
let stopping = false;
let tool: ReturnType<typeof spawn> | undefined;
process.once("exit", () => {
  tool?.kill("SIGTERM");
});
monitorMitm(
  mitm,
  "fixture",
  () => {
    tool = spawn(
      process.execPath,
      [
        "-e",
        'process.on("SIGINT", () => { console.log("interrupted"); setTimeout(() => process.exit(130), 350); }); console.log("ready"); setInterval(() => {}, 1000)',
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    tool.stdout?.on("data", (chunk: Buffer) => {
      process.send?.({
        event: chunk.toString().trim(),
        mitmPid: mitm.pid,
        toolPid: tool?.pid,
      });
    });
    tool.once("exit", (code, signal) => {
      stopping = true;
      process.send?.({ event: "tool-exit", code, signal });
      mitm.kill();
      process.exit(code ?? 1);
    });
  },
  () => {
    if (!stopping) {
      process.send?.({ event: "mitm-failed" });
      if (tool) {
        tool.kill("SIGKILL");
      } else {
        process.exit(1);
      }
    }
  },
);
process.on("message", () => process.exit(0));
