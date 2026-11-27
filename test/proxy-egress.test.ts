import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, type TestContext } from "node:test";
import { promisify } from "node:util";
import { createProxyHandler } from "@contextio/proxy";

import { validateUpstreamProxy } from "../src/http/upstream-proxy.js";
import {
  type CaptureData,
  createCaptureIngestor,
} from "../src/proxy/capture.js";
import { configureUpstreamProxy } from "../src/proxy/egress.js";
import { createPrunePlugin } from "../src/proxy/prune.js";

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as net.AddressInfo).port;
}

function request(
  port: number,
  method: string,
  path = "/v1/messages",
  body = '{"model":"test","messages":[]}',
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method, agent: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body });
        });
      },
    );
    req.on("error", reject);
    if (method === "POST") {
      req.write(body);
    }
    req.end();
  });
}

async function setup(
  t: TestContext,
  secure = false,
  trustCertificate = true,
  analysisUrl?: string,
) {
  const sockets = new Set<net.Socket>();
  const captures: unknown[] = [];
  const proxyRequests: string[] = [];
  let upstreamRequests = 0;
  const upstreamBodies: string[] = [];
  const respond: http.RequestListener = (req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      body += chunk;
    });
    req.on("end", () => {
      upstreamBodies.push(body);
    });
    upstreamRequests++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    res.end("data: last\n\n");
  };
  let upstream = http.createServer(respond);
  let protocol = "http";
  let ca: Buffer | undefined;
  if (secure) {
    const dir = mkdtempSync(join(tmpdir(), "context-lens-egress-tls-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const keyPath = join(dir, "key.pem");
    const certPath = join(dir, "cert.pem");
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        keyPath,
        "-out",
        certPath,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost",
      ],
      { stdio: "ignore" },
    );
    ca = readFileSync(certPath);
    upstream = https.createServer(
      { key: readFileSync(keyPath), cert: ca },
      respond,
    );
    protocol = "https";
  }
  const upstreamPort = await listen(upstream);
  const egress = http.createServer((req, res) => {
    proxyRequests.push(req.url ?? "");
    const target = new URL(req.url ?? "");
    const forwarded = http.request(
      target,
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
  egress.on("connect", (req, client, head) => {
    proxyRequests.push(`CONNECT ${req.url}`);
    const remote = net.connect(
      { host: "127.0.0.1", port: upstreamPort },
      () => {
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        remote.write(head);
        remote.pipe(client);
        client.pipe(remote);
      },
    );
    sockets.add(remote);
    remote.on("error", () => client.destroy());
    client.on("error", () => remote.destroy());
    client.on("close", () => remote.destroy());
  });
  egress.on("connection", (socket) => {
    sockets.add(socket);
  });
  const egressPort = await listen(egress);
  const restore = configureUpstreamProxy(`http://127.0.0.1:${egressPort}`);
  if (ca && trustCertificate) {
    https.globalAgent.options.ca = ca;
  }
  const target = `${protocol}://localhost:${upstreamPort}`;
  const prunePlugins = [];
  if (analysisUrl) {
    prunePlugins.push(createPrunePlugin(analysisUrl));
  }
  const lens = http.createServer(
    createProxyHandler({
      upstreams: {
        anthropic: target,
        openai: target,
        chatgpt: target,
        gemini: target,
        geminiCodeAssist: target,
        vertex: target,
      },
      plugins: [
        ...prunePlugins,
        {
          name: "test-capture",
          onCapture: (capture) => {
            captures.push(capture);
          },
        },
      ],
      allowTargetOverride: false,
      logTraffic: false,
    }),
  );
  const lensPort = await listen(lens);
  t.after(async () => {
    restore();
    for (const socket of sockets) {
      socket.destroy();
    }
    await Promise.all(
      [lens, upstream, egress].map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
  });
  return {
    lensPort,
    egressPort,
    egress,
    captures,
    proxyRequests,
    upstreamBodies,
    get upstreamRequests() {
      return upstreamRequests;
    },
  };
}

describe("upstream proxy", () => {
  it("prunes through direct analysis lookup while provider traffic uses egress", async (t) => {
    const analysisPaths: string[] = [];
    const analysis = http.createServer((req, res) => {
      analysisPaths.push(req.url ?? "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ prunedMessages: ["user:0"] }));
    });
    const analysisPort = await listen(analysis);
    t.after(
      () =>
        new Promise<void>((resolve) => {
          analysis.close(() => resolve());
          analysis.closeAllConnections();
        }),
    );
    const fixture = await setup(
      t,
      false,
      true,
      `http://127.0.0.1:${analysisPort}`,
    );
    const sessionId = "ab12cd34";
    const conversationId = createHash("sha256")
      .update(sessionId)
      .digest("hex")
      .slice(0, 16);
    const messages = [
      { role: "user", content: "remove this private message" },
      { role: "user", content: "keep this message" },
    ];
    const response = await request(
      fixture.lensPort,
      "POST",
      `/pi/${sessionId}/v1/messages`,
      JSON.stringify({ model: "test", messages }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(analysisPaths, [`/api/sessions/${conversationId}/prunes`]);
    assert.equal(fixture.proxyRequests.length, 1);
    assert.ok(fixture.proxyRequests[0].endsWith("/v1/messages"));
    assert.ok(fixture.proxyRequests.every((path) => !path.includes("/prunes")));
    assert.equal(fixture.upstreamRequests, 1);
    assert.deepEqual(JSON.parse(fixture.upstreamBodies[0]).messages, [
      messages[1],
    ]);
  });

  for (const withEgress of [true, false]) {
    it(`handles an occupied entrypoint port with egress=${withEgress}`, async (t) => {
      const occupied = http.createServer();
      const port = await listen(occupied);
      t.after(
        () => new Promise<void>((resolve) => occupied.close(() => resolve())),
      );
      const home = mkdtempSync(join(tmpdir(), "context-lens-busy-proxy-"));
      t.after(() => rmSync(home, { recursive: true, force: true }));
      const env: NodeJS.ProcessEnv = {
        PATH: process.env.PATH,
        HOME: home,
        CONTEXT_LENS_CAPTURE_DIR: join(home, "captures"),
        CONTEXT_LENS_BIND_HOST: "127.0.0.1",
        CONTEXT_LENS_PROXY_PORT: String(port),
      };
      if (withEgress) {
        env.CONTEXT_LENS_UPSTREAM_PROXY = `http://127.0.0.1:${port}`;
      }
      const run = promisify(execFile)(
        process.execPath,
        [new URL("../src/proxy/server.js", import.meta.url).pathname],
        { env, timeout: 5000 },
      );
      if (withEgress) {
        await assert.rejects(run, (err: unknown) => {
          const failure = err as Error & {
            code: number;
            stderr: string;
            stdout: string;
          };
          assert.equal(failure.code, 1);
          assert.match(failure.stderr, /cannot verify.*egress/i);
          assert.doesNotMatch(failure.stdout, /already running/);
          return true;
        });
      } else {
        const result = await run;
        assert.match(result.stdout, /already running/);
      }
    });
  }
  it("keeps capture ingestion separate from provider egress", async (t) => {
    const fixture = await setup(t);
    await request(fixture.lensPort, "POST");
    const ingest = http.createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.end("{}");
      });
    });
    t.after(() => new Promise<void>((closed) => ingest.close(() => closed())));
    const port = await listen(ingest);
    const received = once(ingest, "request");
    createCaptureIngestor(`http://127.0.0.1:${port}/api/ingest`).post(
      fixture.captures[0] as CaptureData,
    );
    await received;
    assert.equal(
      fixture.proxyRequests.length,
      1,
      "only the provider request should use egress",
    );
  });
  it("authenticates to the configured proxy", async (t) => {
    const fixture = await setup(t);
    let authorization: string | undefined;
    fixture.egress.prependListener("request", (req) => {
      authorization = req.headers["proxy-authorization"];
    });
    const restore = configureUpstreamProxy(
      `http://user:pass@127.0.0.1:${fixture.egressPort}`,
    );
    try {
      assert.equal((await request(fixture.lensPort, "POST")).status, 200);
      assert.equal(
        authorization,
        `Basic ${Buffer.from("user:pass").toString("base64")}`,
      );
    } finally {
      restore();
    }
  });
  it("validates HTTP(S) URLs and rejects unsupported settings without echoing them", () => {
    assert.equal(
      validateUpstreamProxy("https://localhost:8888"),
      "https://localhost:8888/",
    );
    for (const value of [
      undefined,
      false,
      "",
      " localhost",
      "socks5://localhost:1080",
      "http://localhost/path",
      "http://localhost?query",
      "http://localhost#fragment",
      "http://localhost:99999",
      "http://%invalid@localhost",
    ]) {
      assert.throws(
        () => validateUpstreamProxy(value),
        /Upstream proxy must be/,
      );
    }
  });

  it("routes POST streams through egress while retaining captures", async (t) => {
    const fixture = await setup(t);
    const response = await request(fixture.lensPort, "POST");
    assert.equal(response.status, 200);
    assert.equal(response.body, "data: first\n\ndata: last\n\n");
    assert.equal(fixture.proxyRequests.length, 1);
    assert.equal(fixture.upstreamRequests, 1);
    assert.equal(fixture.captures.length, 1);
  });

  it("routes non-POST requests through egress too", async (t) => {
    const fixture = await setup(t);
    assert.equal((await request(fixture.lensPort, "GET")).status, 200);
    assert.equal(fixture.proxyRequests.length, 1);
    assert.equal(fixture.upstreamRequests, 1);
  });

  it("does not inherit environment bypasses for upstream requests", async (t) => {
    const original = process.env.NO_PROXY;
    process.env.NO_PROXY = "*";
    t.after(() => {
      if (original === undefined) {
        delete process.env.NO_PROXY;
      } else {
        process.env.NO_PROXY = original;
      }
    });
    const fixture = await setup(t);
    assert.equal((await request(fixture.lensPort, "POST")).status, 200);
    assert.equal(fixture.proxyRequests.length, 1);
  });

  it("does not fall back when the proxy rejects a request", async (t) => {
    const fixture = await setup(t);
    fixture.egress.removeAllListeners("request");
    fixture.egress.on("request", (_req, res) => {
      res.writeHead(407);
      res.end();
    });
    assert.equal((await request(fixture.lensPort, "POST")).status, 407);
    assert.equal(fixture.upstreamRequests, 0);
  });

  it("rejects an untrusted upstream certificate inside the tunnel", async (t) => {
    const fixture = await setup(t, true, false);
    assert.equal((await request(fixture.lensPort, "POST")).status, 502);
    assert.match(fixture.proxyRequests[0], /^CONNECT localhost:/);
    assert.equal(fixture.upstreamRequests, 0);
  });

  it("tunnels HTTPS through CONNECT with certificate verification", async (t) => {
    const fixture = await setup(t, true);
    assert.equal((await request(fixture.lensPort, "POST")).status, 200);
    assert.match(fixture.proxyRequests[0], /^CONNECT localhost:/);
    assert.equal(fixture.upstreamRequests, 1);
    assert.equal(fixture.captures.length, 1);
  });

  it("returns 502 without contacting the upstream when egress fails", async (t) => {
    const fixture = await setup(t);
    await new Promise<void>((resolve) => fixture.egress.close(() => resolve()));
    const response = await request(fixture.lensPort, "POST");
    assert.equal(response.status, 502);
    assert.equal(fixture.upstreamRequests, 0);
    assert.equal(fixture.proxyRequests.length, 0);
  });
});
