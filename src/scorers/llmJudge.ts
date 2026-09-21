import { z } from "zod";
import { AdapterError, ConfigError, JudgeError, errorMessage } from "../core/errors.js";
import { withRetry } from "../core/retry.js";
import type { Scorer, ScoreResult } from "../core/types.js";
import { callLlm, parseModelSpec, resolveApiKey, resolveBaseUrl, type LlmResult } from "../llm/client.js";
import { computeCost } from "../pricing/cost.js";
import { buildJudgePrompt, DEFAULT_RUBRIC, JUDGE_SCHEMA } from "./judgePrompt.js";

const configSchema = z.object({
  judge: z.string().min(1).optional(),
  rubric: z.string().min(1).optional(),
});

const verdictSchema = z.strictObject({
  reasoning: z.string(),
  verdict: z.enum(["pass", "fail"]),
});

const JUDGE_MAX_TOKENS = 1024;

/** Accept valid JSON, tolerating a single surrounding ``` fence (some compatible servers add one). */
function parseVerdict(text: string): z.infer<typeof verdictSchema> {
  let t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  if (fenced?.[1] !== undefined) t = fenced[1];
  let raw: unknown;
  try {
    raw = JSON.parse(t);
  } catch {
    throw new JudgeError(
      `judge did not return JSON (got: "${text.slice(0, 80).replace(/\s+/g, " ")}"). ` +
        "Does the judge provider support structured output?",
    );
  }
  const r = verdictSchema.safeParse(raw);
  if (!r.success) throw new JudgeError(`judge output did not match the verdict schema: ${r.error.issues[0]?.message ?? "?"}`);
  return r.data;
}

function addCost(total: number | null | undefined, add: number | null): number | null {
  if (total === null || add === null) return null;
  return (total ?? 0) + add;
}

/**
 * LLM-as-judge. The pipeline output is untrusted text, so it is fenced with a
 * per-call random token, the judge is told to treat it as data, native
 * structured output is requested, and anything that is not a valid verdict
 * fails closed (an error, never an implicit pass).
 */
export const llmJudge: Scorer = {
  name: "llmJudge",

  preflight({ cases, judge, env }) {
    const users = cases.filter((c) => c.scorers.includes("llmJudge"));
    if (users.length === 0) return;
    const providers = new Set<string>();
    for (const c of users) {
      const cfg = configSchema.safeParse(c.scorerConfig?.llmJudge ?? {});
      if (!cfg.success) {
        throw new ConfigError(`case "${c.id}": invalid llmJudge config: ${cfg.error.issues[0]?.message ?? "?"}`);
      }
      const spec = cfg.data.judge ?? judge;
      if (!spec) {
        throw new ConfigError(
          `case "${c.id}" uses llmJudge but no judge model is configured. Set "defaults.judge" in the suite, ` +
            'pass --judge, or export REGRADE_JUDGE (format "provider:model", e.g. "anthropic:claude-sonnet-5").',
        );
      }
      const { provider } = parseModelSpec(spec, "judge model");
      if (!providers.has(provider)) {
        providers.add(provider);
        resolveApiKey(provider, env);
      }
    }
  },

  async score({ input, expected, output, config, runtime }) {
    const cfg = configSchema.safeParse(config ?? {});
    if (!cfg.success) {
      return { pass: false, value: null, error: `invalid llmJudge config: ${cfg.error.issues[0]?.message ?? "?"}` };
    }
    const spec = cfg.data.judge ?? runtime.judge;
    if (!spec) return { pass: false, value: null, error: "no judge model configured" };

    let cost: number | null = 0;
    try {
      const { provider, model } = parseModelSpec(spec, "judge model");
      const apiKey = resolveApiKey(provider, runtime.env);
      const baseUrl = resolveBaseUrl(provider, runtime.env);
      const prompt = buildJudgePrompt({
        rubric: cfg.data.rubric ?? DEFAULT_RUBRIC,
        input,
        expected,
        output,
      });

      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        let res: LlmResult;
        try {
          ({ value: res } = await withRetry(
            () =>
              callLlm({
                provider,
                model,
                apiKey,
                baseUrl,
                messages: [
                  { role: "system", content: prompt.system },
                  { role: "user", content: prompt.user },
                ],
                maxTokens: JUDGE_MAX_TOKENS,
                temperature: 0,
                jsonSchema: { name: "verdict", schema: JUDGE_SCHEMA },
                signal: runtime.signal,
              }),
            { signal: runtime.signal },
          ));
        } catch (err) {
          if (err instanceof AdapterError) throw new JudgeError(`judge call failed: ${err.message}`, { cause: err });
          throw err;
        }
        cost = addCost(cost, computeCost(runtime.prices, provider, model, res.usage));

        if (res.refused) throw new JudgeError("judge refused to evaluate this output");
        try {
          const v = parseVerdict(res.text);
          const result: ScoreResult = {
            pass: v.verdict === "pass",
            value: v.verdict === "pass" ? 1 : 0,
            reasoning: v.reasoning,
            costUsd: cost,
          };
          return result;
        } catch (err) {
          lastError = err; // one retry on a malformed verdict, then fail closed
        }
      }
      throw lastError;
    } catch (err) {
      return { pass: false, value: null, error: errorMessage(err), costUsd: cost };
    }
  },
};
