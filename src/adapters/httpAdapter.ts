import { z } from "zod";
import { AdapterError, ConfigError } from "../core/errors.js";
import { requestJson } from "../core/http.js";
import { withRetry } from "../core/retry.js";
import type { AdapterContext, AdapterResult, CaseInput, PipelineAdapter, TraceStep, Usage } from "../core/types.js";
import { parseConfig, retryFields } from "./common.js";

const configSchema = z.strictObject({
  url: z.string().url(),
  method: z.enum(["POST", "PUT", "PATCH"]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  outputField: z.string().min(1).optional(),
  ...retryFields,
});

const usageSchema = z.object({
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cachedInputTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  reasoningTokens: z.number().optional(),
});

const stepSchema: z.ZodType<TraceStep> = z.lazy(() =>
  z.object({
    kind: z.enum(["llm", "tool", "retrieval", "agent", "other"]),
    name: z.string(),
    startOffsetMs: z.number().optional(),
    durationMs: z.number().optional(),
    input: z.unknown().optional(),
    output: z.unknown().optional(),
    attributes: z.record(z.string(), z.unknown()).optional(),
    children: z.array(stepSchema).optional(),
  }),
);

/**
 * General-purpose adapter: POSTs `{ "input": ... }` as JSON and expects
 * `{ "output": "<string>" }` back. The pipeline may also self-report
 * `usage`, `costUsd`, `steps` and `metadata` in the response.
 */
export const httpAdapter: PipelineAdapter = {
  name: "http",

  preflight(config) {
    const cfg = parseConfig(configSchema, config, "http");
    for (const name of Object.keys(cfg.headers ?? {})) {
      if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
        throw new ConfigError(`pipeline.config.headers: "${name}" is not a valid header name`);
      }
    }
  },

  async run(input: CaseInput, config: Record<string, unknown>, ctx: AdapterContext): Promise<AdapterResult> {
    const cfg = parseConfig(configSchema, config, "http");
    const field = cfg.outputField ?? "output";

    const { value, retries, durationMs } = await withRetry(
      () =>
        requestJson({
          url: cfg.url,
          method: cfg.method ?? "POST",
          headers: cfg.headers,
          body: { input },
          signal: ctx.signal,
        }),
      { maxRetries: cfg.retries, baseDelayMs: cfg.retryBaseDelayMs, signal: ctx.signal },
    );

    const body = value.json;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new AdapterError("pipeline response must be a JSON object");
    }
    const rec = body as Record<string, unknown>;
    const output = rec[field];
    if (typeof output !== "string") {
      throw new AdapterError(`pipeline response is missing a string "${field}" field`);
    }

    const metadata: Record<string, unknown> = { retries, httpStatus: value.status };
    if (rec.metadata && typeof rec.metadata === "object" && !Array.isArray(rec.metadata)) {
      Object.assign(metadata, rec.metadata);
    }

    let usage: Usage | undefined;
    if (rec.usage !== undefined) {
      const u = usageSchema.safeParse(rec.usage);
      if (u.success) usage = u.data;
      else metadata.usageIgnored = "invalid usage object in pipeline response";
    }

    let steps: TraceStep[] | undefined;
    if (rec.steps !== undefined) {
      const s = z.array(stepSchema).safeParse(rec.steps);
      if (s.success) steps = s.data;
      else metadata.stepsIgnored = "invalid steps array in pipeline response";
    }

    return {
      output,
      latencyMs: durationMs,
      costUsd: typeof rec.costUsd === "number" && Number.isFinite(rec.costUsd) ? rec.costUsd : null,
      usage,
      steps,
      metadata,
    };
  },
};
