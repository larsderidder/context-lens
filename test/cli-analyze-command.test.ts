import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  formatAnalyzeHelp,
  parseAnalyzeArgs,
  resolveAnalyzePath,
} from "../src/cli/analyze-command.js";

describe("cli analyze command", () => {
  it("parses analyze flags and filepath", () => {
    assert.deepEqual(
      parseAnalyzeArgs([
        "session.lhar",
        "--json",
        "--main-only",
        "--no-path",
        "--composition=pre-compaction",
      ]),
      {
        filepath: "session.lhar",
        outputJson: true,
        mainOnly: true,
        showPath: false,
        compositionArg: "pre-compaction",
        showHelp: false,
      },
    );
  });

  it("detects help and unknown options", () => {
    const help = parseAnalyzeArgs(["--help"]);
    assert.ok(!("error" in help));
    assert.equal(help.showHelp, true);
    assert.deepEqual(parseAnalyzeArgs(["--bad"]), {
      error: "Unknown option: --bad",
    });
  });

  it("renders analyze help", () => {
    const help = formatAnalyzeHelp();
    assert.match(help, /Usage: context-lens analyze <session\.lhar>/);
    assert.match(help, /--composition=pre-compaction/);
  });

  it("resolves analyze path from direct, home data, then local data", () => {
    const existing = new Set([
      "/home/lars/.context-lens/data/home.lhar",
      "data/local.lhar",
      "direct.lhar",
    ]);
    const exists = (path: string) => existing.has(path);

    assert.deepEqual(resolveAnalyzePath("direct.lhar", exists, "/home/lars"), {
      path: "direct.lhar",
    });
    assert.deepEqual(resolveAnalyzePath("home.lhar", exists, "/home/lars"), {
      path: "/home/lars/.context-lens/data/home.lhar",
    });
    assert.deepEqual(resolveAnalyzePath("local.lhar", exists, "/home/lars"), {
      path: "data/local.lhar",
    });
    assert.deepEqual(resolveAnalyzePath("missing.lhar", exists, "/home/lars"), {
      error: "Error: file not found: missing.lhar",
      searched: [
        "missing.lhar",
        "/home/lars/.context-lens/data/missing.lhar",
        "data/missing.lhar",
      ],
    });
  });
});
