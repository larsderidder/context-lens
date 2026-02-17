/**
 * HTTP forwarding logic for the proxy.
 *
 * Receives incoming requests, forwards them to the appropriate LLM upstream,
 * captures the raw request/response pair, and pipes the response
 * back to the client. Zero external dependencies.
 */

import http from "node:http";
import https from "node:https";
import url from "node:url";
import zlib from "node:zlib";

import type { CaptureData } from "./capture.js";
import { selectHeaders } from "./headers.js";
import {
  classifyRequest,
  extractSource,
  resolveTargetUrl,
  type ApiFormat,
  type Provider,
  type Upstreams,
} from "./routing.js";

type JsonPrimitive = string | number | boolean | null;
type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
type JsonObject = { [key: string]: JsonValue };
type HeaderMap = Record<string, string | string[] | undefined>;

export interface RequestContext {
  provider: Provider | string;
  apiFormat: ApiFormat | string;
  path: string;
  source: string | null;
  sessionId: string | null;
  headers: HeaderMap;
  body: JsonValue | null;
  rawBody: Buffer;
}

export interface ResponseContext {
  status: number;
  headers: HeaderMap;
  body: string;
  isStreaming: boolean;
  sessionId: string | null;
}

export interface ProxyPlugin {
  name: string;
  onRequest?: (ctx: RequestContext) => RequestContext | Promise<RequestContext>;
  onResponse?: (ctx: ResponseContext) => ResponseContext | Promise<ResponseContext>;
  onStreamChunk?: (chunk: Buffer, sessionId: string | null) => Buffer;
  onStreamEnd?: (sessionId: string | null) => Buffer | null;
  onCapture?: (capture: CaptureData) => void | Promise<void>;
}

export interface ForwardOptions {
  upstreams: Upstreams;
  allowTargetOverride: boolean;
  onCapture: (capture: CaptureData) => void;
  plugins?: ProxyPlugin[];
  logTraffic?: boolean;
}

async function runRequestPlugins(
  plugins: ProxyPlugin[],
  ctx: RequestContext,
): Promise<RequestContext> {
  let current = ctx;
  for (const plugin of plugins) {
    if (!plugin.onRequest) continue;
    try {
      current = await plugin.onRequest(current);
    } catch (err: unknown) {
      console.error(
        `Plugin "${plugin.name}" onRequest error:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return current;
}

async function runResponsePlugins(
  plugins: ProxyPlugin[],
  ctx: ResponseContext,
): Promise<ResponseContext> {
  let current = ctx;
  for (const plugin of plugins) {
    if (!plugin.onResponse) continue;
    try {
      current = await plugin.onResponse(current);
    } catch (err: unknown) {
      console.error(
        `Plugin "${plugin.name}" onResponse error:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return current;
}

function runCapturePlugins(plugins: ProxyPlugin[], capture: CaptureData): void {
  for (const plugin of plugins) {
    if (!plugin.onCapture) continue;
    try {
      const result = plugin.onCapture(capture);
      if (result && typeof result.catch === "function") {
        result.catch((err: unknown) => {
          console.error(
            `Plugin "${plugin.name}" onCapture async error:`,
            err instanceof Error ? err.message : String(err),
          );
        });
      }
    } catch (err: unknown) {
      console.error(
        `Plugin "${plugin.name}" onCapture error:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

/**
 * Build headers to send to the upstream, stripping proxy-internal ones.
 */
function buildForwardHeaders(
  reqHeaders: HeaderMap,
  targetHost: string | null,
  bodyLength?: number,
): HeaderMap {
  const forwardHeaders: HeaderMap = { ...reqHeaders };
  delete forwardHeaders["x-target-url"];
  delete forwardHeaders.host;
  delete forwardHeaders["accept-encoding"];
  if (targetHost) {
    forwardHeaders.host = targetHost;
  }
  if (bodyLength != null) {
    delete forwardHeaders["transfer-encoding"];
    forwardHeaders["content-length"] = String(bodyLength);
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
    req.headers as HeaderMap,
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

function decodeRequestBuffer(
  bodyBuffer: Buffer,
  contentEncoding: string,
): Buffer {
  try {
    if (contentEncoding === "zstd") {
      const zstdDecompressSync = (
        zlib as unknown as {
          zstdDecompressSync?: (data: Buffer) => Buffer;
        }
      ).zstdDecompressSync;
      return zstdDecompressSync ? zstdDecompressSync(bodyBuffer) : bodyBuffer;
    }
    if (contentEncoding === "br") {
      return zlib.brotliDecompressSync(bodyBuffer);
    }
    if (contentEncoding === "gzip" || contentEncoding === "deflate") {
      return zlib.unzipSync(bodyBuffer);
    }
    return bodyBuffer;
  } catch {
    return bodyBuffer;
  }
}

/**
 * Create the main proxy request handler.
 */
export function createProxyHandler(
  opts: ForwardOptions,
): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  const plugins = opts.plugins ?? [];
  const hasRequestPlugins = plugins.some((p) => p.onRequest);
  const hasResponsePlugins = plugins.some((p) => p.onResponse);
  const hasStreamPlugins = plugins.some((p) => p.onStreamChunk || p.onStreamEnd);
  const hasCapturePlugins = plugins.some((p) => p.onCapture);
  const logTraffic = opts.logTraffic ?? true;

  return function handleProxy(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): void {
    const parsedUrl = url.parse(req.url!);
    const { source, sessionId, cleanPath } = extractSource(parsedUrl.pathname!);
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

    if (logTraffic) {
      const hasAuth = !!req.headers.authorization;
      const sourceTag = source ? `[${source}]` : "";
      console.log(
        `${req.method} ${req.url} → ${targetUrl} [${provider}] ${sourceTag} auth=${hasAuth}`,
      );
    }

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
      const contentEncoding = (
        req.headers["content-encoding"] || ""
      ).toString().toLowerCase();

      // Parse decoded body for capture/plugins, but forward original bytes unless changed.
      const parsedBuffer = decodeRequestBuffer(bodyBuffer, contentEncoding);
      const bodyText = parsedBuffer.toString("utf8");

      let bodyJson: JsonValue | null = null;
      try {
        bodyJson = JSON.parse(bodyText) as JsonValue;
      } catch {
        // Not JSON; capture as null.
      }

      const requestCtx: RequestContext = {
        provider,
        apiFormat,
        path: cleanPath,
        source,
        sessionId,
        headers: { ...req.headers } as HeaderMap,
        body: bodyJson,
        rawBody: bodyBuffer,
      };

      const doForward = (ctx: RequestContext): void => {
        // If plugins changed parsed body, serialize new plain JSON.
        let forwardBuffer = bodyBuffer;
        let bodyWasModified = false;
        if (ctx.body && ctx.body !== bodyJson) {
          forwardBuffer = Buffer.from(JSON.stringify(ctx.body), "utf8");
          bodyWasModified = true;
        }

        if (bodyWasModified && contentEncoding) {
          delete ctx.headers["content-encoding"];
        }

        const targetParsed = url.parse(targetUrl);
        const forwardHeaders = buildForwardHeaders(
          ctx.headers,
          targetParsed.host,
          forwardBuffer.length,
        );

        const protocol = targetParsed.protocol === "https:" ? https : http;
        const startTime = performance.now();
        let firstByteTime = 0;
        let requestSentTime = 0;
        const reqBytes = forwardBuffer.length;

        const proxyReq = protocol.request(
          {
            hostname: targetParsed.hostname,
            port: targetParsed.port,
            path: targetParsed.path,
            method: req.method,
            headers: forwardHeaders,
          },
          (proxyRes) => {
            if (logTraffic) {
              console.log(`  ← ${proxyRes.statusCode} ${proxyRes.statusMessage}`);
            }

            const isStreaming =
              proxyRes.headers["content-type"]?.includes("text/event-stream");
            const shouldBufferResponse = hasResponsePlugins && !isStreaming;

            if (!shouldBufferResponse) {
              res.writeHead(proxyRes.statusCode!, proxyRes.headers);
            }

            let respBytes = 0;
            const respChunks: Buffer[] = [];

            proxyRes.on("data", (chunk: Buffer) => {
              if (!firstByteTime) firstByteTime = performance.now();
              respBytes += chunk.length;
              respChunks.push(chunk);

              if (!shouldBufferResponse && !res.destroyed) {
                let out = chunk;
                if (hasStreamPlugins && isStreaming) {
                  for (const plugin of plugins) {
                    if (!plugin.onStreamChunk) continue;
                    try {
                      out = plugin.onStreamChunk(out, sessionId);
                    } catch (err: unknown) {
                      console.error(
                        `Plugin "${plugin.name}" onStreamChunk error:`,
                        err instanceof Error ? err.message : String(err),
                      );
                    }
                  }
                }
                res.write(out);
              }
            });

            proxyRes.on("end", () => {
              const endTime = performance.now();
              if (!firstByteTime) firstByteTime = endTime;

              if (hasStreamPlugins && isStreaming && !res.destroyed) {
                for (const plugin of plugins) {
                  if (!plugin.onStreamEnd) continue;
                  try {
                    const flushed = plugin.onStreamEnd(sessionId);
                    if (flushed && flushed.length > 0) {
                      res.write(flushed);
                    }
                  } catch (err: unknown) {
                    console.error(
                      `Plugin "${plugin.name}" onStreamEnd error:`,
                      err instanceof Error ? err.message : String(err),
                    );
                  }
                }
              }

              const respBody = Buffer.concat(respChunks).toString("utf8");

              const finishResponse = (
                finalBody: string,
                finalHeaders: HeaderMap,
                finalStatus: number,
              ): void => {
                if (shouldBufferResponse && !res.headersSent) {
                  const outBuf = Buffer.from(finalBody, "utf8");
                  const outHeaders = { ...finalHeaders };
                  outHeaders["content-length"] = String(outBuf.length);
                  delete outHeaders["transfer-encoding"];
                  res.writeHead(finalStatus, outHeaders);
                  res.end(outBuf);
                } else if (!res.destroyed) {
                  res.end();
                }

                const capture: CaptureData = {
                  timestamp: new Date().toISOString(),
                  method: req.method!,
                  path: cleanPath,
                  source,
                  provider,
                  apiFormat,
                  targetUrl,
                  requestHeaders: selectHeaders(ctx.headers),
                  requestBody:
                    ctx.body &&
                    typeof ctx.body === "object" &&
                    !Array.isArray(ctx.body)
                      ? (ctx.body as Record<string, any>)
                      : null,
                  requestBytes: reqBytes,
                  responseStatus: proxyRes.statusCode || 0,
                  responseHeaders: selectHeaders(
                    proxyRes.headers as Record<string, any>,
                  ),
                  responseBody: finalBody,
                  responseIsStreaming: !!isStreaming,
                  responseBytes: respBytes,
                  sessionId,
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
                if (hasCapturePlugins) {
                  runCapturePlugins(plugins, capture);
                }
              };

              if (shouldBufferResponse) {
                const responseCtx: ResponseContext = {
                  status: proxyRes.statusCode || 0,
                  headers: { ...((proxyRes.headers as HeaderMap) || {}) },
                  body: respBody,
                  isStreaming: false,
                  sessionId,
                };

                runResponsePlugins(plugins, responseCtx)
                  .then((finalCtx) => {
                    finishResponse(finalCtx.body, finalCtx.headers, finalCtx.status);
                  })
                  .catch((err: unknown) => {
                    console.error(
                      "Response plugin pipeline error:",
                      err instanceof Error ? err.message : String(err),
                    );
                    finishResponse(
                      respBody,
                      proxyRes.headers as HeaderMap,
                      proxyRes.statusCode || 0,
                    );
                  });
              } else {
                finishResponse(
                  respBody,
                  proxyRes.headers as HeaderMap,
                  proxyRes.statusCode || 0,
                );
              }
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
        proxyReq.write(forwardBuffer);
        proxyReq.end();
      };

      if (hasRequestPlugins) {
        runRequestPlugins(plugins, requestCtx)
          .then(doForward)
          .catch((err: unknown) => {
            console.error(
              "Request plugin pipeline error:",
              err instanceof Error ? err.message : String(err),
            );
            doForward(requestCtx);
          });
      } else {
        doForward(requestCtx);
      }
    });
  };
}
