import type { ContentBlock, ContextInfo, ParsedMessage } from "../types.js";
import { estimateTokens } from "./tokens.js";

/**
 * Parse a single item from the OpenAI Responses API `input` array.
 *
 * Maps typed items (function_call, function_call_output, reasoning, output_text, etc.)
 * to a normalized `ParsedMessage` with a stable `role` and optional `contentBlocks`.
 */
function parseResponsesItem(item: any): {
  message: ParsedMessage;
  tokens: number;
  isSystem: boolean;
  content: string;
} {
  const type: string = item.type || "";

  // Standard message with role/content (e.g. {"type":"message","role":"user","content":[...]})
  if (item.role) {
    const isSystem = item.role === "system" || item.role === "developer";
    let content: string;
    let contentBlocks: ContentBlock[] | null = null;
    if (typeof item.content === "string") {
      content = item.content;
    } else if (Array.isArray(item.content)) {
      contentBlocks = item.content as ContentBlock[];
      content = item.content.map((b: any) => b.text || "").join("\n");
    } else {
      content = JSON.stringify(item.content || item);
    }
    const tokens = estimateTokens(item.content ?? content);
    return {
      message: { role: item.role, content, contentBlocks, tokens },
      tokens,
      isSystem,
      content,
    };
  }

  // function_call → assistant tool_use
  if (type === "function_call" || type === "custom_tool_call") {
    const name = item.name || "unknown";
    const args = item.arguments || "";
    const content =
      name +
      "(" +
      (typeof args === "string"
        ? args.slice(0, 200)
        : JSON.stringify(args).slice(0, 200)) +
      ")";
    const tokens = estimateTokens(item);
    // Parse stringified arguments (OpenAI Responses API sends JSON strings)
    let parsedInput: Record<string, any> = {};
    if (typeof args === "string" && args.length > 0) {
      try {
        const parsed = JSON.parse(args);
        if (typeof parsed === "object" && parsed !== null) {
          parsedInput = parsed;
        }
      } catch {
        /* not valid JSON, keep empty */
      }
    } else if (typeof args === "object" && args !== null) {
      parsedInput = args;
    }
    const block: ContentBlock = {
      type: "tool_use",
      id: item.call_id || "",
      name,
      input: parsedInput,
    };
    return {
      message: { role: "assistant", content, contentBlocks: [block], tokens },
      tokens,
      isSystem: false,
      content,
    };
  }

  // function_call_output → user tool_result
  if (type === "function_call_output" || type === "custom_tool_call_output") {
    const output =
      typeof item.output === "string"
        ? item.output
        : JSON.stringify(item.output || "");
    const tokens = estimateTokens(output);
    const block: ContentBlock = {
      type: "tool_result",
      tool_use_id: item.call_id || "",
      content: output,
    };
    return {
      message: {
        role: "user",
        content: output,
        contentBlocks: [block],
        tokens,
      },
      tokens,
      isSystem: false,
      content: output,
    };
  }

  // reasoning → assistant thinking
  if (type === "reasoning") {
    const summary = Array.isArray(item.summary)
      ? item.summary.map((s: any) => s.text || "").join("\n")
      : "";
    const content = summary || "[reasoning]";
    const tokens = estimateTokens(item);
    return {
      message: {
        role: "assistant",
        content,
        contentBlocks: [{ type: "thinking", thinking: content } as any],
        tokens,
      },
      tokens,
      isSystem: false,
      content,
    };
  }

  // output_text → assistant text
  if (type === "output_text") {
    const text = item.text || "";
    const tokens = estimateTokens(text);
    return {
      message: {
        role: "assistant",
        content: text,
        contentBlocks: [{ type: "text", text }],
        tokens,
      },
      tokens,
      isSystem: false,
      content: text,
    };
  }

  // input_text → user text
  if (type === "input_text") {
    const text = item.text || "";
    const tokens = estimateTokens(text);
    return {
      message: {
        role: "user",
        content: text,
        contentBlocks: [{ type: "text", text }],
        tokens,
      },
      tokens,
      isSystem: false,
      content: text,
    };
  }

  // Fallback: serialize the whole item
  const content = JSON.stringify(item);
  const tokens = estimateTokens(content);
  return {
    message: { role: item.role || "user", content, tokens },
    tokens,
    isSystem: false,
    content,
  };
}

/**
 * Parse a request body and extract normalized context information.
 *
 * This is the core "shape-normalizer" for Context Lens. It supports:
 * - Anthropic Messages API
 * - OpenAI Responses API and Chat Completions
 * - ChatGPT backend schema (Codex subscription traffic)
 * - Gemini (including Code Assist wrappers)
 *
 * @param provider - Provider inferred from routing (anthropic/openai/gemini/chatgpt/unknown).
 * @param body - Parsed JSON request body.
 * @param apiFormat - API schema family inferred from routing.
 * @returns A `ContextInfo` with token estimates and normalized messages/blocks.
 */
export function parseContextInfo(
  provider: string,
  body: Record<string, any>,
  apiFormat: string,
): ContextInfo {
  const info: ContextInfo = {
    provider,
    apiFormat,
    model: body.model || "unknown",
    systemTokens: 0,
    toolsTokens: 0,
    messagesTokens: 0,
    totalTokens: 0,
    systemPrompts: [],
    tools: [],
    messages: [],
  };

  if (provider === "anthropic") {
    if (body.system) {
      const systemText =
        typeof body.system === "string"
          ? body.system
          : Array.isArray(body.system)
            ? body.system.map((b: any) => b.text || "").join("\n")
            : JSON.stringify(body.system);
      info.systemPrompts.push({ content: systemText });
      info.systemTokens = estimateTokens(systemText);
    }

    if (body.tools && Array.isArray(body.tools)) {
      info.tools = body.tools;
      info.toolsTokens = estimateTokens(JSON.stringify(body.tools));
    }

    if (body.messages && Array.isArray(body.messages)) {
      info.messages = body.messages.map((msg: any): ParsedMessage => {
        const contentBlocks = Array.isArray(msg.content) ? msg.content : null;
        return {
          role: msg.role,
          content:
            typeof msg.content === "string"
              ? msg.content
              : JSON.stringify(msg.content),
          contentBlocks,
          tokens: estimateTokens(msg.content),
        };
      });
      info.messagesTokens = info.messages.reduce((sum, m) => sum + m.tokens, 0);
    }
  } else if (apiFormat === "responses" || provider === "chatgpt") {
    if (body.instructions) {
      info.systemPrompts.push({ content: body.instructions });
      info.systemTokens = estimateTokens(body.instructions);
    }
    if (body.system) {
      const systemText =
        typeof body.system === "string"
          ? body.system
          : Array.isArray(body.system)
            ? body.system.map((b: any) => b.text || "").join("\n")
            : JSON.stringify(body.system);
      info.systemPrompts.push({ content: systemText });
      info.systemTokens += estimateTokens(systemText);
    }

    const msgs = body.input || body.messages;
    if (msgs) {
      if (typeof msgs === "string") {
        info.messages.push({
          role: "user",
          content: msgs,
          tokens: estimateTokens(msgs),
        });
        info.messagesTokens = estimateTokens(msgs);
      } else if (Array.isArray(msgs)) {
        msgs.forEach((item: any) => {
          const parsed = parseResponsesItem(item);
          if (parsed.isSystem) {
            info.systemPrompts.push({ content: parsed.content });
            info.systemTokens += parsed.tokens;
          } else {
            info.messages.push(parsed.message);
            info.messagesTokens += parsed.tokens;
          }
        });
      }
    }

    if (body.tools && Array.isArray(body.tools)) {
      info.tools = body.tools;
      info.toolsTokens = estimateTokens(JSON.stringify(body.tools));
    }
  } else if (
    provider === "gemini" ||
    provider === "vertex" ||
    apiFormat === "gemini"
  ) {
    // Gemini API: contents[], systemInstruction, tools[{functionDeclarations}]
    // Code Assist wraps everything inside body.request: {contents, systemInstruction, tools, ...}
    const geminiBody = body.request || body;
    if (geminiBody.systemInstruction) {
      const parts = geminiBody.systemInstruction.parts || [];
      const systemText = parts.map((p: any) => p.text || "").join("\n");
      info.systemPrompts.push({ content: systemText });
      info.systemTokens = estimateTokens(systemText);
    }
    if (geminiBody.tools && Array.isArray(geminiBody.tools)) {
      const allDecls = geminiBody.tools.flatMap(
        (t: any) => t.functionDeclarations || [],
      );
      info.tools = allDecls;
      info.toolsTokens = estimateTokens(JSON.stringify(geminiBody.tools));
    }
    if (geminiBody.contents && Array.isArray(geminiBody.contents)) {
      info.messages = geminiBody.contents.map((turn: any): ParsedMessage => {
        const role = turn.role || "user";
        const parts = turn.parts || [];
        const contentBlocks: ContentBlock[] = [];
        const textParts: string[] = [];
        for (const part of parts) {
          if (part.text) {
            textParts.push(part.text);
            contentBlocks.push({ type: "text", text: part.text });
          } else if (part.functionCall) {
            contentBlocks.push({
              type: "tool_use",
              id: part.functionCall.id || "",
              name: part.functionCall.name || "",
              input: part.functionCall.args || {},
            });
          } else if (part.functionResponse) {
            const resp = part.functionResponse.response;
            // Gemini CLI wraps tool output in {output: "..."} or {error: "..."}
            const respText =
              typeof resp === "string"
                ? resp
                : typeof resp?.output === "string"
                  ? resp.output
                  : typeof resp?.error === "string"
                    ? resp.error
                    : JSON.stringify(resp || "");
            contentBlocks.push({
              type: "tool_result",
              tool_use_id: part.functionResponse.id || "",
              content: respText,
            });
          } else if (part.inlineData) {
            contentBlocks.push({ type: "image" });
          } else if (part.executableCode) {
            contentBlocks.push({
              type: "text",
              text: part.executableCode.code || "",
            });
          } else if (part.codeExecutionResult) {
            contentBlocks.push({
              type: "text",
              text: part.codeExecutionResult.output || "",
            });
          }
        }
        const content = textParts.join("\n") || JSON.stringify(parts);
        const tokens = estimateTokens(turn);
        return {
          role: role === "model" ? "assistant" : role,
          content,
          contentBlocks,
          tokens,
        };
      });
      info.messagesTokens = info.messages.reduce((sum, m) => sum + m.tokens, 0);
    }
  } else if (provider === "openai") {
    if (body.messages && Array.isArray(body.messages)) {
      body.messages.forEach((msg: any) => {
        if (msg.role === "system" || msg.role === "developer") {
          info.systemPrompts.push({ content: msg.content });
          info.systemTokens += estimateTokens(msg.content);
        } else {
          info.messages.push({
            role: msg.role,
            content:
              typeof msg.content === "string"
                ? msg.content
                : JSON.stringify(msg.content),
            tokens: estimateTokens(msg.content),
          });
          info.messagesTokens += estimateTokens(msg.content);
        }
      });
    }

    if (body.tools && Array.isArray(body.tools)) {
      info.tools = body.tools;
      info.toolsTokens = estimateTokens(JSON.stringify(body.tools));
    } else if (body.functions && Array.isArray(body.functions)) {
      info.tools = body.functions;
      info.toolsTokens = estimateTokens(JSON.stringify(body.functions));
    }
  }

  info.totalTokens = info.systemTokens + info.toolsTokens + info.messagesTokens;
  return info;
}
