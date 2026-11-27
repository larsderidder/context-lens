import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { withoutEgressCredentials } from "../src/cli/egress-env.js";

interface SignalEvent {
  event: string;
  mitmPid?: number;
  toolPid?: number;
  code?: number;
  signal?: string | null;
}

for (const realMitm of [false, true]) {
  for (const scenario of ["interrupt", "parent-exit", "mitm-exit"]) {
    it(`isolates MITM signals (real=${realMitm}, ${scenario})`, {
      skip: process.platform === "win32",
      timeout: 20000,
    }, async (t) => {
      if (
        realMitm &&
        spawnSync("mitmdump", ["--version"], { stdio: "ignore" }).status !== 0
      ) {
        t.skip("mitmdump is not installed");
        return;
      }
      const dir = mkdtempSync(join(tmpdir(), "lens-mitm-signals-"));
      const probe = net.createServer();
      await new Promise<void>((resolve) =>
        probe.listen(0, "127.0.0.1", resolve),
      );
      const port = (probe.address() as AddressInfo).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      let command = process.execPath;
      let args = [
        "-e",
        'console.log("CONTEXT_LENS_MITM_READY:fixture"); setInterval(() => {}, 1000)',
      ];
      if (realMitm) {
        command = "mitmdump";
        args = [
          "--quiet",
          "--listen-host",
          "127.0.0.1",
          "--listen-port",
          String(port),
          "--set",
          `confdir=${dir}`,
          "-s",
          join(process.cwd(), "mitm_addon.py"),
        ];
      }
      const wrapper = spawn(
        process.execPath,
        [
          fileURLToPath(
            new URL("./helpers/mitm-signal-wrapper.js", import.meta.url),
          ),
          command,
          JSON.stringify(args),
        ],
        {
          detached: true,
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          env: {
            ...withoutEgressCredentials(process.env),
            HOME: dir,
            CONTEXT_LENS_MITM_READY_TOKEN: "fixture",
          },
        },
      );
      const events: SignalEvent[] = [];
      wrapper.on("message", (event: SignalEvent) => events.push(event));
      const exited = once(wrapper, "exit");
      async function waitForEvent(name: string): Promise<SignalEvent> {
        for (let attempt = 0; attempt < 500; attempt++) {
          const event = events.find((item) => item.event === name);
          if (event) {
            return event;
          }
          assert.ok(
            !events.some((item) => item.event === "mitm-failed"),
            "unexpected MITM death",
          );
          await setTimeout(20);
        }
        assert.fail(`Missing event: ${name}`);
      }
      let ready: SignalEvent | undefined;
      try {
        ready = await waitForEvent("ready");
        assert.ok(ready.mitmPid);
        if (scenario === "parent-exit") {
          wrapper.send("exit");
          assert.equal((await exited)[0], 0);
        } else if (scenario === "mitm-exit") {
          process.kill(ready.mitmPid, "SIGKILL");
          assert.equal((await exited)[0], 1);
          assert.ok(events.some((event) => event.event === "mitm-failed"));
          assert.equal(
            events.find((event) => event.event === "tool-exit")?.signal,
            "SIGKILL",
          );
        } else {
          assert.ok(wrapper.pid);
          process.kill(-wrapper.pid, "SIGINT");
          await waitForEvent("interrupted");
          process.kill(ready.mitmPid, 0);
          const toolExit = await waitForEvent("tool-exit");
          assert.equal(toolExit.code, 130);
          assert.equal(toolExit.signal, null);
          assert.equal((await exited)[0], 130);
        }
        let mitmAlive = true;
        for (let attempt = 0; attempt < 100; attempt++) {
          try {
            process.kill(ready.mitmPid, 0);
          } catch {
            mitmAlive = false;
            break;
          }
          await setTimeout(20);
        }
        assert.equal(mitmAlive, false, "MITM outlived its parent");
      } finally {
        for (const pid of [ready?.mitmPid, ready?.toolPid, wrapper.pid]) {
          if (pid) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
        }
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
}
