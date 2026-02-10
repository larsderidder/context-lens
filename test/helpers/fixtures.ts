import { readFileSync } from "node:fs";
import { join } from "node:path";

// Load fixtures via readFileSync (avoids JSON import attribute complexity)
export const fixturesDir = join(process.cwd(), "test", "fixtures");

export const anthropicBasic = JSON.parse(
  readFileSync(join(fixturesDir, "anthropic-basic.json"), "utf-8"),
);
export const codexResponses = JSON.parse(
  readFileSync(join(fixturesDir, "codex-responses.json"), "utf-8"),
);
export const claudeSession = JSON.parse(
  readFileSync(join(fixturesDir, "claude-session.json"), "utf-8"),
);
export const openaiChat = JSON.parse(
  readFileSync(join(fixturesDir, "openai-chat.json"), "utf-8"),
);
