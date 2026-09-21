import { createLlmAdapter } from "./llmAdapter.js";

/**
 * Anthropic Messages API adapter. `maxTokens` defaults to 1024 because the API
 * requires it. The API key is read from `ANTHROPIC_API_KEY` (or `config.apiKeyEnv`).
 */
export const anthropicAdapter = createLlmAdapter("anthropic");
