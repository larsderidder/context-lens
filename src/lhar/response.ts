export interface ParsedResponseUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  thinkingTokens: number;
  model: string | null;
  finishReasons: string[];
  stream: boolean;
}

/**
 * Extract the response ID from a response object.
 *
 * Works for both non-streaming (direct JSON) and streaming (SSE chunks)
 * responses. For streaming, scans for `response.completed` or
 * `response.created` SSE events that carry the response object with its ID.
 */
export function extractResponseId(responseData: any): string | null {
  if (!responseData) return null;

  // Non-streaming: direct JSON response with id field
  if (responseData.id) return responseData.id;
  if (responseData.response_id) return responseData.response_id;

  // Streaming: scan SSE chunks for response events
  if (responseData.streaming && typeof responseData.chunks === "string") {
    const lines = responseData.chunks.split("\n");
    for (const line of lines) {
      if (!line.startsWith("data: ")) continue;
      const data = line.slice(6).trim();
      if (data === "[DONE]") continue;
      try {
        const parsed = JSON.parse(data);
        // OpenAI Responses API: response.completed / response.created events
        // carry the full response object including its id
        if (parsed.response?.id) return parsed.response.id;
        // Direct id on the event object (some streaming formats)
        if (
          parsed.type === "response.completed" ||
          parsed.type === "response.created"
        ) {
          if (parsed.id) return parsed.id;
        }
      } catch {
        // Skip unparseable lines
      }
    }
  }

  return null;
}

export function parseResponseUsage(responseData: any): ParsedResponseUsage {
  const result: ParsedResponseUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    model: null,
    finishReasons: [],
    stream: false,
  };

  if (!responseData) return result;

  // Streaming response: scan SSE chunks for usage
  if (responseData.streaming && typeof responseData.chunks === "string") {
    result.stream = true;
    return parseStreamingUsage(responseData.chunks, result);
  }

  // Non-streaming response
  if (responseData.usage) {
    const u = responseData.usage;
    result.inputTokens = u.input_tokens || u.prompt_tokens || 0;
    result.outputTokens = u.output_tokens || u.completion_tokens || 0;
    result.cacheReadTokens = u.cache_read_input_tokens || 0;
    result.cacheWriteTokens = u.cache_creation_input_tokens || 0;
    result.thinkingTokens = u.thinking_tokens || 0;
  }

  // Gemini usageMetadata (direct or inside Code Assist wrapper .response)
  const geminiResp = responseData.usageMetadata
    ? responseData
    : responseData.response;
  if (geminiResp?.usageMetadata) {
    const u = geminiResp.usageMetadata;
    const prompt = u.promptTokenCount || 0;
    const cached = u.cachedContentTokenCount || 0;
    // Gemini's promptTokenCount includes cached tokens; subtract to get non-cached input
    result.inputTokens = prompt - cached;
    result.outputTokens =
      u.candidatesTokenCount || u.totalTokenCount - prompt || 0;
    result.cacheReadTokens = cached;
    result.thinkingTokens = u.thoughtsTokenCount || 0;
  }

  result.model =
    responseData.model ||
    responseData.modelVersion ||
    geminiResp?.modelVersion ||
    null;

  if (responseData.stop_reason) {
    result.finishReasons = [responseData.stop_reason];
  } else if (responseData.choices && Array.isArray(responseData.choices)) {
    result.finishReasons = responseData.choices
      .map((c: any) => c.finish_reason)
      .filter(Boolean);
  } else if (
    responseData.candidates &&
    Array.isArray(responseData.candidates)
  ) {
    result.finishReasons = responseData.candidates
      .map((c: any) => c.finishReason)
      .filter(Boolean);
  } else if (geminiResp?.candidates && Array.isArray(geminiResp.candidates)) {
    result.finishReasons = geminiResp.candidates
      .map((c: any) => c.finishReason)
      .filter(Boolean);
  }

  return result;
}

function parseStreamingUsage(
  chunks: string,
  result: ParsedResponseUsage,
): ParsedResponseUsage {
  // Parse SSE events looking for usage data
  const lines = chunks.split("\n");
  for (const line of lines) {
    if (!line.startsWith("data: ")) continue;
    const data = line.slice(6).trim();
    if (data === "[DONE]") continue;

    try {
      const parsed = JSON.parse(data);

      // Anthropic message_start: contains model
      if (parsed.type === "message_start" && parsed.message) {
        result.model = parsed.message.model || result.model;
        if (parsed.message.usage) {
          result.inputTokens = parsed.message.usage.input_tokens || 0;
          result.cacheReadTokens =
            parsed.message.usage.cache_read_input_tokens || 0;
          result.cacheWriteTokens =
            parsed.message.usage.cache_creation_input_tokens || 0;
        }
      }

      // Anthropic message_delta: contains stop_reason and output token count
      if (parsed.type === "message_delta") {
        if (parsed.delta?.stop_reason) {
          result.finishReasons = [parsed.delta.stop_reason];
        }
        if (parsed.usage) {
          result.outputTokens =
            parsed.usage.output_tokens || result.outputTokens;
        }
      }

      // OpenAI streaming: final chunk with usage
      if (parsed.usage && parsed.choices) {
        result.inputTokens = parsed.usage.prompt_tokens || result.inputTokens;
        result.outputTokens =
          parsed.usage.completion_tokens || result.outputTokens;
      }
      if (parsed.choices?.[0]?.finish_reason) {
        result.finishReasons = [parsed.choices[0].finish_reason];
      }
      // Gemini streaming: usageMetadata in chunks
      if (parsed.usageMetadata) {
        const prompt = parsed.usageMetadata.promptTokenCount || 0;
        const cached = parsed.usageMetadata.cachedContentTokenCount || 0;
        // Gemini's promptTokenCount includes cached tokens; subtract to get non-cached input
        if (prompt > 0) {
          result.inputTokens = prompt - cached;
          result.cacheReadTokens = cached;
        }
        result.outputTokens =
          parsed.usageMetadata.candidatesTokenCount || result.outputTokens;
        result.thinkingTokens =
          parsed.usageMetadata.thoughtsTokenCount || result.thinkingTokens;
      }
      if (parsed.candidates?.[0]?.finishReason) {
        result.finishReasons = [parsed.candidates[0].finishReason];
      }
      if (parsed.modelVersion) {
        result.model = parsed.modelVersion;
      }
      if (parsed.model) {
        result.model = parsed.model;
      }
    } catch {
      // Skip unparseable lines
    }
  }
  return result;
}
