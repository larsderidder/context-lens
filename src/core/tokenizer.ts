/**
 * Tiktoken-based tokenizer with lazy loading and model-to-encoding mapping.
 *
 * Encoders are cached per encoding name (not per model) since many models
 * share the same encoding. Falls back to chars/4 for unknown encodings.
 */

import type { Tiktoken } from "js-tiktoken";

/**
 * Map model name prefixes to tiktoken encoding names.
 *
 * Order: most specific first (longest prefix match wins).
 *
 * - cl100k_base: GPT-4, GPT-3.5-turbo, Claude (approximation)
 * - o200k_base: GPT-4o, GPT-4.1, GPT-5, o1, o3, o4
 *
 * Anthropic hasn't published their tokenizer, but cl100k_base is a
 * reasonable approximation (~5-10% off). Still much better than chars/4.
 *
 * Gemini models also use a proprietary tokenizer; cl100k_base is used
 * as a best-effort approximation.
 */
const MODEL_ENCODING_MAP: [string, string][] = [
  // OpenAI: o200k_base models
  ["gpt-5", "o200k_base"],
  ["gpt-4.1", "o200k_base"],
  ["gpt-4o", "o200k_base"],
  ["o4-", "o200k_base"],
  ["o3-", "o200k_base"],
  ["o3", "o200k_base"],
  ["o1-", "o200k_base"],
  ["o1", "o200k_base"],
  // OpenAI: cl100k_base models
  ["gpt-4-turbo", "cl100k_base"],
  ["gpt-4", "cl100k_base"],
  ["gpt-3.5", "cl100k_base"],
  // Anthropic: cl100k_base as approximation
  ["claude-", "cl100k_base"],
  // Gemini: cl100k_base as approximation
  ["gemini-", "cl100k_base"],
];

/** Cached encoder instances keyed by encoding name. */
const encoderCache = new Map<string, Tiktoken>();

/** In-flight loading promises to avoid duplicate loads. */
const loadingPromises = new Map<string, Promise<Tiktoken>>();

/** Whether the tokenizer has been initialized (at least one encoding loaded). */
let initialized = false;

/**
 * Resolve a model string to an encoding name.
 */
function getEncodingForModel(model: string): string {
  const lower = model.toLowerCase();
  for (const [prefix, encoding] of MODEL_ENCODING_MAP) {
    if (lower.includes(prefix)) return encoding;
  }
  // Default fallback: cl100k_base (most widely applicable)
  return "cl100k_base";
}

/**
 * Dynamically import the rank data for an encoding name.
 * Returns the Tiktoken constructor args.
 */
async function loadEncoding(encoding: string): Promise<Tiktoken> {
  const { Tiktoken } = await import("js-tiktoken/lite");
  let ranks: any;

  switch (encoding) {
    case "o200k_base":
      ranks = (await import("js-tiktoken/ranks/o200k_base")).default;
      break;
    case "cl100k_base":
      ranks = (await import("js-tiktoken/ranks/cl100k_base")).default;
      break;
    default:
      // Fallback to cl100k_base for unknown encodings
      ranks = (await import("js-tiktoken/ranks/cl100k_base")).default;
      break;
  }

  return new Tiktoken(ranks);
}

/**
 * Get or lazily load an encoder for the given encoding name.
 */
async function getEncoder(encoding: string): Promise<Tiktoken> {
  const cached = encoderCache.get(encoding);
  if (cached) return cached;

  // Deduplicate concurrent loads
  let promise = loadingPromises.get(encoding);
  if (!promise) {
    promise = loadEncoding(encoding).then((enc) => {
      encoderCache.set(encoding, enc);
      loadingPromises.delete(encoding);
      initialized = true;
      return enc;
    });
    loadingPromises.set(encoding, promise);
  }
  return promise;
}

/**
 * Initialize the tokenizer by preloading the most commonly used encodings.
 *
 * Call this once at analysis server startup. Non-blocking: if loading fails,
 * the tokenizer falls back to chars/4 estimation.
 */
export async function initTokenizer(): Promise<void> {
  try {
    // Preload both encodings in parallel
    await Promise.all([getEncoder("cl100k_base"), getEncoder("o200k_base")]);
    console.log("🔤 Tokenizer initialized (cl100k_base + o200k_base)");
  } catch (err: unknown) {
    console.warn(
      "Tokenizer init failed, using estimation fallback:",
      err instanceof Error ? err.message : String(err),
    );
  }
}

/**
 * Count tokens for a string using the appropriate encoding for the model.
 *
 * If the tokenizer hasn't been initialized yet (or loading failed), falls
 * back to chars/4. The model parameter is optional; when omitted, uses
 * cl100k_base.
 *
 * This is synchronous when encoders are preloaded (the normal case after
 * initTokenizer()). The encoder lookup is a Map.get(), and encoding is
 * a pure CPU operation.
 */
export function countTokens(text: string, model?: string): number {
  if (!text) return 0;

  const encoding = model ? getEncodingForModel(model) : "cl100k_base";
  const encoder = encoderCache.get(encoding);

  if (encoder) {
    try {
      return encoder.encode(text).length;
    } catch {
      // Encoding failure (unlikely): fall back to estimation
      return Math.ceil(text.length / 4);
    }
  }

  // Encoder not loaded yet: fall back to chars/4
  return Math.ceil(text.length / 4);
}

/**
 * Check if the tokenizer is ready (at least one encoding loaded).
 */
export function isTokenizerReady(): boolean {
  return initialized;
}
