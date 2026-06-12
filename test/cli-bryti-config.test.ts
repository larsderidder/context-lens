import assert from "node:assert/strict";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { prepareBrytiDataDir } from "../src/cli/bryti-config.js";

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(
    path.join(tmpdir(), "context-lens-bryti-config-test-"),
  );
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Bryti CLI config preparation", () => {
  it("patches base_url lines and links persistent state dirs", () => {
    withTempDir((root) => {
      const sourceDataDir = path.join(root, "data");
      mkdirSync(path.join(sourceDataDir, "users"), { recursive: true });
      mkdirSync(path.join(sourceDataDir, "files"), { recursive: true });
      mkdirSync(path.join(sourceDataDir, ".pi"), { recursive: true });
      writeFileSync(
        path.join(sourceDataDir, "config.yml"),
        [
          "models:",
          "  anthropic:",
          '    base_url: "https://api.anthropic.com"',
          "  empty:",
          "    base_url:",
        ].join("\n"),
      );
      writeFileSync(path.join(sourceDataDir, ".pi", "settings.json"), "{}");

      const targetDir = prepareBrytiDataDir({
        sourceDataDir,
        targetDirPrefix: path.join(root, "bryti-temp-"),
        proxyUrl: "http://localhost:4040",
        sessionTag: "deadbeef",
      });

      const patched = readFileSync(path.join(targetDir, "config.yml"), "utf8");
      assert.match(
        patched,
        /base_url: "http:\/\/localhost:4040\/bryti\/deadbeef"/,
      );
      assert.equal(
        readFileSync(path.join(targetDir, ".pi", "settings.json"), "utf8"),
        "{}",
      );
      assert.equal(
        lstatSync(path.join(targetDir, "users")).isSymbolicLink(),
        true,
      );
      assert.throws(() => lstatSync(path.join(targetDir, "files")));
    });
  });

  it("returns a temp dir and warns when config is missing", () => {
    withTempDir((root) => {
      const warnings: string[] = [];
      const sourceDataDir = path.join(root, "data");
      mkdirSync(sourceDataDir, { recursive: true });

      const targetDir = prepareBrytiDataDir({
        sourceDataDir,
        targetDirPrefix: path.join(root, "bryti-temp-"),
        proxyUrl: "http://localhost:4040",
        sessionTag: "deadbeef",
        warn: (message) => warnings.push(message),
      });

      assert.match(targetDir, /bryti-temp-/);
      assert.equal(warnings.length, 1);
      assert.match(warnings[0], /no Bryti config\.yml found/);
    });
  });
});
