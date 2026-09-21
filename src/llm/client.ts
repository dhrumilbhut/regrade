import { AdapterError, ConfigError } from "../core/errors.js";
import { requestJson } from "../core/http.js";
import type { Env } from "../core/env.js";
import type { Message, Usage } from "../core/types.js";

export type Provider = "anthropic" | "openai";

export const PROVIDERS: readonly Provider[] = ["anthropic", "openai"];

export const DEFAULT_KEY_ENV: Record<Provider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
};

export interface JsonSchemaOutput {
  name: string;
  schema: Record<string, unknown>;
}

export interface LlmCall {
  provider: Provider;
  model: string;
  messages: Message[];
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
  temperature?: number;
  /** Request provider-native structured output. */
  jsonSchema?: JsonSchemaOutput;
  /** OpenAI only: which parameter carries the output cap. */
  maxTokensParam?: "max_completion_tokens" | "max_tokens";
  signal: AbortSignal;
}

export interface LlmResult {
  text: string;
  usage: Usage;
  stopReason?: string;
  /** True when the model refused to answer. */
  refused: boolean;
}

export function isProvider(s: string): s is Provider {
  return (PROVIDERS as readonly string[]).includes(s);
}

/** Parse `provider:model`, e.g. `anthropic:claude-sonnet-5`. */
export function parseModelSpec(spec: string, what = "model"): { provider: Provider; model: string } {
  const idx = spec.indexOf(":");
  const provider = idx > 0 ? spec.slice(0, idx) : "";
  const model = idx > 0 ? spec.slice(idx + 1) : "";
  if (!isProvider(provider) || !model) {
    throw new ConfigError(
      `Invalid ${what} "${spec}": expected "provider:model" with provider one of ${PROVIDERS.join(", ")} ` +
        `(e.g. "anthropic:claude-sonnet-5").`,
    );
  }
  return { provider, model };
}

export function resolveApiKey(provider: Provider, env: Env, keyEnv?: string): string {
  const name = keyEnv ?? DEFAULT_KEY_ENV[provider];
  const key = env[name];
  if (!key) {
    throw new ConfigError(`${name} is not set. The ${provider} adapter reads its API key from the environment.`);
  }
  return key;
}

export function resolveBaseUrl(provider: Provider, env: Env, explicit?: string): string {
  const raw =
    explicit ??
    (provider === "anthropic"
      ? (env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com")
      : (env.OPENAI_BASE_URL ?? "https://api.openai.com/v1"));
  return raw.replace(/\/+$/, "");
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

/** One request to a provider. No retries here: callers wrap it with `withRetry`. */
export async function callLlm(call: LlmCall): Promise<LlmResult> {
  return call.provider === "anthropic" ? callAnthropic(call) : callOpenAI(call);
}

async function callAnthropic(call: LlmCall): Promise<LlmResult> {
  const system = call.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const messages = call.messages.filter((m) => m.role !== "system");
  const body: Record<string, unknown> = {
    model: call.model,
    max_tokens: call.maxTokens ?? 1024, // required by the Messages API
    messages,
  };
  if (system) body.system = system;
  if (call.temperature !== undefined) body.temperature = call.temperature;
  if (call.jsonSchema) body.output_config = { format: { type: "json_schema", schema: call.jsonSchema.schema } };

  const { json } = await requestJson({
    url: `${call.baseUrl}/v1/messages`,
    headers: { "x-api-key": call.apiKey, "anthropic-version": "2023-06-01" },
    body,
    signal: call.signal,
  });

  const res = obj(json);
  const content = Array.isArray(res?.content) ? (res.content as unknown[]) : undefined;
  if (!res || !content) throw new AdapterError("Anthropic response had no content array");
  const text = content
    .map((b) => obj(b))
    .filter((b) => b?.type === "text" && typeof b.text === "string")
    .map((b) => b?.text as string)
    .join("");
  const stopReason = typeof res.stop_reason === "string" ? res.stop_reason : undefined;

  const u = obj(res.usage) ?? {};
  const cacheCreation = obj(u.cache_creation);
  const usage: Usage = {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cachedInputTokens: num(u.cache_read_input_tokens),
    cacheWriteTokens: num(u.cache_creation_input_tokens),
    cacheWrite1hTokens: num(cacheCreation?.ephemeral_1h_input_tokens),
  };
  return { text, usage, stopReason, refused: stopReason === "refusal" };
}

async function callOpenAI(call: LlmCall): Promise<LlmResult> {
  const body: Record<string, unknown> = { model: call.model, messages: call.messages };
  if (call.maxTokens !== undefined) body[call.maxTokensParam ?? "max_completion_tokens"] = call.maxTokens;
  if (call.temperature !== undefined) body.temperature = call.temperature;
  if (call.jsonSchema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: call.jsonSchema.name, strict: true, schema: call.jsonSchema.schema },
    };
  }

  const { json } = await requestJson({
    url: `${call.baseUrl}/chat/completions`,
    headers: { authorization: `Bearer ${call.apiKey}` },
    body,
    signal: call.signal,
  });

  const res = obj(json);
  const choice = Array.isArray(res?.choices) ? obj((res.choices as unknown[])[0]) : undefined;
  const message = obj(choice?.message);
  if (!res || !choice || !message) throw new AdapterError("OpenAI response had no choices[0].message");

  let text = "";
  if (typeof message.content === "string") text = message.content;
  else if (Array.isArray(message.content)) {
    text = (message.content as unknown[])
      .map((p) => obj(p))
      .map((p) => (typeof p?.text === "string" ? p.text : ""))
      .join("");
  }
  const refused = typeof message.refusal === "string" && message.refusal.length > 0;
  const stopReason = typeof choice.finish_reason === "string" ? choice.finish_reason : undefined;

  const u = obj(res.usage) ?? {};
  const promptTokens = num(u.prompt_tokens);
  const details = obj(u.prompt_tokens_details);
  const cached = num(details?.cached_tokens);
  const written = num(details?.cache_write_tokens); // reported by newer models (GPT-5.6+)
  const usage: Usage = {
    // prompt_tokens includes cache reads and cache writes; keep the categories disjoint.
    inputTokens: promptTokens === undefined ? undefined : Math.max(0, promptTokens - (cached ?? 0) - (written ?? 0)),
    outputTokens: num(u.completion_tokens),
    cachedInputTokens: cached,
    cacheWriteTokens: written,
    reasoningTokens: num(obj(u.completion_tokens_details)?.reasoning_tokens),
  };
  return { text, usage, stopReason, refused };
}
