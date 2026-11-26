import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "node:test";

it("isolates application configuration before importing CLI helpers", () => {
  const home = mkdtempSync(path.join(tmpdir(), "context-lens-host-config-"));
  try {
    const configDir = path.join(home, ".context-lens");
    mkdirSync(configDir);
    writeFileSync(path.join(configDir, "config.toml"), "[mitm]\nport = 9080\n");
    const output = execFileSync(
      process.execPath,
      [
        "--import",
        "./test/helpers/isolated-home.mjs",
        "--input-type=module",
        "--eval",
        'import { getMitmConfig } from "./dist-test/src/cli-utils.js"; console.log(getMitmConfig().port);',
      ],
      {
        encoding: "utf8",
        env: { ...process.env, HOME: home, USERPROFILE: home },
      },
    );
    assert.equal(output.trim(), "8080");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
