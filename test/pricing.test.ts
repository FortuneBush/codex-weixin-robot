import assert from "node:assert/strict";
import test from "node:test";

import {
  calculateTokenCost,
  normalizeModelPricing,
  resolveModelPricing,
  type ModelPricingTable
} from "../src/codex/pricing.js";

const pricing: ModelPricingTable = {
  "gpt-*": {
    inputPerMillionUsd: 2,
    outputPerMillionUsd: 8,
    cachedInputPerMillionUsd: 0.5
  },
  "gpt-5*": {
    inputPerMillionUsd: 1,
    outputPerMillionUsd: 5,
    cachedInputPerMillionUsd: 0.25
  },
  "gpt-5.6-sol": {
    inputPerMillionUsd: 0.8,
    outputPerMillionUsd: 4,
    cachedInputPerMillionUsd: 0.2
  },
  "*": {
    inputPerMillionUsd: 3,
    outputPerMillionUsd: 12
  }
};

test("resolves exact model prices before the longest matching wildcard", () => {
  assert.equal(resolveModelPricing("GPT-5.6-SOL", pricing)?.modelPattern, "gpt-5.6-sol");
  assert.equal(resolveModelPricing("gpt-5.6-luna", pricing)?.modelPattern, "gpt-5*");
  assert.equal(resolveModelPricing("claude-sonnet", pricing)?.modelPattern, "*");
  assert.equal(resolveModelPricing(undefined, pricing)?.modelPattern, "*");
});

test("splits cached input from regular input when calculating cost", () => {
  const cost = calculateTokenCost({
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    cachedInputTokens: 200_000
  }, "gpt-5.6-sol", pricing);

  assert.deepEqual(cost, {
    inputCostUsd: 0.64,
    outputCostUsd: 2,
    cachedInputCostUsd: 0.04,
    totalCostUsd: 2.68,
    inputTokens: 1_000_000,
    outputTokens: 500_000,
    cachedInputTokens: 200_000,
    uncachedInputTokens: 800_000,
    model: "gpt-5.6-sol",
    modelPattern: "gpt-5.6-sol"
  });
});

test("clamps invalid usage values and cached tokens to input tokens", () => {
  const cost = calculateTokenCost({
    inputTokens: 100,
    outputTokens: -1,
    cachedInputTokens: 200
  }, "gpt-5.6-sol", pricing);

  assert.equal(cost?.inputTokens, 100);
  assert.equal(cost?.outputTokens, 0);
  assert.equal(cost?.cachedInputTokens, 100);
  assert.equal(cost?.uncachedInputTokens, 0);
  assert.equal(cost?.totalCostUsd, 0.00002);
});

test("returns no estimate when no model price is configured", () => {
  assert.equal(calculateTokenCost({ inputTokens: 10, outputTokens: 10, cachedInputTokens: 0 }, "gpt", {}), undefined);
});

test("normalizes model pricing config and drops malformed entries", () => {
  assert.deepEqual(normalizeModelPricing({
    " gpt-5* ": {
      inputPerMillionUsd: 1,
      outputPerMillionUsd: 2
    },
    invalid: { inputPerMillionUsd: -1, outputPerMillionUsd: 2 },
    "bad-cache": { inputPerMillionUsd: 1, outputPerMillionUsd: 2, cachedInputPerMillionUsd: "free" },
    array: []
  }), {
    "gpt-5*": {
      inputPerMillionUsd: 1,
      outputPerMillionUsd: 2
    }
  });
});
