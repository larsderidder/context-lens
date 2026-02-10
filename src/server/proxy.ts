import http from 'node:http';
import https from 'node:https';
import url from 'node:url';

import type { ContextInfo, RequestMeta, Upstreams } from '../types.js';
import { estimateTokens, detectApiFormat, parseContextInfo, resolveTargetUrl, extractSource } from '../core.js';
import { headersForResolution, selectHeaders } from '../server-utils.js';
import type { Store } from './store.js';

export function forwardRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  parsedUrl: url.UrlWithStringQuery,
  body: Buffer | null,
  opts: { upstreams: Upstreams; allowTargetOverride: boolean },
): void {
  const { targetUrl } = resolveTargetUrl(
    { pathname: parsedUrl.pathname!, search: parsedUrl.search },
    headersForResolution(req.headers, req.socket.remoteAddress, opts.allowTargetOverride),
    opts.upstreams,
  );
  const targetParsed = url.parse(targetUrl);

  const forwardHeaders = { ...req.headers } as Record<string, any>;
  delete forwardHeaders['x-target-url'];
  delete forwardHeaders['host'];
  forwardHeaders['host'] = targetParsed.host;
  // When we buffer the body, replace chunked encoding with exact content-length
  if (body) {
    delete forwardHeaders['transfer-encoding'];
    forwardHeaders['content-length'] = body.length;
  }

  const protocol = targetParsed.protocol === 'https:' ? https : http;
  const proxyReq = protocol.request({
    hostname: targetParsed.hostname,
    port: targetParsed.port,
    path: targetParsed.path,
    method: req.method,
    headers: forwardHeaders,
  }, (proxyRes) => {
    if (!res.headersSent) res.writeHead(proxyRes.statusCode!, proxyRes.headers);
    proxyRes.pipe(res);
    proxyRes.on('error', (err) => {
      console.error('Upstream response error (forward):', err.message);
      if (!res.destroyed) res.end();
    });
  });

  // Abort upstream request if client disconnects
  res.on('close', () => { if (!proxyReq.destroyed) proxyReq.destroy(); });

  proxyReq.on('error', (err) => {
    // Suppress errors from client-initiated disconnects
    if (res.destroyed) return;
    console.error('Proxy error:', err.message || (err as any).code || 'unknown');
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
    }
    if (!res.destroyed) {
      res.end(JSON.stringify({ error: 'Proxy error', details: err.message }));
    }
  });

  if (body) proxyReq.write(body);
  proxyReq.end();
}

export function createProxyHandler(store: Store, opts: { upstreams: Upstreams; allowTargetOverride: boolean }): (req: http.IncomingMessage, res: http.ServerResponse) => void {
  return function handleProxy(req: http.IncomingMessage, res: http.ServerResponse): void {
    const parsedUrl = url.parse(req.url!);
    const { source, cleanPath } = extractSource(parsedUrl.pathname!);

    // Use clean path (without source prefix) for routing
    const cleanUrl = { ...parsedUrl, pathname: cleanPath };
    const { targetUrl, provider } = resolveTargetUrl(
      { pathname: cleanPath, search: parsedUrl.search },
      headersForResolution(req.headers, req.socket.remoteAddress, opts.allowTargetOverride),
      opts.upstreams,
    );
    const hasAuth = !!req.headers['authorization'];
    const sourceTag = source ? `[${source}]` : '';
    console.log(`${req.method} ${req.url} → ${targetUrl} [${provider}] ${sourceTag} auth=${hasAuth}`);

    // For non-POST requests (GET /v1/models, OPTIONS, etc.), pass through directly
    if (req.method !== 'POST') {
      return forwardRequest(req, res, cleanUrl as url.UrlWithStringQuery, null, opts);
    }

    // Collect body as raw Buffers to avoid corrupting multi-byte UTF-8 at chunk boundaries
    const chunks: Buffer[] = [];
    let clientAborted = false;
    req.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    req.on('error', () => { clientAborted = true; });

    req.on('end', () => {
      if (clientAborted) return;

      const bodyBuffer = Buffer.concat(chunks);
      const body = bodyBuffer.toString('utf8');

      let bodyData: Record<string, any>;
      try {
        bodyData = JSON.parse(body);
      } catch (e) {
        console.log(`  ⚠ Body is not JSON (${bodyBuffer.length} bytes), capturing raw`);
        // Still capture the raw request even if body isn't JSON
        const rawInfo: ContextInfo = {
          provider,
          apiFormat: 'raw',
          model: 'unknown',
          systemTokens: 0, toolsTokens: 0,
          messagesTokens: estimateTokens(body),
          totalTokens: estimateTokens(body),
          systemPrompts: [],
          tools: [],
          messages: [{ role: 'raw', content: body.substring(0, 2000), tokens: estimateTokens(body) }],
        };
        store.storeRequest(rawInfo, { raw: true }, source, undefined, undefined, selectHeaders(req.headers));
        return forwardRequest(req, res, cleanUrl as url.UrlWithStringQuery, bodyBuffer, opts);
      }

      console.log(`  ✓ Parsed JSON body (${Object.keys(bodyData).join(', ')})`);
      const apiFormat = detectApiFormat(cleanPath);
      // Gemini: model is in the URL path, not in the body
      if (apiFormat === 'gemini' && !bodyData.model) {
        const modelMatch = cleanPath.match(/\/models\/([^/:]+)/);
        if (modelMatch) bodyData.model = modelMatch[1];
      }
      const contextInfo = parseContextInfo(provider, bodyData, apiFormat);
      // Skip capturing utility endpoints (count_tokens, etc.) — they're not real conversation turns
      const isUtilityEndpoint = /\/count_tokens\b|:countTokens\b|:loadCodeAssist\b|:retrieveUserQuota\b|:listExperiments\b|:onboardUser\b|:fetchAdminControls\b|:recordCodeAssistMetrics\b/.test(cleanPath);

      const targetParsed = url.parse(targetUrl);

      // Forward headers (remove proxy-specific ones)
      const forwardHeaders = { ...req.headers } as Record<string, any>;
      delete forwardHeaders['x-target-url'];
      delete forwardHeaders['host'];
      delete forwardHeaders['transfer-encoding'];
      forwardHeaders['host'] = targetParsed.host;
      // Ensure content-length matches the exact bytes we forward
      forwardHeaders['content-length'] = bodyBuffer.length;

      // Make request to actual API
      const protocol = targetParsed.protocol === 'https:' ? https : http;
      const startTime = performance.now();
      let firstByteTime = 0;
      const reqBytes = bodyBuffer.length;

      const proxyReq = protocol.request({
        hostname: targetParsed.hostname,
        port: targetParsed.port,
        path: targetParsed.path,
        method: req.method,
        headers: forwardHeaders,
      }, (proxyRes) => {
        console.log(`  ← ${proxyRes.statusCode} ${proxyRes.statusMessage}`);
        // Forward response headers
        res.writeHead(proxyRes.statusCode!, proxyRes.headers);
        const httpStatus = proxyRes.statusCode || 0;

        // Handle streaming vs non-streaming
        const isStreaming = proxyRes.headers['content-type']?.includes('text/event-stream');
        let respBytes = 0;

        const capturedReqHeaders = selectHeaders(req.headers);
        const capturedResHeaders = selectHeaders(proxyRes.headers as Record<string, any>);

        // Collect response as Buffer[] to avoid corrupting multi-byte UTF-8 at chunk boundaries
        const respChunks: Buffer[] = [];

        proxyRes.on('data', (chunk: Buffer) => {
          if (!firstByteTime) firstByteTime = performance.now();
          respBytes += chunk.length;
          respChunks.push(chunk);
          if (!res.destroyed) res.write(chunk);
        });

        proxyRes.on('end', () => {
          const endTime = performance.now();
          if (!firstByteTime) firstByteTime = endTime;
          const meta: RequestMeta = {
            httpStatus,
            timings: {
              send_ms: Math.round(firstByteTime - startTime),
              wait_ms: Math.round(firstByteTime - startTime),
              receive_ms: Math.round(endTime - firstByteTime),
              total_ms: Math.round(endTime - startTime),
              tokens_per_second: null,
            },
            requestBytes: reqBytes,
            responseBytes: respBytes,
            targetUrl,
            requestHeaders: capturedReqHeaders,
            responseHeaders: capturedResHeaders,
          };
          const respBody = Buffer.concat(respChunks).toString('utf8');
          if (!isUtilityEndpoint) {
            if (isStreaming) {
              store.storeRequest(contextInfo, { streaming: true, chunks: respBody }, source, bodyData, meta, capturedReqHeaders);
            } else {
              try {
                const responseData = JSON.parse(respBody);
                store.storeRequest(contextInfo, responseData, source, bodyData, meta, capturedReqHeaders);
              } catch (e) {
                store.storeRequest(contextInfo, { raw: respBody }, source, bodyData, meta, capturedReqHeaders);
              }
            }
          }
          if (!res.destroyed) res.end();
        });

        proxyRes.on('error', (err) => {
          console.error('Upstream response error:', err.message);
          if (!res.destroyed) res.end();
        });
      });

      // Abort upstream request if client disconnects
      res.on('close', () => { if (!proxyReq.destroyed) proxyReq.destroy(); });

      proxyReq.on('error', (err) => {
        // Suppress errors from client-initiated disconnects
        if (res.destroyed) return;
        console.error('Proxy error:', err.message || (err as any).code || 'unknown');
        if (!res.headersSent) {
          res.writeHead(502, { 'Content-Type': 'application/json' });
        }
        if (!res.destroyed) {
          res.end(JSON.stringify({ error: 'Proxy error', details: err.message }));
        }
      });

      proxyReq.write(bodyBuffer);
      proxyReq.end();
    });
  };
}

