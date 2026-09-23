import { z } from "zod";
import { AdapterError, ConfigError, JudgeError, errorMessage } from "../core/errors.js";
import { withRetry } from "../core/retry.js";
import type { Scorer, ScoreResult } from "../core/types.js";
import { callLlm, parseModelSpec, resolveApiKey, resolveBaseUrl, type LlmResult, type Provider } from "../llm/client.js";
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
const JUDGE_CHECK_TIMEOUT_MS = 60_000;

/**
 * Judge endpoints (provider, base URL, model) seen rejecting `temperature`: newer reasoning models
 * accept only their default. They are asked again without it, and later calls skip the rejected try.
 */
const rejectsTemperature = new Set<string>();

function isTemperatureRejection(err: unknown): boolean {
  return err instanceof AdapterError && err.status === 400 && /temperature/i.test(err.message);
}

interface JudgeEndpoint {
  provider: Provider;
  model: string;
  apiKey: string;
  baseUrl: string;
}

function judgeEndpoint(spec: string, env: Record<string, string | undefined>): JudgeEndpoint {
  const { provider, model } = parseModelSpec(spec, "judge model");
  return { provider, model, apiKey: resolveApiKey(provider, env), baseUrl: resolveBaseUrl(provider, env) };
}

/**
 * One judge request, with transport retries. Asks for temperature 0 unless the model rejects it.
 * `temperature` reports what the judge actually ran at.
 */
async function askJudge(
  ep: JudgeEndpoint,
  prompt: { system: string; user: string },
  signal: AbortSignal,
): Promise<{ res: LlmResult; temperature: 0 | "default" }> {
  const call = async (temperature: number | undefined) =>
    (
      await withRetry(
        () =>
          callLlm({
            ...ep,
            messages: [
              { role: "system", content: prompt.system },
              { role: "user", content: prompt.user },
            ],
            maxTokens: JUDGE_MAX_TOKENS,
            temperature,
            jsonSchema: { name: "verdict", schema: JUDGE_SCHEMA },
            signal,
          }),
        { signal },
      )
    ).value;
  const endpoint = `${ep.provider} ${ep.baseUrl} ${ep.model}`;
  try {
    if (rejectsTemperature.has(endpoint)) return { res: await call(undefined), temperature: "default" };
    try {
      return { res: await call(0), temperature: 0 };
    } catch (err) {
      if (!isTemperatureRejection(err)) throw err;
      rejectsTemperature.add(endpoint);
      return { res: await call(undefined), temperature: "default" };
    }
  } catch (err) {
    if (err instanceof AdapterError) throw new JudgeError(`judge call failed: ${err.message}`, { cause: err });
    throw err;
  }
}

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

/**
 * Ask the judge one trivial question before any case runs, so a judge that cannot work (unknown
 * model, bad key, no structured output) stops the run with a clear message instead of erroring
 * every attempt. Only the shape of the answer is checked, not the verdict.
 */
async function checkJudge(
  spec: string,
  env: Record<string, string | undefined>,
  runSignal?: AbortSignal,
): Promise<{ temperature: 0 | "default" }> {
  const timeout = AbortSignal.timeout(JUDGE_CHECK_TIMEOUT_MS);
  const signal = runSignal ? AbortSignal.any([runSignal, timeout]) : timeout;
  try {
    const prompt = buildJudgePrompt({ rubric: "Is the output the word OK?", input: "Reply with OK.", expected: "OK", output: "OK" });
    const { res, temperature } = await askJudge(judgeEndpoint(spec, env), prompt, signal);
    if (res.refused) throw new JudgeError("the judge refused a trivial request");
    parseVerdict(res.text);
    return { temperature };
  } catch (err) {
    throw new ConfigError(
      `The judge ${spec} does not work: ${errorMessage(err)}. ` +
        "Fix the judge configuration, or skip this check with --no-judge-check.",
      { cause: err },
    );
  }
}

function addCost(total: number | null | undefined, add: number | null): number | null {
  if (total === null || add === null) return null;
  return (total ?? 0) + add;
}

/**
 * LLM-as-judge. The pipeline output is untrusted text, so it is fenced with a
 * per-call random token, the judge is told to treat it as data, native
 * structured output is requested, and anything that is not a valid verdict
 * fails closed (an error, never an implicit pass). Temperature 0 is requested, except from models
 * that reject it, which are judged at their default temperature.
 */
export const llmJudge: Scorer = {
  name: "llmJudge",

  async preflight({ cases, judge, env, signal, warn, liveChecks }) {
    const users = cases.filter((c) => c.scorers.includes("llmJudge"));
    if (users.length === 0) return;
    const providers = new Set<string>();
    const specs = new Set<string>();
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
      specs.add(spec);
    }
    if (liveChecks === false) return;
    const checked = await Promise.all([...specs].map(async (spec) => ({ spec, ...(await checkJudge(spec, env, signal)) })));
    for (const { spec } of checked.filter((c) => c.temperature === "default")) {
      warn?.(
        `the judge ${spec} does not accept temperature 0, so it runs at its default temperature and its verdicts ` +
          "can vary between runs. Repeat cases (--repeat), or choose a judge that accepts temperature 0.",
      );
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
    const metadata: Record<string, unknown> = { judge: spec };
    try {
      const ep = judgeEndpoint(spec, runtime.env);
      const prompt = buildJudgePrompt({
        rubric: cfg.data.rubric ?? DEFAULT_RUBRIC,
        input,
        expected,
        output,
      });

      let lastError: unknown;
      for (let attempt = 0; attempt < 2; attempt++) {
        const { res, temperature } = await askJudge(ep, prompt, runtime.signal);
        metadata.temperature = temperature;
        cost = addCost(cost, computeCost(runtime.prices, ep.provider, ep.model, res.usage));

        if (res.refused) throw new JudgeError("judge refused to evaluate this output");
        try {
          const v = parseVerdict(res.text);
          const result: ScoreResult = {
            pass: v.verdict === "pass",
            value: v.verdict === "pass" ? 1 : 0,
            reasoning: v.reasoning,
            costUsd: cost,
            metadata,
          };
          return result;
        } catch (err) {
          lastError = err; // one retry on a malformed verdict, then fail closed
        }
      }
      throw lastError;
    } catch (err) {
      return { pass: false, value: null, error: errorMessage(err), costUsd: cost, metadata };
    }
  },
};
