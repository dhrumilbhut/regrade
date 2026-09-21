import { z } from "zod";
import { AdapterError } from "../core/errors.js";
import { withRetry } from "../core/retry.js";
import type { AdapterContext, AdapterResult, CaseInput, PipelineAdapter } from "../core/types.js";
import { callLlm, resolveApiKey, resolveBaseUrl, type Provider } from "../llm/client.js";
import { computeCost } from "../pricing/cost.js";
import { assertInputsMappable, parseConfig, retryFields, toMessages } from "./common.js";

const configSchema = z.strictObject({
  model: z.string().min(1),
  system: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  maxTokensParam: z.enum(["max_completion_tokens", "max_tokens"]).optional(),
  baseUrl: z.string().url().optional(),
  apiKeyEnv: z.string().min(1).optional(),
  inputTemplate: z.string().optional(),
  ...retryFields,
});

/** Shared implementation of the OpenAI-compatible and Anthropic adapters. */
export function createLlmAdapter(provider: Provider): PipelineAdapter {
  return {
    name: provider,

    preflight(config, cases, env) {
      const cfg = parseConfig(configSchema, config, provider);
      resolveApiKey(provider, env, cfg.apiKeyEnv);
      assertInputsMappable(cases, cfg.inputTemplate, provider);
    },

    async run(input: CaseInput, config: Record<string, unknown>, ctx: AdapterContext): Promise<AdapterResult> {
      const cfg = parseConfig(configSchema, config, provider);
      const apiKey = resolveApiKey(provider, ctx.env, cfg.apiKeyEnv);
      const baseUrl = resolveBaseUrl(provider, ctx.env, cfg.baseUrl);
      const messages = toMessages(input, { system: cfg.system, inputTemplate: cfg.inputTemplate });

      const { value, retries, durationMs } = await withRetry(
        () =>
          callLlm({
            provider,
            model: cfg.model,
            messages,
            apiKey,
            baseUrl,
            maxTokens: cfg.maxTokens,
            temperature: cfg.temperature,
            maxTokensParam: cfg.maxTokensParam,
            signal: ctx.signal,
          }),
        { maxRetries: cfg.retries, baseDelayMs: cfg.retryBaseDelayMs, signal: ctx.signal },
      );

      if (value.refused) throw new AdapterError(`${provider} model refused to answer`);
      return {
        output: value.text,
        latencyMs: durationMs,
        costUsd: computeCost(ctx.prices, provider, cfg.model, value.usage),
        usage: value.usage,
        metadata: { retries, stopReason: value.stopReason },
      };
    },
  };
}
