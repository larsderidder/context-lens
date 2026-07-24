import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  clearStaleLockfile,
  DEFAULT_LOCKFILE,
  decrementLockRefCount,
  incrementLockRefCount,
} from "../src/cli/lockfile.js";

function withLockfile(fn: (lockfile: string) => void): void {
  const dir = mkdtempSync(path.join(tmpdir(), "context-lens-lockfile-test-"));
  try {
    fn(path.join(dir, "context-lens.lock"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("cli lockfile reference counts", () => {
  it("uses the platform temp directory by default", () => {
    assert.equal(DEFAULT_LOCKFILE, path.join(tmpdir(), "context-lens.lock"));
  });

  it("increments missing, valid, and invalid lockfiles", () => {
    withLockfile((lockfile) => {
      assert.equal(incrementLockRefCount(lockfile), 1);
      assert.equal(readFileSync(lockfile, "utf8"), "1");

      assert.equal(incrementLockRefCount(lockfile), 2);
      assert.equal(readFileSync(lockfile, "utf8"), "2");

      writeFileSync(lockfile, "not-a-number");
      assert.equal(incrementLockRefCount(lockfile), 1);
      assert.equal(readFileSync(lockfile, "utf8"), "1");
    });
  });

  it("decrements and removes the lockfile at zero", () => {
    withLockfile((lockfile) => {
      writeFileSync(lockfile, "2");
      assert.equal(decrementLockRefCount(lockfile), 1);
      assert.equal(readFileSync(lockfile, "utf8"), "1");

      assert.equal(decrementLockRefCount(lockfile), 0);
      assert.equal(existsSync(lockfile), false);

      assert.equal(decrementLockRefCount(lockfile), 0);
    });
  });

  it("clears stale lockfiles", () => {
    withLockfile((lockfile) => {
      writeFileSync(lockfile, "3");
      clearStaleLockfile(lockfile);
      assert.equal(existsSync(lockfile), false);
    });
  });
});
