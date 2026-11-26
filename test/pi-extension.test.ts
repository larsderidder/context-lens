import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const extensionUrl = new URL(
  "../../extensions/context-lens.js",
  import.meta.url,
);
const { default: register } = await import(extensionUrl.href);
const { checkMitmPort } = await import(
  new URL("./mitm-preflight.js", extensionUrl).href
);

describe("bundled Pi extension", () => {
  it("retains an extensionless npm launcher symlink without looking up pi on PATH", async () => {
    if (process.platform === "win32") {
      return;
    }
    const fixture = setup();
    const symlink = join(fixture.ctx.cwd, "pi");
    symlinkSync(fixture.launcher, symlink);
    fixture.runtime.argv[1] = symlink;
    register(fixture.pi, fixture.runtime, async () => {});
    try {
      await fixture.run();
      fixture.exit();
      const call = fixture.calls[2] as [string, string, string[]];
      assert.equal(call[2][5], symlink);
    } finally {
      fixture.cleanup();
    }
  });
  function setup(preflight = async () => {}) {
    const dir = mkdtempSync(join(tmpdir(), "lens-extension-"));
    const session = join(dir, "session with ' quotes; $.jsonl");
    writeFileSync(session, "{}\n");
    const launcher = join(dir, "custom pi ' launcher.js");
    writeFileSync(launcher, "// Pi launcher fixture\n");
    const notifications: string[] = [];
    const calls: unknown[] = [];
    let exitHandler: ((code: number) => void) | undefined;
    let handler: (args: string, context: typeof ctx) => Promise<void>;
    const runtime = {
      env: { PATH: "/bin", UNUSED: undefined } as NodeJS.ProcessEnv,
      platform: "linux",
      execPath: process.execPath,
      argv: [process.execPath, launcher],
      execArgv: [] as string[],
      cwd: () => dir,
      exitCode: 0,
      once(event: string, callback: (code: number) => void) {
        assert.equal(event, "exit");
        exitHandler = callback;
      },
      chdir(cwd: string) {
        calls.push(["chdir", cwd]);
      },
      execve(...args: unknown[]) {
        calls.push(["execve", ...args]);
      },
    };
    const ctx = {
      mode: "tui",
      cwd: dir,
      model: { provider: "test-provider", id: "test-model" },
      isIdle: () => true,
      sessionManager: { getSessionFile: (): string | undefined => session },
      ui: {
        notify(message: string) {
          notifications.push(message);
        },
      },
      shutdown() {
        calls.push("shutdown");
      },
    };
    const pi = {
      registerCommand(name: string, command: { handler: typeof handler }) {
        assert.equal(name, "context-lens");
        handler = command.handler;
      },
      async exec(command: string, args: string[]) {
        assert.equal(command, "mitmdump");
        assert.deepEqual(args, ["--version"]);
        return { code: 0 };
      },
      getThinkingLevel: () => "high",
    };
    register(pi, runtime, preflight);
    return {
      ctx,
      runtime,
      pi,
      calls,
      notifications,
      session,
      launcher,
      run: (args = "") => handler(args, ctx),
      exit: (code = 0) => exitHandler?.(code),
      cleanup: () => rmSync(dir, { recursive: true, force: true }),
    };
  }

  it("waits for shutdown before replacing Pi with the bundled MITM CLI", async () => {
    const fixture = setup();
    try {
      assert.deepEqual(fixture.calls, []);
      await fixture.run();
      assert.deepEqual(fixture.calls, ["shutdown"]);
      fixture.exit();
      assert.deepEqual(fixture.calls, [
        "shutdown",
        ["chdir", fixture.ctx.cwd],
        [
          "execve",
          process.execPath,
          [
            process.execPath,
            fileURLToPath(new URL("../../dist/cli.js", import.meta.url)),
            "--mitm",
            "--",
            process.execPath,
            fixture.launcher,
            "--session",
            fixture.session,
            "--provider",
            "test-provider",
            "--model",
            "test-model",
            "--thinking",
            "high",
          ],
          { PATH: "/bin", CONTEXT_LENS_ACTIVE: "1" },
        ],
      ]);
      await fixture.run();
      assert.equal(fixture.calls.length, 3);
    } finally {
      fixture.cleanup();
    }
  });

  for (const scenario of [
    "active",
    "busy",
    "rpc",
    "windows",
    "unsaved",
    "missing",
    "mitm",
    "args",
  ]) {
    it(`does not shut down Pi when ${scenario}`, async () => {
      const fixture = setup();
      try {
        if (scenario === "active") {
          fixture.runtime.env.CONTEXT_LENS_ACTIVE = "1";
        } else if (scenario === "busy") {
          fixture.ctx.isIdle = () => false;
        } else if (scenario === "rpc") {
          fixture.ctx.mode = "rpc";
        } else if (scenario === "windows") {
          fixture.runtime.platform = "win32";
        } else if (scenario === "unsaved") {
          fixture.ctx.sessionManager.getSessionFile = () => undefined;
        } else if (scenario === "missing") {
          rmSync(fixture.session);
        } else if (scenario === "mitm") {
          fixture.pi.exec = async () => ({ code: 1 });
        }
        let args = "";
        if (scenario === "args") {
          args = "unexpected";
        }
        await fixture.run(args);
        fixture.exit();
        assert.deepEqual(fixture.calls, []);
        assert.equal(fixture.notifications.length, 1);
      } finally {
        fixture.cleanup();
      }
    });
  }

  it("can retry after mitmproxy preflight fails", async () => {
    const fixture = setup();
    try {
      const exec = fixture.pi.exec;
      fixture.pi.exec = async () => ({ code: 1 });
      await fixture.run();
      fixture.pi.exec = exec;
      await fixture.run();
      assert.deepEqual(fixture.calls, ["shutdown"]);
    } finally {
      fixture.cleanup();
    }
  });

  it("leaves Pi open and displays the error when capture preflight fails", async () => {
    const fixture = setup(async () => {
      throw new Error("Port 18080 is already in use");
    });
    try {
      await fixture.run();
      fixture.exit();
      assert.deepEqual(fixture.calls, []);
      assert.match(fixture.notifications[0], /Port 18080 is already in use/);
    } finally {
      fixture.cleanup();
    }
  });

  it("preserves one-off restrictions, extensions and prompts without replaying initial input", async () => {
    const fixture = setup();
    const options = [
      "--no-tools",
      "--no-builtin-tools",
      "--tools",
      "read,grep",
      "--exclude-tools",
      "bash",
      "-e",
      "./permission gate.ts",
      "--extension",
      "./provider.ts",
      "--no-extensions",
      "--no-mcp",
      "--system-prompt",
      "Do not mutate files",
      "--append-system-prompt",
      "./rules.md",
      "--models",
      "test/*",
      "--offline",
      "--no-approve",
    ];
    fixture.runtime.argv.push(
      ...options,
      "--session",
      "old.jsonl",
      "--model",
      "old-model",
      "--thinking",
      "low",
      "@initial.txt",
      "initial prompt",
      "--",
      "--print",
    );
    // The invocation snapshot is taken when the extension loads.
    register(fixture.pi, fixture.runtime, async () => {});
    try {
      await fixture.run();
      fixture.exit();
      const call = fixture.calls[2] as [
        string,
        string,
        string[],
        NodeJS.ProcessEnv,
      ];
      assert.deepEqual(call[2].slice(3, -8), [
        "--",
        process.execPath,
        fixture.launcher,
        ...options,
      ]);
      assert.ok(!call[2].includes("initial prompt"));
      assert.ok(!call[2].includes("--print"));
      assert.ok(!call[2].includes("old.jsonl"));
    } finally {
      fixture.cleanup();
    }
  });

  for (const args of [
    ["--plan"],
    ["--mode", "rpc"],
    ["--print"],
    ["--tools=read"],
    ["-e"],
  ]) {
    it(`fails closed for unsupported invocation ${args.join(" ")}`, async () => {
      const fixture = setup();
      fixture.runtime.argv.push(...args);
      register(fixture.pi, fixture.runtime, async () => {});
      try {
        await fixture.run();
        fixture.exit();
        assert.deepEqual(fixture.calls, []);
        assert.match(fixture.notifications[0], /safely|Unsupported/);
        assert.match(fixture.notifications[0], /context-lens --mitm/);
      } finally {
        fixture.cleanup();
      }
    });
  }

  for (const scenario of ["launcher", "node", "loader", "cwd"]) {
    it(`does not shut down with unavailable or unsupported ${scenario}`, async () => {
      const fixture = setup();
      if (scenario === "launcher") {
        rmSync(fixture.launcher);
      } else if (scenario === "node") {
        fixture.runtime.execPath = join(fixture.ctx.cwd, "missing-node");
      } else if (scenario === "loader") {
        fixture.runtime.execArgv.push("--import", "tsx");
      } else {
        fixture.ctx.cwd = tmpdir();
      }
      register(fixture.pi, fixture.runtime, async () => {});
      try {
        await fixture.run();
        fixture.exit();
        assert.deepEqual(fixture.calls, []);
        assert.equal(fixture.notifications.length, 1);
      } finally {
        fixture.cleanup();
      }
    });
  }

  for (const scenario of ["busy", "session", "cwd"]) {
    it(`rechecks ${scenario} after preflight`, async () => {
      const fixture = setup(async () => {
        if (scenario === "busy") {
          fixture.ctx.isIdle = () => false;
        } else if (scenario === "cwd") {
          fixture.ctx.cwd = tmpdir();
        } else {
          fixture.ctx.sessionManager.getSessionFile = () => "another-session";
        }
      });
      try {
        await fixture.run();
        fixture.exit();
        assert.deepEqual(fixture.calls, []);
        assert.match(fixture.notifications[0], /session changed/);
      } finally {
        fixture.cleanup();
      }
    });
  }

  it("does not replace Pi when shutdown exits with an error", async () => {
    const fixture = setup();
    try {
      await fixture.run();
      fixture.exit(1);
      assert.deepEqual(fixture.calls, ["shutdown"]);
    } finally {
      fixture.cleanup();
    }
  });

  it("reports execve failure and exits unsuccessfully with the saved session path", async (t) => {
    const fixture = setup();
    const errors: string[] = [];
    t.mock.method(console, "error", (message: string) => errors.push(message));
    fixture.runtime.execve = () => {
      throw new Error("execve unavailable");
    };
    try {
      await fixture.run();
      fixture.exit();
      assert.equal(fixture.runtime.exitCode, 1);
      assert.match(errors[0], /execve unavailable/);
      assert.ok(errors[1].includes(JSON.stringify(fixture.session)));
      assert.ok(!errors[1].includes("pi --resume"));
    } finally {
      fixture.cleanup();
    }
  });
  it("rejects an occupied port and releases a successful probe", async () => {
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, () => resolve());
    });
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const port = address.port;
    try {
      await assert.rejects(checkMitmPort(port), /already in use.*config.toml/);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
    await checkMitmPort(port);
    await checkMitmPort(port);
  });

  it("executes a native process replacement from the exit hook", () => {
    if (process.platform === "win32" || !process.execve) {
      return;
    }
    const fixture = setup();
    try {
      const script = `
        import register from ${JSON.stringify(extensionUrl.href)};
        let handler;
        const originalPid = process.pid;
        register({
          registerCommand(name, command) { handler = command.handler; },
          exec: async () => ({ code: 0 }),
          getThinkingLevel: () => "high",
        }, {
          env: process.env, platform: process.platform, execPath: process.execPath,
          argv: [process.execPath, ${JSON.stringify(fixture.launcher)}], execArgv: [],
          cwd: () => ${JSON.stringify(fixture.ctx.cwd)},
          once: process.once.bind(process), chdir: process.chdir.bind(process),
          execve(file, argv, env) {
            process.execve(file, [file, "--input-type=module", "-e",
              "console.log(process.pid === " + originalPid + ")"], env);
          },
        }, async () => {});
        await handler("", {
          mode: "tui", cwd: ${JSON.stringify(fixture.ctx.cwd)},
          isIdle: () => true,
          sessionManager: { getSessionFile: () => ${JSON.stringify(fixture.session)} },
          ui: { notify(message) { throw new Error(message); } },
          shutdown() { process.exit(0); },
        });
      `;
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", script],
        {
          encoding: "utf8",
          timeout: 10000,
          env: { ...process.env, CONTEXT_LENS_ACTIVE: "0" },
        },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout.trim(), "true");
    } finally {
      fixture.cleanup();
    }
  });

  it("declares the extension in the npm package", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    assert.deepEqual(manifest.pi.extensions, ["./extensions/context-lens.js"]);
    assert.ok(manifest.files.includes("extensions/"));
  });
});
