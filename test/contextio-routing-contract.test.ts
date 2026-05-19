import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyRequest as classifyContextioRequest,
  extractSource as extractContextioSource,
  resolveTargetUrl as resolveContextioTargetUrl,
  type Upstreams,
} from "@contextio/core";

import {
  classifyRequest as classifyLensRequest,
  extractSource as extractLensSource,
  resolveTargetUrl as resolveLensTargetUrl,
} from "../src/core/routing.js";

const upstreams: Upstreams = {
  openai: "https://api.openai.com",
  anthropic: "https://api.anthropic.com",
  chatgpt: "https://chatgpt.com",
  gemini: "https://generativelanguage.googleapis.com",
  geminiCodeAssist: "https://cloudcode-assist.googleusercontent.com",
  vertex: "https://us-central1-aiplatform.googleapis.com",
};

const classificationCases = [
  {
    name: "Anthropic messages",
    pathname: "/v1/messages",
    headers: {},
  },
  {
    name: "OpenAI responses",
    pathname: "/v1/responses",
    headers: {},
  },
  {
    name: "ChatGPT backend Codex",
    pathname: "/backend-api/codex/responses",
    headers: {},
  },
  {
    name: "Pi openai-codex backend path",
    pathname: "/codex/responses",
    headers: {},
  },
  {
    name: "Gemini generateContent",
    pathname: "/v1beta/models/gemini-pro:generateContent",
    headers: {},
  },
  {
    name: "Vertex regional Gemini",
    pathname:
      "/v1/projects/my-project/locations/europe-west4/publishers/google/models/gemini-pro:generateContent",
    headers: {},
  },
];

const sourceCases = [
  "/claude/ab12cd34/v1/messages",
  "/gemini/abcdef01/v1beta/models/pro:generateContent",
  "/backend-api/codex/responses",
  "/codex/responses",
  "/v1/messages",
];

const resolutionCases = [
  { pathname: "/v1/messages", search: "" },
  { pathname: "/v1/responses", search: "" },
  { pathname: "/responses", search: "" },
  { pathname: "/backend-api/codex/responses", search: "" },
  { pathname: "/codex/responses", search: "" },
  {
    pathname:
      "/v1/projects/my-project/locations/europe-west4/publishers/google/models/gemini-pro:generateContent",
    search: "?alt=sse",
  },
];

describe("contextio routing contract", () => {
  for (const { name, pathname, headers } of classificationCases) {
    it(`classifies ${name} the same way`, () => {
      assert.deepEqual(
        classifyLensRequest(pathname, headers),
        classifyContextioRequest(pathname, headers),
      );
    });
  }

  for (const pathname of sourceCases) {
    it(`extracts source for ${pathname} the same way`, () => {
      assert.deepEqual(
        extractLensSource(pathname),
        extractContextioSource(pathname),
      );
    });
  }

  for (const { pathname, search } of resolutionCases) {
    it(`resolves ${pathname}${search} the same way`, () => {
      assert.deepEqual(
        resolveLensTargetUrl({ pathname, search }, {}, upstreams),
        resolveContextioTargetUrl(pathname, search, {}, upstreams),
      );
    });
  }
});
