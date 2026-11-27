export interface ParsedResponseUsage {
  inputTokens: number;
  hasInputTokens: boolean;
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

/** Apply Gemini's inclusive prompt count, preserving omitted streaming fields. */
function applyGeminiUsage(
  usageMetadata: any,
  result: ParsedResponseUsage,
): void {
  const prompt = usageMetadata.promptTokenCount;
  const cached = usageMetadata.cachedContentTokenCount;
  if (prompt != null || cached != null) {
    const total = prompt ?? result.inputTokens + result.cacheReadTokens;
    result.cacheReadTokens = cached ?? result.cacheReadTokens;
    result.inputTokens = Math.max(0, total - result.cacheReadTokens);
    result.hasInputTokens ||= prompt != null;
  }
  if (usageMetadata.candidatesTokenCount != null) {
    result.outputTokens = usageMetadata.candidatesTokenCount;
  } else if (usageMetadata.totalTokenCount != null) {
    result.outputTokens =
      usageMetadata.totalTokenCount -
      (prompt ?? result.inputTokens + result.cacheReadTokens);
  }
  result.thinkingTokens =
    usageMetadata.thoughtsTokenCount ?? result.thinkingTokens;
}

interface UsageAccumulator {
  inclusiveInputTokens?: number;
  openai?: boolean;
}

/**
 * OpenAI cached details are a subset of input; Anthropic cache counts are additive.
 * Keep the inclusive OpenAI count separately so partial SSE usage cannot subtract twice.
 */
function applyUsageDetails(
  usage: any,
  result: ParsedResponseUsage,
  accumulator: UsageAccumulator,
): void {
  const input = usage.input_tokens ?? usage.prompt_tokens;
  const cached =
    usage.prompt_tokens_details?.cached_tokens ??
    usage.input_tokens_details?.cached_tokens;
  if (cached != null || usage.prompt_tokens != null || accumulator.openai) {
    accumulator.openai = true;
    accumulator.inclusiveInputTokens =
      input ?? accumulator.inclusiveInputTokens;
    result.cacheReadTokens = cached ?? result.cacheReadTokens;
    if (accumulator.inclusiveInputTokens != null) {
      result.inputTokens = Math.max(
        0,
        accumulator.inclusiveInputTokens - result.cacheReadTokens,
      );
      result.hasInputTokens = true;
    }
  } else if (input != null) {
    result.inputTokens = input;
    result.hasInputTokens = true;
  }
  if (input != null) {
    accumulator.inclusiveInputTokens = input;
  }
  result.outputTokens =
    usage.output_tokens ?? usage.completion_tokens ?? result.outputTokens;
  result.thinkingTokens =
    usage.completion_tokens_details?.reasoning_tokens ??
    usage.output_tokens_details?.reasoning_tokens ??
    usage.thinking_tokens ??
    usage.reasoning_tokens ??
    result.thinkingTokens;
  result.cacheReadTokens =
    cached ?? usage.cache_read_input_tokens ?? result.cacheReadTokens;
  result.cacheWriteTokens =
    usage.cache_creation_input_tokens ?? result.cacheWriteTokens;
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
  if (responseData.response?.response_id)
    return responseData.response.response_id;

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
    hasInputTokens: false,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    thinkingTokens: 0,
    model: null,
    finishReasons: [],
    stream: false,
  };

  if (!responseData) return result;
  const accumulator: UsageAccumulator = {};

  // Streaming response: scan SSE chunks for usage
  if (responseData.streaming && typeof responseData.chunks === "string") {
    result.stream = true;
    return parseStreamingUsage(responseData.chunks, result, accumulator);
  }

  // Non-streaming response

  // OpenAI / Anthropic / Responses API usage (direct or wrapped)
  const usage = responseData.usage ?? responseData.response?.usage;
  if (usage) applyUsageDetails(usage, result, accumulator);

  // Gemini usageMetadata (direct or inside Code Assist wrapper .response)
  const geminiMeta =
    responseData.usageMetadata ?? responseData.response?.usageMetadata;
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
  accumulator: UsageAccumulator,
): ParsedResponseUsage {
  for (const parsed of parseSseEvents(chunks)) {
    // Anthropic message_start: contains model
    if (parsed.type === "message_start" && parsed.message) {
      result.model = parsed.message.model || result.model;
      if (parsed.message.usage) {
        applyUsageDetails(parsed.message.usage, result, accumulator);
      }
    }

    // Anthropic message_delta: contains stop_reason and output token count
    if (parsed.type === "message_delta") {
      if (parsed.usage) {
        applyUsageDetails(parsed.usage, result, accumulator);
      }
    }

    // OpenAI streaming: final chunk with usage
    if (parsed.usage && parsed.choices) {
      applyUsageDetails(parsed.usage, result, accumulator);
    }

    // Responses streaming: response.completed/response.created events
    // carry usage in parsed.response.usage
    if (parsed.response?.usage) {
      applyUsageDetails(parsed.response.usage, result, accumulator);
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
