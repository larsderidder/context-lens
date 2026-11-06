#!/usr/bin/env node
/**
 * Pricing diff against the LiteLLM comparison catalog.
 * Provider documentation remains authoritative for price corrections.
 *
 * Fetches https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
 * and compares it against MODEL_PRICING in src/core/models.ts.
 *
 * Usage:
 *   npx tsx scripts/check-pricing.ts
 *   npx tsx scripts/check-pricing.ts --suggest-new
 *
 * Flags:
 *   --suggest-new   Also list litellm models for our providers that we don't have yet
 *   --tolerance=N   Price mismatch tolerance in percent (default: 5)
 */

import { MODEL_PRICING } from "../src/core/models.ts";

const LITELLM_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

// Providers we care about — we only flag "new models" for these.
const RELEVANT_PROVIDERS = new Set(["anthropic", "openai", "gemini"]);

// litellm uses "per token" costs; we use "per million tokens".
const PER_TOKEN_TO_PER_MTOK = 1_000_000;

// Modes litellm considers "text generation" (for cost comparison purposes).
const TEXT_MODES = new Set(["chat", "completion", "responses"]);

// litellm provider prefixes we consider authoritative (direct, not resellers).
const AUTHORITATIVE_PROVIDERS = new Set(["anthropic", "openai", "gemini"]);

interface LitellmEntry {
  litellm_provider?: string;
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  max_input_tokens?: number;
  mode?: string;
}

type LitellmData = Record<string, LitellmEntry>;

function parseArgs(): { suggestNew: boolean; tolerancePct: number } {
  const args = process.argv.slice(2);
  const suggestNew = args.includes("--suggest-new");
  const toleranceArg = args.find((a) => a.startsWith("--tolerance="));
  const tolerancePct = toleranceArg
    ? Number.parseFloat(toleranceArg.split("=")[1])
    : 5;
  return { suggestNew, tolerancePct };
}

/**
 * Return the bare model name from a litellm key by stripping any provider
 * prefix (e.g. "gemini/gemini-2.5-pro" → "gemini-2.5-pro",
 * "azure/us/gpt-4.1" → "gpt-4.1").
 */
function stripProviderPrefix(key: string): string {
  const slash = key.lastIndexOf("/");
  return slash >= 0 ? key.slice(slash + 1) : key;
}

/**
 * Match priority for a litellm key. Lower is better.
 *
 * 0 = exact match on bare name against our key
 * 1 = direct provider, non-fine-tuned, non-special-variant
 * 2 = direct provider, fine-tuned or special variant
 * 3 = reseller (azure, bedrock, vertex, etc.)
 */
function matchPriority(
  litellmKey: string,
  ourKey: string,
  entry: LitellmEntry,
): number {
  const bare = stripProviderPrefix(litellmKey);
  const isDirect =
    !!entry.litellm_provider &&
    AUTHORITATIVE_PROVIDERS.has(entry.litellm_provider);

  if (!isDirect) return 3; // reseller

  // Fine-tuned models start with "ft:" or contain "/ft:"
  if (litellmKey.startsWith("ft:") || litellmKey.includes("/ft:")) return 2;

  // chatgpt-* and *-latest are special routing aliases, not base model prices
  if (bare.startsWith("chatgpt-") || bare.endsWith("-latest")) return 2;

  // Exact match: bare model name equals our key
  if (bare === ourKey) return 0;

  return 1;
}

/**
 * Find the best matching MODEL_PRICING key for a given litellm model name.
 * Uses development-only family matching; runtime model lookup is stricter.
 */
function findOurKey(litellmName: string): string | null {
  const bare = stripProviderPrefix(litellmName);
  for (const key of Object.keys(MODEL_PRICING)) {
    if (bare.includes(key)) return key;
  }
  return null;
}

/**
 * Returns true when two prices differ by more than tolerancePct percent.
 */
function isMismatch(a: number, b: number, tolerancePct: number): boolean {
  if (a === 0 && b === 0) return false;
  // Skip comparison when litellm reports $0 (experimental / free tier).
  if (b === 0) return false;
  const ref = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) / ref > tolerancePct / 100;
}

function fmt(n: number): string {
  return `$${n.toFixed(4)}/MTok`;
}

interface BestMatch {
  key: string;
  inp: number;
  out: number;
  priority: number;
}

/**
 * Build a map from our MODEL_PRICING key to the best matching litellm entry.
 *
 * Priority (lower = better):
 *   0 = exact name match, direct provider
 *   1 = substring match, direct provider, base model
 *   2 = direct provider but fine-tuned / alias
 *   3 = reseller (azure, bedrock, vertex)
 */
function buildBestMatches(litellm: LitellmData): Map<string, BestMatch> {
  const best = new Map<string, BestMatch>();

  for (const [litellmKey, entry] of Object.entries(litellm)) {
    if (!entry.mode || !TEXT_MODES.has(entry.mode)) continue;
    if (
      entry.input_cost_per_token === undefined ||
      entry.output_cost_per_token === undefined
    ) {
      continue;
    }

    const ourKey = findOurKey(litellmKey);
    if (!ourKey) continue;

    const priority = matchPriority(litellmKey, ourKey, entry);
    const existing = best.get(ourKey);

    if (existing && existing.priority <= priority) continue;

    const inp = entry.input_cost_per_token * PER_TOKEN_TO_PER_MTOK;
    const out = entry.output_cost_per_token * PER_TOKEN_TO_PER_MTOK;

    best.set(ourKey, { key: litellmKey, inp, out, priority });
  }

  return best;
}

async function main() {
  const { suggestNew, tolerancePct } = parseArgs();

  console.log("Fetching litellm pricing data…");
  const res = await fetch(LITELLM_URL);
  if (!res.ok) {
    console.error(
      `Failed to fetch litellm data: ${res.status} ${res.statusText}`,
    );
    process.exit(1);
  }
  const litellm: LitellmData = (await res.json()) as LitellmData;
  console.log(`Loaded ${Object.keys(litellm).length} litellm entries.\n`);

  const bestMatches = buildBestMatches(litellm);

  // --- 1. Price mismatches ---
  const mismatches: Array<{
    ourKey: string;
    litellmKey: string;
    priority: number;
    ourInp: number;
    ourOut: number;
    theirInp: number;
    theirOut: number;
  }> = [];

  for (const [ourKey, [ourInp, ourOut]] of Object.entries(MODEL_PRICING)) {
    const match = bestMatches.get(ourKey);
    if (!match) continue;

    if (
      isMismatch(ourInp, match.inp, tolerancePct) ||
      isMismatch(ourOut, match.out, tolerancePct)
    ) {
      mismatches.push({
        ourKey,
        litellmKey: match.key,
        priority: match.priority,
        ourInp,
        ourOut,
        theirInp: match.inp,
        theirOut: match.out,
      });
    }
  }

  // --- 2. Our models not found in litellm at all ---
  const notFound: string[] = [];

  for (const ourKey of Object.keys(MODEL_PRICING)) {
    if (!bestMatches.has(ourKey)) {
      notFound.push(ourKey);
    }
  }

  // --- 3. New models in litellm we don't have (optional) ---
  const suggestedNew: Array<{
    key: string;
    provider: string;
    inp: number;
    out: number;
  }> = [];

  if (suggestNew) {
    for (const [litellmKey, entry] of Object.entries(litellm)) {
      if (!entry.litellm_provider) continue;
      if (!RELEVANT_PROVIDERS.has(entry.litellm_provider)) continue;
      if (!entry.mode || !TEXT_MODES.has(entry.mode)) continue;
      if (litellmKey.startsWith("ft:") || litellmKey.includes("/ft:")) continue;

      const inp = (entry.input_cost_per_token ?? 0) * PER_TOKEN_TO_PER_MTOK;
      const out = (entry.output_cost_per_token ?? 0) * PER_TOKEN_TO_PER_MTOK;
      if (inp === 0 && out === 0) continue; // skip free/experimental

      const ourKey = findOurKey(litellmKey);
      if (ourKey) continue; // already covered

      // Skip dated variants that shadow a base model we cover
      // (e.g. "claude-3-5-sonnet-20241022" when we have "claude-3-5-sonnet").
      const bare = stripProviderPrefix(litellmKey);
      const coveredByBase = Object.keys(MODEL_PRICING).some((k) =>
        bare.startsWith(k),
      );
      if (coveredByBase) continue;

      suggestedNew.push({
        key: litellmKey,
        provider: entry.litellm_provider,
        inp,
        out,
      });
    }
  }

  // --- Output ---
  let hasIssues = false;

  if (mismatches.length > 0) {
    hasIssues = true;
    console.log(`PRICE MISMATCHES (tolerance: ${tolerancePct}%)`);
    console.log("─".repeat(70));
    for (const m of mismatches) {
      const qualifier =
        m.priority === 3
          ? " [reseller match — direct provider entry may be missing]"
          : m.priority === 2
            ? " [alias/fine-tune match]"
            : "";
      console.log(`  Our key : ${m.ourKey}${qualifier}`);
      console.log(`  Matched : ${m.litellmKey}`);
      console.log(
        `  Input   : ours ${fmt(m.ourInp)} vs litellm ${fmt(m.theirInp)}`,
      );
      console.log(
        `  Output  : ours ${fmt(m.ourOut)} vs litellm ${fmt(m.theirOut)}`,
      );
      console.log();
    }
    console.log(`${mismatches.length} mismatch(es) found.\n`);
  } else {
    console.log(`✓ No price mismatches found (tolerance: ${tolerancePct}%).\n`);
  }

  if (notFound.length > 0) {
    hasIssues = true;
    console.log("OUR MODELS NOT FOUND IN LITELLM");
    console.log("─".repeat(70));
    console.log(
      "  (possible typo, very new model, internal variant, or retired model)",
    );
    for (const k of notFound) {
      console.log(`  - ${k}`);
    }
    console.log();
  } else {
    console.log("✓ All our models found in litellm.\n");
  }

  if (suggestNew && suggestedNew.length > 0) {
    console.log("NEW MODELS IN LITELLM (not in our list)");
    console.log("─".repeat(70));
    for (const m of suggestedNew) {
      console.log(
        `  [${m.provider}] ${m.key}  inp=${fmt(m.inp)} out=${fmt(m.out)}`,
      );
    }
    console.log();
  }

  if (!hasIssues) {
    console.log("All checks passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
