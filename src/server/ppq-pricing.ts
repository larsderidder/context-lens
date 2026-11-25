import * as v from "valibot";

const PriceSchema = v.pipe(v.number(), v.finite(), v.minValue(0));
const ModelSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  pricing: v.object({
    input_per_1M_tokens: PriceSchema,
    output_per_1M_tokens: PriceSchema,
  }),
});
const ModelsSchema = v.object({ data: v.array(v.unknown()) });

export type PpqPricing = v.InferOutput<typeof ModelSchema>["pricing"];
export type PpqPricingLookup = (model: string) => Promise<PpqPricing | null>;

/** Match the actual PPQ API host, never text in a path or another hostname. */
export function isPpqTarget(targetUrl: string | null | undefined): boolean {
  if (!targetUrl) {
    return false;
  }
  try {
    const url = new URL(targetUrl);
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      url.hostname === "api.ppq.ai"
    );
  } catch {
    return false;
  }
}

/** One lazy, shared request per lookup instance. Failures stay unknown, with no retries. */
export function createPpqPricingLookup(
  fetchModels: typeof fetch = fetch,
): PpqPricingLookup {
  let pending: Promise<Map<string, PpqPricing>> | undefined;

  async function load(): Promise<Map<string, PpqPricing>> {
    const prices = new Map<string, PpqPricing>();
    try {
      const response = await fetchModels("https://api.ppq.ai/v1/models", {
        signal: AbortSignal.timeout(5_000),
        redirect: "error",
      });
      if (!response.ok) {
        await response.body?.cancel();
        return prices;
      }
      const json: unknown = await response.json();
      const result = v.safeParse(ModelsSchema, json);
      if (!result.success) {
        return prices;
      }
      for (const row of result.output.data) {
        const model = v.safeParse(ModelSchema, row);
        if (model.success) {
          prices.set(model.output.id, model.output.pricing);
        }
      }
    } catch {
      // Network, timeout and invalid JSON failures must not escape ingestion.
    }
    return prices;
  }

  return async (model) => {
    pending ??= load();
    return (await pending).get(model) ?? null;
  };
}

/** PPQ prices are USD per million tokens, not per token. */
export function estimatePpqCost(
  pricing: PpqPricing | null,
  inputTokens: number,
  outputTokens: number,
): number | null {
  const result = v.safeParse(ModelSchema.entries.pricing, pricing);
  if (
    !result.success ||
    !Number.isFinite(inputTokens) ||
    !Number.isFinite(outputTokens) ||
    inputTokens < 0 ||
    outputTokens < 0
  ) {
    return null;
  }
  const cost =
    (inputTokens / 1_000_000) * result.output.input_per_1M_tokens +
    (outputTokens / 1_000_000) * result.output.output_per_1M_tokens;
  if (!Number.isFinite(cost)) {
    return null;
  }
  return cost;
}

export const lookupPpqPricing = createPpqPricingLookup();
