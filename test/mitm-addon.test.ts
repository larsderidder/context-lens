import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";

function runPython(code: string) {
  return spawnSync("python3", ["-c", code], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

describe("mitm addon request matching", () => {
  it("captures PPQ.ai chat completions as OpenAI traffic", () => {
    const script = String.raw`
import json
import sys
import types

mitmproxy = types.ModuleType("mitmproxy")
mitmproxy.http = types.SimpleNamespace(HTTPFlow=object)
sys.modules["mitmproxy"] = mitmproxy

import mitm_addon

class Request:
    pretty_host = "api.ppq.ai"
    path = "/chat/completions"

class Flow:
    request = Request()

print(json.dumps(mitm_addon.match_request(Flow())))
`;

    const result = runPython(script);

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ["openai", "ppq"]);
  });
});

it("runs the stdlib Python capture-delivery regressions", {
  timeout: 30000,
}, (t) => {
  const root = process.cwd();
  for (const python of ["python3", "python"]) {
    const result = spawnSync(
      python,
      [
        "-m",
        "unittest",
        "discover",
        "-s",
        join(root, "test"),
        "-p",
        "test_mitm_ingest.py",
        "-v",
      ],
      { cwd: root, encoding: "utf8", timeout: 20000 },
    );
    if (
      result.error &&
      "code" in result.error &&
      result.error.code === "ENOENT"
    ) {
      continue;
    }
    const diagnostics = [
      result.error?.message,
      result.stdout,
      result.stderr,
    ].join("\n");
    assert.ok(!result.error, diagnostics);
    assert.equal(result.status, 0, diagnostics);
    assert.match(result.stderr, /Ran [1-9]\d* tests?\b/, diagnostics);
    return;
  }
  t.skip("Python is not installed");
});
