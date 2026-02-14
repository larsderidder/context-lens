import type {
  ToolCallEntry,
  ToolDefinitionEntry,
} from "../lhar-types.generated.js";
import type { AnthropicTool, ContextInfo, OpenAITool } from "../types.js";

/**
 * Extract structured tool definition summaries from a ContextInfo.
 *
 * Returns one entry per tool schema available to the model, with name and
 * description only (no full input_schema, keeping the LHAR lightweight).
 */
export function extractToolDefinitions(
  contextInfo: ContextInfo,
): ToolDefinitionEntry[] {
  return contextInfo.tools.map((tool) => {
    if ("function" in tool) {
      // OpenAI format: { type: "function", function: { name, description } }
      const fn = (tool as OpenAITool).function;
      return {
        name: fn.name,
        description: fn.description ?? null,
      };
    }
    // Anthropic format: { name, description } or Gemini functionDeclarations
    const t = tool as AnthropicTool;
    return {
      name: t.name,
      description: t.description ?? null,
    };
  });
}

/**
 * Extract structured tool call entries from a ContextInfo's parsed messages.
 *
 * Scans contentBlocks for tool_use blocks and returns each invocation with
 * its name, call ID, and arguments.
 */
export function extractToolCalls(contextInfo: ContextInfo): ToolCallEntry[] {
  const calls: ToolCallEntry[] = [];
  for (const msg of contextInfo.messages) {
    if (!msg.contentBlocks) continue;
    for (const block of msg.contentBlocks) {
      if (block.type === "tool_use" && "name" in block) {
        calls.push({
          name: block.name,
          call_id: block.id || null,
          arguments: block.input ?? null,
        });
      }
    }
  }
  return calls;
}
