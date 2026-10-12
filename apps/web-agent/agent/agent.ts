import { defineAgent } from "eve";

export default defineAgent({
  defaultTools: false,
  tool: false,
  model: "openai/gpt-6-luna",
  reasoning: "low",
  limits: {
    maxInputTokensPerSession: 100000,
    maxOutputTokensPerSession: 6000,
    maxTokenCostUsdPerSession: 0.1,
    sessionTimeoutMs: 60 * 60 * 1000,
  },
});
