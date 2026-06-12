import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { preparePiAgentDir, resolvePackagePath } from "../src/cli/pi-config.js";

function withTempHome(fn: (homeDir: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "context-lens-pi-config-test-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("Pi CLI config preparation", () => {
  it("resolves relative package paths without touching package specifiers", () => {
    assert.equal(
      resolvePackagePath("./skills/local", "/home/lars/.pi/agent"),
      "/home/lars/.pi/agent/skills/local",
    );
    assert.equal(
      resolvePackagePath("../shared", "/home/lars/.pi/agent"),
      "/home/lars/.pi/shared",
    );
    assert.equal(
      resolvePackagePath("@scope/package", "/base"),
      "@scope/package",
    );
    assert.equal(resolvePackagePath("plain-package", "/base"), "plain-package");
    assert.equal(
      resolvePackagePath("https://example.com/repo.git", "/base"),
      "https://example.com/repo.git",
    );
    assert.equal(resolvePackagePath("~/skills", "/base"), "~/skills");
    assert.equal(
      resolvePackagePath("/absolute/path", "/base"),
      "/absolute/path",
    );
  });

  it("creates a private temp agent dir and rewrites model providers", () => {
    withTempHome((homeDir) => {
      const sourceDir = path.join(homeDir, ".pi", "agent");
      mkdirSync(sourceDir, { recursive: true });
      writeFileSync(
        path.join(sourceDir, "models.json"),
        JSON.stringify({
          providers: {
            openai: {
              baseUrl: "https://api.openai.com",
              headers: { existing: "1" },
            },
            custom: {
              baseUrl: "https://llm.example.com/v1",
              headers: { existing: "2" },
            },
          },
        }),
      );
      writeFileSync(
        path.join(sourceDir, "settings.json"),
        JSON.stringify({
          packages: [
            "./skills/local",
            { source: "../shared" },
            "plain-package",
          ],
        }),
      );
      writeFileSync(
        path.join(sourceDir, "auth.json"),
        JSON.stringify({ authenticated: {} }),
      );

      const targetDir = preparePiAgentDir({
        homeDir,
        targetDirPrefix: path.join(homeDir, "tmp-agent-"),
        proxyUrl: "http://localhost:4040",
        sessionTag: "deadbeef",
        env: { OPENROUTER_API_KEY: "test-key" },
      });

      const models = JSON.parse(
        readFileSync(path.join(targetDir, "models.json"), "utf8"),
      );
      assert.equal(
        models.providers.openai.baseUrl,
        "http://localhost:4040/pi/deadbeef",
      );
      assert.deepEqual(models.providers.openai.headers, { existing: "1" });
      assert.equal(
        models.providers.custom.baseUrl,
        "http://localhost:4040/pi/deadbeef",
      );
      assert.deepEqual(models.providers.custom.headers, {
        existing: "2",
        "x-target-url": "https://llm.example.com/v1",
      });
      assert.equal(
        models.providers.anthropic.baseUrl,
        "http://localhost:4040/pi/deadbeef",
      );
      assert.equal(
        models.providers.authenticated.baseUrl,
        "http://localhost:4040/pi/deadbeef",
      );
      assert.equal(
        models.providers.openrouter.baseUrl,
        "http://localhost:4040/pi/deadbeef",
      );

      const settings = JSON.parse(
        readFileSync(path.join(targetDir, "settings.json"), "utf8"),
      );
      assert.deepEqual(settings.packages, [
        path.join(sourceDir, "skills", "local"),
        { source: path.join(homeDir, ".pi", "shared") },
        "plain-package",
      ]);
    });
  });
});
