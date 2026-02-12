/**
 * Approximate token cost for a single image.
 *
 * Anthropic charges based on image dimensions (~1,600 tokens per 512x512 tile).
 * Since we don't decode image data, we use a conservative flat estimate of 1,600
 * tokens (one tile). Most screenshots cost 2,000-6,400 tokens, so this slightly
 * under-counts but is far better than stringifying megabytes of base64.
 */
const IMAGE_TOKEN_ESTIMATE = 1_600;

/**
 * Return true if the value looks like an image content block.
 *
 * Matches Anthropic `{type:"image", source:{type:"base64", data:"..."}}`,
 * OpenAI `{type:"image_url", image_url:{url:"data:..."}}`,
 * and Gemini `{inlineData:{...}}` / `{fileData:{...}}`.
 */
function isImageBlock(val: unknown): val is Record<string, unknown> {
  if (!val || typeof val !== "object" || Array.isArray(val)) return false;
  const obj = val as Record<string, unknown>;
  if (obj.type === "image" || obj.type === "image_url") return true;
  if (obj.inlineData || obj.fileData) return true;
  return false;
}

/**
 * Strip base64 image data from a value before stringifying for token estimation.
 *
 * Walks arrays and recognizes image blocks at any nesting level (top-level content
 * arrays, tool_result content arrays, Gemini parts). Image blocks are replaced with
 * a sentinel so the rest of the structure is still counted.
 */
function stripImageData(val: unknown): unknown {
  if (!val || typeof val !== "object") return val;

  if (Array.isArray(val)) {
    return val.map(stripImageData);
  }

  // Image block: return a lightweight placeholder
  if (isImageBlock(val)) {
    return { type: (val as Record<string, unknown>).type || "image", _image: true };
  }

  const obj = val as Record<string, unknown>;

  // tool_result blocks can nest image blocks inside their content array
  if (obj.type === "tool_result" && Array.isArray(obj.content)) {
    return { ...obj, content: obj.content.map(stripImageData) };
  }

  // Gemini turn: parts array may contain inlineData
  if (Array.isArray(obj.parts)) {
    return { ...obj, parts: obj.parts.map(stripImageData) };
  }

  return obj;
}

/**
 * Lightweight token estimator used throughout Context Lens.
 *
 * Approximates tokens as `ceil(chars / 4)`. For image content blocks,
 * uses a fixed per-image estimate instead of stringifying base64 data.
 *
 * @param text - Value to estimate tokens for. Objects are stringified as JSON.
 * @returns Estimated token count (>= 0).
 */
export function estimateTokens(text: unknown): number {
  if (!text) return 0;

  // Fast path: plain strings never contain image data
  if (typeof text === "string") {
    return Math.ceil(text.length / 4);
  }

  // Single image block
  if (isImageBlock(text)) {
    return IMAGE_TOKEN_ESTIMATE;
  }

  // Object/array: strip image data, then stringify the rest
  const cleaned = stripImageData(text);
  const s = JSON.stringify(cleaned);
  const baseTokens = Math.ceil(s.length / 4);

  // Count image blocks and add fixed estimate for each
  const imageCount = countImages(text);
  return baseTokens + imageCount * IMAGE_TOKEN_ESTIMATE;
}

/**
 * Count the number of image blocks in a value (recursive).
 */
function countImages(val: unknown): number {
  if (!val || typeof val !== "object") return 0;

  if (isImageBlock(val)) return 1;

  if (Array.isArray(val)) {
    let count = 0;
    for (const item of val) {
      count += countImages(item);
    }
    return count;
  }

  const obj = val as Record<string, unknown>;

  // Check nested content in tool_result blocks
  if (obj.type === "tool_result" && Array.isArray(obj.content)) {
    return countImages(obj.content);
  }

  // Check Gemini parts
  if (Array.isArray(obj.parts)) {
    return countImages(obj.parts);
  }

  return 0;
}

/**
 * Rescale all token sub-fields in a ContextInfo so they are internally
 * consistent with an authoritative total (typically from API usage data).
 *
 * Adjusts `systemTokens`, `toolsTokens`, per-message `.tokens`, and
 * `messagesTokens` proportionally, then applies a rounding residual fix
 * to `messagesTokens` so the invariant
 * `totalTokens === systemTokens + toolsTokens + messagesTokens` holds exactly.
 */
export function rescaleContextTokens(
  ci: {
    systemTokens: number;
    toolsTokens: number;
    messagesTokens: number;
    totalTokens: number;
    messages: { tokens: number }[];
  },
  authoritative: number,
): void {
  const estimated = ci.systemTokens + ci.toolsTokens + ci.messagesTokens;
  if (estimated === 0 || authoritative === 0) {
    ci.systemTokens = 0;
    ci.toolsTokens = 0;
    ci.messagesTokens = 0;
    ci.totalTokens = authoritative;
    for (const msg of ci.messages) {
      msg.tokens = 0;
    }
    return;
  }
  if (authoritative === estimated) {
    ci.totalTokens = authoritative;
    return;
  }
  const scale = authoritative / estimated;
  ci.systemTokens = Math.round(ci.systemTokens * scale);
  ci.toolsTokens = Math.round(ci.toolsTokens * scale);
  for (const msg of ci.messages) {
    msg.tokens = Math.round(msg.tokens * scale);
  }
  ci.messagesTokens = ci.messages.reduce((s, m) => s + m.tokens, 0);
  ci.totalTokens = authoritative;
  // Fix rounding residual so both invariants hold:
  //   totalTokens === systemTokens + toolsTokens + messagesTokens
  //   messagesTokens === sum(msg.tokens)
  const residual =
    authoritative - (ci.systemTokens + ci.toolsTokens + ci.messagesTokens);
  if (residual !== 0) {
    ci.messagesTokens += residual;
    // Push the residual into the largest per-message entry (or first if tied)
    // so sum(msg.tokens) stays equal to messagesTokens.
    if (ci.messages.length > 0) {
      let maxIdx = 0;
      for (let i = 1; i < ci.messages.length; i++) {
        if (ci.messages[i].tokens > ci.messages[maxIdx].tokens) maxIdx = i;
      }
      ci.messages[maxIdx].tokens += residual;
    }
  }
}
