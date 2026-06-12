import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isNewerVersion, splitSemver } from "../src/cli/update-check.js";

describe("cli update check helpers", () => {
  it("splits semver strings and ignores suffixes", () => {
    assert.deepEqual(splitSemver("1.2.3"), [1, 2, 3]);
    assert.deepEqual(splitSemver("1.2.3-beta.1"), [1, 2, 3]);
    assert.deepEqual(splitSemver("bad"), [0, 0, 0]);
  });

  it("compares semantic versions", () => {
    assert.equal(isNewerVersion("1.2.4", "1.2.3"), true);
    assert.equal(isNewerVersion("1.3.0", "1.2.99"), true);
    assert.equal(isNewerVersion("2.0.0", "1.99.99"), true);
    assert.equal(isNewerVersion("1.2.3", "1.2.3"), false);
    assert.equal(isNewerVersion("1.2.2", "1.2.3"), false);
  });
});
