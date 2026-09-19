export type CodexTokenUsage = {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cachedInputTokens: number;
};

/** Normalize the usage object emitted by Codex app-server/exec JSON events. */
export function parseCodexTokenUsage(value: unknown): CodexTokenUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const inputTokens = nonNegativeInteger(raw.input_tokens ?? raw.inputTokens ?? raw.prompt_tokens ?? raw.promptTokens);
  const outputTokens = nonNegativeInteger(raw.output_tokens ?? raw.outputTokens ?? raw.completion_tokens ?? raw.completionTokens);
  const cachedInputTokens = nonNegativeInteger(
    raw.cached_input_tokens ?? raw.cachedInputTokens ?? raw.cache_read_input_tokens ?? raw.cached_tokens
  );
  const reportedTotal = nonNegativeInteger(raw.total_tokens ?? raw.totalTokens);
  if (inputTokens === undefined && outputTokens === undefined && reportedTotal === undefined) {
    return undefined;
  }
  const input = inputTokens ?? 0;
  const output = outputTokens ?? 0;
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: reportedTotal ?? input + output,
    cachedInputTokens: cachedInputTokens ?? 0
  };
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}
