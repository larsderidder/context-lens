/**
 * Capture ingestion: bridges raw proxy captures into the Store.
 *
 * Takes a CaptureData object (raw request/response from disk) and
 * runs the full analysis pipeline, then stores the result.
 */

import { estimateTokens, parseContextInfo } from "../core.js";
import type { CaptureData } from "../proxy/capture.js";
import type { Store } from "../server/store.js";
import type { ContextInfo, RequestMeta, ResponseData } from "../types.js";

/**
 * Process a single capture and feed it into the Store.
 */
export function ingestCapture(store: Store, capture: CaptureData): void {
  const { provider, apiFormat, requestBody, responseBody } = capture;

  // Build contextInfo from the request body
  let contextInfo: ContextInfo;
  if (
    requestBody &&
    typeof requestBody === "object" &&
    !Array.isArray(requestBody)
  ) {
    const body = { ...(requestBody as Record<string, unknown>) };
    // Gemini: model is in the URL path, not in the body
    if (apiFormat === "gemini" && !body.model) {
      const modelMatch = capture.path.match(/\/models\/([^/:]+)/);
      if (modelMatch) body.model = modelMatch[1];
    }
    contextInfo = parseContextInfo(provider, body, apiFormat);
  } else {
    // Non-JSON request: create a raw contextInfo
    contextInfo = {
      provider,
      apiFormat: "raw",
      model: "unknown",
      systemTokens: 0,
      toolsTokens: 0,
      messagesTokens: estimateTokens(responseBody),
      totalTokens: estimateTokens(responseBody),
      systemPrompts: [],
      tools: [],
      messages: [
        {
          role: "raw",
          content: responseBody.substring(0, 2000),
          tokens: estimateTokens(responseBody),
        },
      ],
    };
  }

  // Parse the response
  let responseData: ResponseData;
  if (capture.responseIsStreaming) {
    responseData = { streaming: true, chunks: responseBody };
  } else {
    try {
      responseData = JSON.parse(responseBody);
    } catch {
      responseData = { raw: responseBody };
    }
  }

  // Build request metadata
  const meta: RequestMeta = {
    httpStatus: capture.responseStatus,
    timings: {
      ...capture.timings,
      tokens_per_second: null,
    },
    requestBytes: capture.requestBytes,
    responseBytes: capture.responseBytes,
    targetUrl: capture.targetUrl,
    requestHeaders: capture.requestHeaders,
    responseHeaders: capture.responseHeaders,
  };

  // Feed into the store (which handles fingerprinting, scoring, etc.)
  store.storeRequest(
    contextInfo,
    responseData,
    capture.source,
    requestBody &&
      typeof requestBody === "object" &&
      !Array.isArray(requestBody)
      ? (requestBody as Record<string, any>)
      : undefined,
    meta,
    capture.requestHeaders,
    capture.sessionId ?? null,
  );
}
