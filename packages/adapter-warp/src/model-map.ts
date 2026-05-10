// Warp uses two model ID formats: snake_case in ai_queries and display names in token_usage.
// Both must resolve to aliases recognised by calculateCost() in @langcost/core.
const WARP_MODEL_MAP: Record<string, string> = {
  "gpt-5-4": "gpt-5.4",
  "gpt-5.4": "gpt-5.4",
  "GPT-5.4": "gpt-5.4",
  "gpt-5-4-mini": "gpt-5.4-mini",
  "gpt-5.4-mini": "gpt-5.4-mini",
  "GPT-5.4 Mini": "gpt-5.4-mini",
  "gpt-5-4-nano": "gpt-5.4-nano",
  "gpt-5.4-nano": "gpt-5.4-nano",
  "GPT-5.4 Nano": "gpt-5.4-nano",
  "gpt-5-3-codex": "gpt-5.3-codex",
  "gpt-5.3-codex": "gpt-5.3-codex",
  "gpt-5.3-codex-medium": "gpt-5.3-codex",
  "GPT-5.3 Codex": "gpt-5.3-codex",
  "GPT-5.3 Codex (medium reasoning)": "gpt-5.3-codex",
  "gpt-5-3-codex-high": "gpt-5.3-codex-priority",
  "gpt-5.3-codex-high": "gpt-5.3-codex-priority",
  "GPT-5.3 Codex (high reasoning)": "gpt-5.3-codex-priority",
  "gpt-5-3-codex-extra-high": "gpt-5.3-codex-priority",
  "gpt-5.3-codex-extra-high": "gpt-5.3-codex-priority",
  "GPT-5.3 Codex (extra-high reasoning)": "gpt-5.3-codex-priority",
  "claude-4-6-sonnet-high": "claude-sonnet-4-6",
  "claude-4-6-sonnet": "claude-sonnet-4-6",
  "Claude Sonnet 4.6": "claude-sonnet-4-6",
  "claude-4-5-sonnet": "claude-sonnet-4-5",
  "Claude Sonnet 4.5": "claude-sonnet-4-5",
  "claude-4-6-haiku": "claude-haiku-4-5",
  "claude-4-5-haiku": "claude-haiku-4-5",
  "Claude Haiku 4.5": "claude-haiku-4-5",
  "claude-3-5-haiku": "claude-haiku-3-5",
  "Claude Haiku 3.5": "claude-haiku-3-5",
  "claude-4-6-opus": "claude-opus-4-6",
  "Claude Opus 4.6": "claude-opus-4-6",
  "claude-4-opus": "claude-opus-4",
  "Claude Opus 4": "claude-opus-4",
};

export function normalizeModelId(warpModelId: string): string {
  return WARP_MODEL_MAP[warpModelId] ?? warpModelId;
}
