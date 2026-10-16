import type { CodexTokenUsage } from "./usage.js";

/**
 * Token prices in USD per one million tokens.
 *
 * `cachedInputPerMillionUsd` is optional. When omitted, cached input tokens
 * use the regular input price. This keeps a model entry useful even when its
 * provider does not publish a separate cache price.
 */
export type ModelPricing = {
  inputPerMillionUsd: number;
  outputPerMillionUsd: number;
  cachedInputPerMillionUsd?: number;
};

/** Keys are model ids, or model-id prefixes ending in `*`; `*` is a fallback. */
export type ModelPricingTable = Record<string, ModelPricing>;

export type ResolvedModelPricing = ModelPricing & {
  modelPattern: string;
};

export type TokenCost = {
  inputCostUsd: number;
  outputCostUsd: number;
  cachedInputCostUsd: number;
  totalCostUsd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  model?: string;
  modelPattern?: string;
};

/**
 * Find the most specific configured price for a model.
 *
 * Exact ids win over wildcard prefixes. Among wildcard prefixes the longest
 * matching prefix wins, so `gpt-*` can be overridden by `gpt-5-*`. Matching is
 * case-insensitive because model ids are commonly returned with provider
 * specific casing.
 */
export function resolveModelPricing(
  model: string | undefined,
  pricing: ModelPricingTable | undefined
): ResolvedModelPricing | undefined {
  if (!pricing || typeof pricing !== "object") return undefined;
  const normalizedModel = typeof model === "string" ? model.trim().toLowerCase() : "";
  if (!normalizedModel) {
    const fallback = findPricingEntry(pricing, "*");
    return fallback ? { ...fallback.value, modelPattern: fallback.key } : undefined;
  }

  const exact = Object.entries(pricing).find(([key, value]) =>
    key.trim().toLowerCase() === normalizedModel && isValidModelPricing(value)
  );
  if (exact) return { ...exact[1], modelPattern: exact[0] };

  const wildcardMatches = Object.entries(pricing)
    .filter(([key, value]) => {
      const normalizedKey = key.trim().toLowerCase();
      return normalizedKey.endsWith("*")
        && normalizedModel.startsWith(normalizedKey.slice(0, -1))
        && isValidModelPricing(value);
    })
    .sort(([left], [right]) => right.trim().length - left.trim().length);
  if (wildcardMatches[0]) {
    return { ...wildcardMatches[0][1], modelPattern: wildcardMatches[0][0] };
  }

  const fallback = findPricingEntry(pricing, "*");
  return fallback ? { ...fallback.value, modelPattern: fallback.key } : undefined;
}

/**
 * Calculate the estimated USD cost for one usage aggregate or one usage
 * record. Cached input is a subset of input, and is billed at the cache price
 * while the remaining input is billed at the regular input price.
 */
export function calculateTokenCost(
  usage: Pick<CodexTokenUsage, "inputTokens" | "outputTokens" | "cachedInputTokens">,
  model: string | undefined,
  pricing: ModelPricingTable | undefined
): TokenCost | undefined {
  const resolved = resolveModelPricing(model, pricing);
  if (!resolved) return undefined;

  const inputTokens = nonNegativeNumber(usage.inputTokens);
  const outputTokens = nonNegativeNumber(usage.outputTokens);
  const cachedInputTokens = Math.min(inputTokens, nonNegativeNumber(usage.cachedInputTokens));
  const uncachedInputTokens = Math.max(0, inputTokens - cachedInputTokens);
  const cachedPrice = resolved.cachedInputPerMillionUsd ?? resolved.inputPerMillionUsd;
  const inputCostUsd = perMillionCost(uncachedInputTokens, resolved.inputPerMillionUsd);
  const cachedInputCostUsd = perMillionCost(cachedInputTokens, cachedPrice);
  const outputCostUsd = perMillionCost(outputTokens, resolved.outputPerMillionUsd);

  return {
    inputCostUsd,
    outputCostUsd,
    cachedInputCostUsd,
    totalCostUsd: inputCostUsd + cachedInputCostUsd + outputCostUsd,
    inputTokens,
    outputTokens,
    cachedInputTokens,
    uncachedInputTokens,
    ...(model?.trim() ? { model: model.trim() } : {}),
    modelPattern: resolved.modelPattern
  };
}

/**
 * Validate and normalize user-provided JSON config. Invalid model entries are
 * ignored, while valid prices are copied into a fresh object so callers cannot
 * mutate the loaded config through a shared reference.
 */
export function normalizeModelPricing(value: unknown, fallback: ModelPricingTable = {}): ModelPricingTable {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return cloneModelPricing(fallback);
  }
  const normalized: ModelPricingTable = {};
  for (const [rawPattern, rawPricing] of Object.entries(value)) {
    const pattern = rawPattern.trim();
    if (!pattern || !isRecord(rawPricing)) continue;
    const inputPerMillionUsd = finiteNonNegative(rawPricing.inputPerMillionUsd);
    const outputPerMillionUsd = finiteNonNegative(rawPricing.outputPerMillionUsd);
    const cachedRaw = rawPricing.cachedInputPerMillionUsd;
    const cachedInputPerMillionUsd = cachedRaw === undefined
      ? undefined
      : finiteNonNegative(cachedRaw);
    if (inputPerMillionUsd === undefined || outputPerMillionUsd === undefined) continue;
    if (cachedRaw !== undefined && cachedInputPerMillionUsd === undefined) continue;
    normalized[pattern] = {
      inputPerMillionUsd,
      outputPerMillionUsd,
      ...(cachedInputPerMillionUsd !== undefined ? { cachedInputPerMillionUsd } : {})
    };
  }
  return normalized;
}

function findPricingEntry(
  pricing: ModelPricingTable,
  pattern: string
): { key: string; value: ModelPricing } | undefined {
  const entry = Object.entries(pricing).find(([key, value]) =>
    key.trim().toLowerCase() === pattern.toLowerCase() && isValidModelPricing(value)
  );
  return entry ? { key: entry[0], value: entry[1] } : undefined;
}

function isValidModelPricing(value: unknown): value is ModelPricing {
  if (!isRecord(value)) return false;
  return finiteNonNegative(value.inputPerMillionUsd) !== undefined
    && finiteNonNegative(value.outputPerMillionUsd) !== undefined
    && (value.cachedInputPerMillionUsd === undefined
      || finiteNonNegative(value.cachedInputPerMillionUsd) !== undefined);
}

function cloneModelPricing(pricing: ModelPricingTable): ModelPricingTable {
  return normalizeModelPricing(pricing, {});
}

function perMillionCost(tokens: number, price: number): number {
  return tokens * price / 1_000_000;
}

function nonNegativeNumber(value: unknown): number {
  return finiteNonNegative(value) ?? 0;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
