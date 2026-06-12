import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { checkWritableDir, findBinaryOnPath } from "../src/cli/doctor.js";

describe("cli doctor helpers", () => {
  it("finds binaries on a supplied PATH", () => {
    const exists = (candidate: string) => candidate === path.join("/b", "tool");

    assert.equal(
      findBinaryOnPath("tool", `/a${path.delimiter}/b`, exists),
      path.join("/b", "tool"),
    );
    assert.equal(
      findBinaryOnPath("missing", `/a${path.delimiter}/b`, exists),
      null,
    );
  });

  it("checks whether a directory is writable", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "context-lens-doctor-test-"));
    try {
      assert.equal(checkWritableDir(path.join(dir, "nested")), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
