import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

for (const mode of ["flood", "fail"]) {
  it(`handles MITM ${mode} output without blocking or flooding the terminal`, {
    skip: process.platform === "win32",
    timeout: 15000,
  }, async (t) => {
    const home = mkdtempSync(join(tmpdir(), "lens-mitm-output-"));
    const pidPath = join(home, "mitm.pid");
    const servers = [
      net.createServer((socket) => socket.end()),
      net.createServer((socket) => socket.end()),
      net.createServer((socket) => socket.end()),
    ];
    t.after(async () => {
      if (existsSync(pidPath)) {
        try {
          process.kill(Number(readFileSync(pidPath, "utf8")), "SIGTERM");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
        }
      }
      for (const server of servers) {
        if (server.listening) {
          await new Promise<void>((resolve) => server.close(() => resolve()));
        }
      }
      rmSync(home, { recursive: true, force: true });
    });
    for (const server of servers) {
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
    }
    const ports = servers.map(
      (server) => (server.address() as AddressInfo).port,
    );
    await new Promise<void>((resolve) => servers[2].close(() => resolve()));
    const bin = join(home, "bin");
    mkdirSync(bin);
    mkdirSync(join(home, ".context-lens"));
    copyFileSync(
      join(process.cwd(), "test/helpers/mitm-output-stub.mjs"),
      join(bin, "mitmdump"),
    );
    chmodSync(join(bin, "mitmdump"), 0o755);
    writeFileSync(
      join(home, ".context-lens/config.toml"),
      `[proxy]\nport = ${ports[0]}\n[ui]\nport = ${ports[1]}\n[mitm]\nport = ${ports[2]}\n`,
    );
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../src/cli.js", import.meta.url)),
        "--no-update-check",
        "--no-open",
        "--mitm",
        "--",
        process.execPath,
        "-e",
        'console.log("CHILD_STARTED"); process.exit(17)',
      ],
      {
        env: {
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          HOME: home,
          USERPROFILE: home,
          TMPDIR: home,
          MITM_OUTPUT_MODE: mode,
          MITM_OUTPUT_PID: pidPath,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`CLI stalled while handling MITM output: ${output}`));
      }, 10000);
      child.once("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.once("close", (status) => {
        clearTimeout(timeout);
        resolve(status);
      });
    });
    if (mode === "flood") {
      assert.equal(code, 17, output);
      assert.match(output, /CHILD_STARTED/);
    } else {
      assert.equal(code, 1, output);
      assert.match(output, /fixture binding failure/);
    }
    assert.ok(output.length < 20000, "MITM diagnostics must remain bounded");
  });
}
