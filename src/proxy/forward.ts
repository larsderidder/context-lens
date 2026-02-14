/**
 * HTTP forwarding logic for the proxy.
 *
 * Receives incoming requests, forwards them to the appropriate LLM upstream,
 * captures the raw request/response pair to disk, and pipes the response
 * back to the client. Zero external dependencies.
 */

import http from "node:http";
import https from "node:https";
import url from "node:url";

import type { CaptureData } from "./capture.js";
import { selectHeaders } from "./headers.js";
import {
  classifyRequest,
  extractSource,
  resolveTargetUrl,
  type Upstreams,
} from "./routing.js";

export interface ForwardOptions {
  upstreams: Upstreams;
  allowTargetOverride: boolean;
  onCapture: (capture: CaptureData) => void;
}

/**
 * Build headers to send to the upstream, stripping proxy-internal ones.
 */
function buildForwardHeaders(
  reqHeaders: http.IncomingHttpHeaders,
  targetHost: string | null,
  bodyLength?: number,
): Record<string, any> {
  const forwardHeaders = { ...reqHeaders } as Record<string, any>;
  delete forwardHeaders["x-target-url"];
  delete forwardHeaders.host;
  if (targetHost) {
    forwardHeaders.host = targetHost;
  }
  if (bodyLength != null) {
    delete forwardHeaders["transfer-encoding"];
    forwardHeaders["content-length"] = bodyLength;
  }
  return forwardHeaders;
}

/**
 * Wire up error/close handlers between client response and upstream request.
 */
function attachLifecycleHandlers(
  res: http.ServerResponse,
  proxyReq: http.ClientRequest,
): void {
  res.on("close", () => {
    if (!proxyReq.destroyed) proxyReq.destroy();
  });

  proxyReq.on("error", (err) => {
    if (res.destroyed) return;
    const detail = err.message || ("code" in err ? err.code : "unknown");
    console.error("Proxy error:", detail);
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
    }
    if (!res.destroyed) {
      res.end(JSON.stringify({ error: "Proxy error", details: err.message }));
    }
  });
}

/**
 * Resolve headers for routing, filtering x-target-url when not allowed.
 */
function headersForResolution(
  headers: http.IncomingHttpHeaders,
  remoteAddr: string | undefined,
  allowTargetOverride: boolean,
): Record<string, string | undefined> {
  const h = headers as Record<string, string | undefined>;
  if (
    h["x-target-url"] &&
    !(allowTargetOverride && isLocalRemote(remoteAddr))
  ) {
    const { "x-target-url": _drop, ...rest } = h;
    return rest;
  }
  return h;
}

function isLocalRemote(addr: string | undefined): boolean {
  if (!addr) return false;
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/**
 * Forward a non-POST request (GET /v1/models, OPTIONS, etc.) without capturing.
 */
function forwardPassthrough(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetUrl: string,
  body: Buffer | null,
): void {
  const targetParsed = url.parse(targetUrl);
  const forwardHeaders = buildForwardHeaders(
    req.headers,
    targetParsed.host,
    body ? body.length : undefined,
  );

  const protocol = targetParsed.protocol === "https:" ? https : http;
  const proxyReq = protocol.request(
    {
      hostname: targetParsed.hostname,
      port: targetParsed.port,
      path: targetParsed.path,
      method: req.method,
      headers: forwardHeaders,
    },
    (proxyRes) => {
      if (!res.headersSent)
        res.writeHead(proxyRes.statusCode!, proxyRes.headers);
      proxyRes.pipe(res);
      proxyRes.on("error", (err) => {
        console.error("Upstream response error (forward):", err.message);
        if (!res.destroyed) res.end();
      });
    },
  );

  attachLifecycleHandlers(res, proxyReq);
  if (body) proxyReq.write(body);
  proxyReq.end();
}

/**
 * Create the main proxy request handler.
 */
export function createProxyHandler(
  opts: ForwardOptions,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return function handleProxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const parsedUrl = url.parse(req.url!);
    const { source, cleanPath } = extractSource(parsedUrl.pathname!);
    const search = parsedUrl.search || null;

    const routingHeaders = headersForResolution(
      req.headers,
      req.socket.remoteAddress,
      opts.allowTargetOverride,
    );
    const { targetUrl, provider } = resolveTargetUrl(
      cleanPath,
      search,
      routingHeaders,
      opts.upstreams,
    );
    const { apiFormat } = classifyRequest(cleanPath, routingHeaders);

    const hasAuth = !!req.headers.authorization;
    const sourceTag = source ? `[${source}]` : "";
    console.log(
      `${req.method} ${req.url} → ${targetUrl} [${provider}] ${sourceTag} auth=${hasAuth}`,
    );

    // Non-POST requests: pass through without capturing
    if (req.method !== "POST") {
      forwardPassthrough(req, res, targetUrl, null);
      return;
    }

    // Buffer the request body
    const chunks: Buffer[] = [];
    let clientAborted = false;
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    req.on("error", () => {
      clientAborted = true;
    });

    req.on("end", () => {
      if (clientAborted) return;

      const bodyBuffer = Buffer.concat(chunks);
      const bodyText = bodyBuffer.toString("utf8");

      // Try to parse as JSON (for the capture file), but forward regardless
      let bodyJson: Record<string, any> | null = null;
      try {
        bodyJson = JSON.parse(bodyText);
      } catch {
        // Not JSON; capture as null, forward the raw bytes
      }

      const targetParsed = url.parse(targetUrl);
      const forwardHeaders = buildForwardHeaders(
        req.headers,
        targetParsed.host,
        bodyBuffer.length,
      );

      const protocol = targetParsed.protocol === "https:" ? https : http;
      const startTime = performance.now();
      let firstByteTime = 0;
      let requestSentTime = 0;
      const reqBytes = bodyBuffer.length;

      const proxyReq = protocol.request(
        {
          hostname: targetParsed.hostname,
          port: targetParsed.port,
          path: targetParsed.path,
          method: req.method,
          headers: forwardHeaders,
        },
        (proxyRes) => {
          console.log(`  ← ${proxyRes.statusCode} ${proxyRes.statusMessage}`);
          res.writeHead(proxyRes.statusCode!, proxyRes.headers);

          const isStreaming =
            proxyRes.headers["content-type"]?.includes("text/event-stream");
          let respBytes = 0;
          const respChunks: Buffer[] = [];

          proxyRes.on("data", (chunk: Buffer) => {
            if (!firstByteTime) firstByteTime = performance.now();
            respBytes += chunk.length;
            respChunks.push(chunk);
            if (!res.destroyed) res.write(chunk);
          });

          proxyRes.on("end", () => {
            const endTime = performance.now();
            if (!firstByteTime) firstByteTime = endTime;

            const respBody = Buffer.concat(respChunks).toString("utf8");

            const capture: CaptureData = {
              timestamp: new Date().toISOString(),
              method: req.method!,
              path: cleanPath,
              source,
              provider,
              apiFormat,
              targetUrl,
              requestHeaders: selectHeaders(req.headers),
              requestBody: bodyJson,
              requestBytes: reqBytes,
              responseStatus: proxyRes.statusCode || 0,
              responseHeaders: selectHeaders(
                proxyRes.headers as Record<string, any>,
              ),
              responseBody: respBody,
              responseIsStreaming: !!isStreaming,
              responseBytes: respBytes,
              timings: {
                send_ms: Math.round(
                  Math.max(0, (requestSentTime || firstByteTime) - startTime),
                ),
                wait_ms: Math.round(
                  Math.max(0, firstByteTime - (requestSentTime || startTime)),
                ),
                receive_ms: Math.round(endTime - firstByteTime),
                total_ms: Math.round(endTime - startTime),
              },
            };

            opts.onCapture(capture);

            if (!res.destroyed) res.end();
          });

          proxyRes.on("error", (err) => {
            console.error("Upstream response error:", err.message);
            if (!res.destroyed) res.end();
          });
        },
      );

      attachLifecycleHandlers(res, proxyReq);
      proxyReq.on("finish", () => {
        requestSentTime = performance.now();
      });
      proxyReq.write(bodyBuffer);
      proxyReq.end();
    });
  };
}
