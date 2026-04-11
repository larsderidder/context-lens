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
 * Iterate over parsed SSE data events from a raw chunk string.
 * Skips non-data lines, [DONE] sentinels, and unparseable JSON.
 * Accepts "data:" with or without a trailing space (SSE spec allows both).
 */
function* parseSseEvents(chunks: string): Generator<any> {
  for (const line of chunks.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trimStart();
    if (data === "[DONE]") continue;
    try {
      yield JSON.parse(data);
    } catch {
      // Skip unparseable lines
    }
  }
}

/**
 * Apply Gemini usageMetadata to the result.
 * Gemini's promptTokenCount includes cached tokens; subtract to get non-cached input.
 * Guards against prompt === 0 to avoid overwriting valid data from other providers.
 */
function applyGeminiUsage(
  usageMetadata: any,
  result: ParsedResponseUsage,
): void {
  const prompt = usageMetadata.promptTokenCount || 0;
  const cached = usageMetadata.cachedContentTokenCount || 0;
  if (prompt > 0) {
    result.inputTokens = prompt - cached;
    result.cacheReadTokens = cached;
  }
  result.outputTokens =
    usageMetadata.candidatesTokenCount
    || (usageMetadata.totalTokenCount != null ? usageMetadata.totalTokenCount - prompt : 0)
    || result.outputTokens;
  result.thinkingTokens = usageMetadata.thoughtsTokenCount || result.thinkingTokens;
}

/**
 * Apply OpenAI / Anthropic / Responses API usage details to the result.
 * Detail sub-objects are checked first (most specific), then top-level aliases,
 * then the existing result value as fallback for streaming accumulation.
 */
function applyUsageDetails(usage: any, result: ParsedResponseUsage): void {
  result.inputTokens = usage.input_tokens || usage.prompt_tokens || result.inputTokens;
  result.outputTokens = usage.output_tokens || usage.completion_tokens || result.outputTokens;
  result.thinkingTokens =
    usage.completion_tokens_details?.reasoning_tokens ||
    usage.output_tokens_details?.reasoning_tokens ||
    usage.thinking_tokens ||
    usage.reasoning_tokens ||
    result.thinkingTokens;
  result.cacheReadTokens =
    usage.prompt_tokens_details?.cached_tokens ||
    usage.input_tokens_details?.cached_tokens ||
    usage.cache_read_input_tokens ||
    result.cacheReadTokens;
  result.cacheWriteTokens = usage.cache_creation_input_tokens || result.cacheWriteTokens;
}

/**
 * Extract finish reasons from a response event or chunk.
 * Tries Anthropic, OpenAI, and Gemini formats in order.
 */
function extractFinishReasons(data: any): string[] {
  if (data.stop_reason) return [data.stop_reason];
  if (data.delta?.stop_reason) return [data.delta.stop_reason];

  const choices = data.choices;
  if (Array.isArray(choices)) {
    const reasons = choices.map((c: any) => c.finish_reason).filter(Boolean);
    if (reasons.length > 0) return reasons;
  }

  const candidates = data.candidates ?? data.response?.candidates;
  if (Array.isArray(candidates)) {
    const reasons = candidates.map((c: any) => c.finishReason).filter(Boolean);
    if (reasons.length > 0) return reasons;
  }

  return [];
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
  if (responseData.response?.id) return responseData.response.id;
  if (responseData.response?.response_id) return responseData.response.response_id;

  // Streaming: scan SSE chunks for response events
  if (responseData.streaming && typeof responseData.chunks === "string") {
    for (const parsed of parseSseEvents(responseData.chunks)) {
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

  // OpenAI / Anthropic / Responses API usage (direct or wrapped)
  const usage = responseData.usage ?? responseData.response?.usage;
  if (usage) applyUsageDetails(usage, result);

  // Gemini usageMetadata (direct or inside Code Assist wrapper .response)
  const geminiMeta = responseData.usageMetadata ?? responseData.response?.usageMetadata;
  if (geminiMeta) applyGeminiUsage(geminiMeta, result);

  result.model =
    responseData.model ||
    responseData.response?.model ||
    responseData.modelVersion ||
    responseData.response?.modelVersion ||
    null;

  result.finishReasons = extractFinishReasons(responseData);

  return result;
}

function parseStreamingUsage(
  chunks: string,
  result: ParsedResponseUsage,
): ParsedResponseUsage {
  for (const parsed of parseSseEvents(chunks)) {
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
      if (parsed.usage) {
        result.outputTokens =
          parsed.usage.output_tokens || result.outputTokens;
      }
    }

    // OpenAI streaming: final chunk with usage
    if (parsed.usage && parsed.choices) {
      applyUsageDetails(parsed.usage, result);
    }

    // Responses streaming: response.completed/response.created events
    // carry usage in parsed.response.usage
    if (parsed.response?.usage) {
      applyUsageDetails(parsed.response.usage, result);
    }

    // Finish reasons (all providers)
    const reasons = extractFinishReasons(parsed);
    if (reasons.length > 0) result.finishReasons = reasons;

    // Gemini streaming: usageMetadata (direct or inside Code Assist wrapper)
    const geminiMeta = parsed.usageMetadata || parsed.response?.usageMetadata;
    if (geminiMeta) applyGeminiUsage(geminiMeta, result);

    // Model resolution (all providers, single || chain)
    result.model =
      parsed.message?.model ||
      parsed.response?.model ||
      parsed.modelVersion ||
      parsed.response?.modelVersion ||
      parsed.model ||
      result.model;
  }
  return result;
}
