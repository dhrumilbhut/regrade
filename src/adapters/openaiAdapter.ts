import { createLlmAdapter } from "./llmAdapter.js";

/**
 * OpenAI Chat Completions-compatible adapter. Also works with any compatible
 * server (Ollama, vLLM, OpenRouter, ...) via `baseUrl` or `OPENAI_BASE_URL`.
 * The API key is read from `OPENAI_API_KEY` (or `config.apiKeyEnv`).
 */
export const openaiAdapter = createLlmAdapter("openai");
