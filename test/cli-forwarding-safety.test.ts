import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net, { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertMitmPortAvailable,
  monitorMitm,
} from "../src/cli/mitm-lifecycle.js";

it("rejects an occupied disposable MITM listener", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    await assert.rejects(assertMitmPortAvailable(port), /unavailable/);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await assertMitmPortAvailable(port);
});

it("requires child readiness and detects exit even after readiness", async () => {
  for (const ready of [false, true]) {
    let script = "process.exit(1)";
    if (ready) {
      script =
        'console.log("CONTEXT_LENS_MITM_READY:fixture"); setTimeout(() => process.exit(1), 50)';
    }
    const child = spawn(process.execPath, ["-e", script], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let readyCalls = 0;
    await new Promise<void>((resolve) => {
      monitorMitm(
        child,
        "fixture",
        () => {
          readyCalls++;
        },
        resolve,
      );
    });
    assert.equal(readyCalls, Number(ready));
  }
});

it("accepts Windows CRLF readiness from its own child", async () => {
  const child = spawn(
    process.execPath,
    [
      "-e",
      'process.stdout.write("CONTEXT_LENS_MITM_READY:fixture\\r\\n"); setTimeout(() => process.exit(1), 50)',
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let readyCalls = 0;
  await new Promise<void>((resolve) => {
    monitorMitm(
      child,
      "fixture",
      () => {
        readyCalls++;
      },
      resolve,
    );
  });
  assert.equal(readyCalls, 1);
});

it("MITM child failure stops a disposable wrapped child", async () => {
  const tool = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
  });
  const exited = once(tool, "exit");
  const mitm = spawn(process.execPath, ["-e", "process.exit(1)"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  monitorMitm(
    mitm,
    "fixture",
    () => assert.fail("unexpected readiness"),
    () => tool.kill(),
  );
  const [, signal] = await exited;
  assert.equal(signal, "SIGTERM");
});

it("broken or unreadable config leaves management commands usable and forwarding closed", () => {
  const home = mkdtempSync(join(tmpdir(), "context-lens-broken-config-"));
  const dir = join(home, ".context-lens");
  mkdirSync(dir);
  const config = join(dir, "config.toml");
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  try {
    for (const unreadable of [false, true]) {
      if (unreadable) {
        rmSync(config);
        mkdirSync(config);
      } else {
        writeFileSync(
          config,
          '[proxy]\nupstream_proxy = "http://dummy:fixture-secret@localhost:8888" BAD',
        );
      }
      for (const args of [
        ["--help"],
        ["--version"],
        ["stop"],
        ["background", "stop"],
        ["background", "status"],
        ["doctor"],
        ["--no-ui"],
      ]) {
        const result = spawnSync(
          process.execPath,
          [cli, "--no-update-check", ...args],
          {
            env: { ...process.env, HOME: home },
            encoding: "utf8",
            timeout: 5000,
          },
        );
        const output = result.stdout + result.stderr;
        assert.doesNotMatch(
          output,
          /fixture-secret|BAD|TomlError|at loadConfig/,
        );
        assert.equal(result.error, undefined);
        let expected = 0;
        if (args[0] === "doctor" || args[0] === "--no-ui") {
          expected = 1;
          assert.match(output, /Could not load Context Lens configuration/);
        }
        assert.equal(result.status, expected, output);
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
