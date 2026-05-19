import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
