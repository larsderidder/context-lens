import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "context-lens-package-"));
const originalHome = process.env.HOME;
const originalProfile = process.env.USERPROFILE;
const originalMitmPort = process.env.CONTEXT_LENS_MITM_PORT;
try {
  const [archive] = JSON.parse(
    execFileSync(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary],
      { cwd: root, encoding: "utf8" },
    ),
  );
  const installation = join(temporary, "installation");
  mkdirSync(installation);
  writeFileSync(
    join(installation, "package.json"),
    JSON.stringify({ private: true }),
  );
  execFileSync(
    "npm",
    [
      "install",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      join(temporary, archive.filename),
    ],
    { cwd: installation, stdio: "pipe" },
  );
  const installed = join(installation, "node_modules", "context-lens");
  const manifest = JSON.parse(
    readFileSync(join(installed, "package.json"), "utf8"),
  );
  assert.equal(manifest.version, archive.version);
  const commands = new Map();
  for (const extension of manifest.pi.extensions) {
    const { default: register } = await import(
      pathToFileURL(join(installed, extension)).href
    );
    register({
      registerCommand(name, command) {
        assert.ok(!commands.has(name), `Duplicate command ${name}`);
        commands.set(name, command);
      },
    });
  }
  assert.equal(typeof commands.get("context-lens")?.handler, "function");

  // Exercise the packaged helper's dynamic dist/config.js import using an ephemeral port.
  const home = join(temporary, "home");
  mkdirSync(join(home, ".context-lens"), { recursive: true });
  writeFileSync(
    join(home, ".context-lens", "config.toml"),
    "[mitm]\nport = 0\n",
  );
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.CONTEXT_LENS_MITM_PORT;
  const { preflightCapture } = await import(
    pathToFileURL(join(installed, "extensions", "mitm-preflight.js")).href
  );
  await preflightCapture();
  console.log(
    `Installed package ${archive.version}: Pi command and capture preflight work`,
  );
} finally {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalProfile;
  }
  if (originalMitmPort === undefined) {
    delete process.env.CONTEXT_LENS_MITM_PORT;
  } else {
    process.env.CONTEXT_LENS_MITM_PORT = originalMitmPort;
  }
  rmSync(temporary, { recursive: true, force: true });
}
