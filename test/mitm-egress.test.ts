import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it } from "node:test";
import { setTimeout } from "node:timers/promises";

import { buildMitmArgs } from "../src/cli/mitm.js";
import { getMitmConfig } from "../src/cli-utils.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function request(port: number, target: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path: target, method: "POST", agent: false },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.end('{"model":"test","messages":[]}');
  });
}

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

it("mitmproxy retains captures and never falls back to direct egress", {
  timeout: 20000,
}, async (t) => {
  if (spawnSync("mitmdump", ["--version"], { stdio: "ignore" }).error) {
    t.skip("mitmdump is not installed");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "context-lens-mitm-egress-"));
  let upstreamRequests = 0;
  let proxyRequests = 0;
  const captures: { responseStatus: number; requestBody: unknown }[] = [];
  const ingestPaths: string[] = [];
  let upstreamStatus = 200;
  const upstream = http.createServer((_req, res) => {
    upstreamRequests++;
    res.statusCode = upstreamStatus;
    res.end('{"content":[]}');
  });
  const ingest = http.createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      captures.push(JSON.parse(body));
      res.end("{}");
    });
  });
  const egress = http.createServer((req, res) => {
    proxyRequests++;
    if (new URL(req.url ?? "").pathname === "/api/ingest") {
      ingestPaths.push(req.url ?? "");
      req.resume();
      res.writeHead(502);
      res.end();
      return;
    }
    const forwarded = http.request(
      new URL(req.url ?? ""),
      { method: req.method, headers: req.headers, agent: false },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    forwarded.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    req.pipe(forwarded);
  });
  const upstreamPort = await listen(upstream);
  const ingestPort = await listen(ingest);
  const egressPort = await listen(egress);
  const reservation = http.createServer();
  const mitmPort = await listen(reservation);
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  const config = getMitmConfig({ CONTEXT_LENS_MITM_PORT: String(mitmPort) });
  config.extraArgs = ["--listen-host", "127.0.0.1", "--set", `confdir=${dir}`];
  config.addonPath = join(process.cwd(), "mitm_addon.py");
  const child = spawn(
    "mitmdump",
    buildMitmArgs(config, `http://127.0.0.1:${egressPort}`),
    {
      stdio: "ignore",
      env: {
        ...process.env,
        CONTEXT_LENS_INGEST_URL: `http://127.0.0.1:${ingestPort}/api/ingest`,
        NO_PROXY: "",
        no_proxy: "",
        HTTP_PROXY: `http://127.0.0.1:${egressPort}`,
        http_proxy: `http://127.0.0.1:${egressPort}`,
        HTTPS_PROXY: `http://127.0.0.1:${egressPort}`,
        https_proxy: `http://127.0.0.1:${egressPort}`,
      },
    },
  );
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill("SIGKILL");
      await exited;
    }
    await Promise.all(
      [upstream, ingest, egress].map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
    rmSync(dir, { recursive: true, force: true });
  });
  const target = `http://127.0.0.1:${upstreamPort}/v1/messages`;
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      assert.equal(await request(mitmPort, target), 200);
      ready = true;
      break;
    } catch {
      assert.equal(
        child.exitCode,
        null,
        "mitmdump exited before accepting requests",
      );
      await setTimeout(50);
    }
  }
  assert.ok(ready, "mitmdump did not start");
  assert.equal(proxyRequests, 1);
  assert.equal(upstreamRequests, 1);
  assert.equal(captures.length, 1);
  upstreamStatus = 429;
  assert.equal(await request(mitmPort, target), 429);
  assert.equal(upstreamRequests, 2);
  assert.equal(proxyRequests, 2);
  assert.deepEqual(ingestPaths, []);
  assert.deepEqual(
    captures.map(({ responseStatus, requestBody }) => ({
      responseStatus,
      requestBody,
    })),
    [
      { responseStatus: 200, requestBody: { model: "test", messages: [] } },
      { responseStatus: 429, requestBody: { model: "test", messages: [] } },
    ],
  );
  egress.closeAllConnections();
  await new Promise<void>((resolve) => egress.close(() => resolve()));
  assert.equal(await request(mitmPort, target), 502);
  assert.equal(upstreamRequests, 2);
  assert.deepEqual(ingestPaths, []);
});
