import { AdapterError, ConfigError, errorMessage } from "./errors.js";
import { abortMessage } from "./http.js";
import { stableHash } from "./hash.js";
import type {
  AdapterContext,
  AdapterResult,
  CaseInput,
  PipelineAdapter,
  Scorer,
  ScoreArgs,
  ScoreResult,
  TestSuite,
  TraceStep,
  Usage,
} from "./types.js";

/** What an inline scorer may return: a boolean, or a full result. */
export type ScorerFn = (args: ScoreArgs) => boolean | ScoreResult | Promise<boolean | ScoreResult>;

/** An inline scorer: a function, or an object when you need `requiresExpected`, `preflight`, or your own fingerprint. */
export type InlineScorer = ScorerFn | (Omit<Scorer, "name" | "score"> & { name?: string; score: ScorerFn });

/** What a pipeline function may return: the output text, or the output plus cost/usage/trace. */
export type PipelineFunctionResult =
  | string
  | { output: string; costUsd?: number | null; usage?: Usage; steps?: TraceStep[]; metadata?: Record<string, unknown> };

/**
 * Test a function in your own process instead of an HTTP endpoint or provider API.
 * Timeouts and Ctrl+C are enforced even if your function ignores `ctx.signal`.
 */
export interface PipelineFunction {
  /** Label shown in output and stored with the run. Default "function". */
  name?: string;
  run(input: CaseInput, ctx: AdapterContext): PipelineFunctionResult | Promise<PipelineFunctionResult>;
  /** Recorded (redacted) with each run, e.g. { model: "...", promptVersion: "v7" }. Not used to call anything. */
  config?: Record<string, unknown>;
}

/** A suite written in code (`*.suite.ts` / `*.suite.mjs`): the JSON suite shape plus inline scorers and a function pipeline. */
export type CodeSuite = Omit<TestSuite, "pipeline"> & {
  pipeline: TestSuite["pipeline"] | PipelineFunction;
  /** Custom scorers, keyed by the name cases use in their `scorers` list. */
  scorers?: Record<string, InlineScorer>;
};

/** Identity helper that gives editors full type checking and completion for a code suite. */
export function defineSuite<const S extends CodeSuite>(suite: S): S {
  return suite;
}

export function isPipelineFunction(p: unknown): p is PipelineFunction {
  return typeof p === "object" && p !== null && typeof (p as { run?: unknown }).run === "function";
}

function normalizeScore(name: string, r: unknown): ScoreResult {
  if (typeof r === "boolean") return { pass: r, value: r ? 1 : 0 };
  if (r && typeof r === "object" && typeof (r as { pass?: unknown }).pass === "boolean") {
    const s = r as ScoreResult;
    return { pass: s.pass, value: s.value ?? null, reasoning: s.reasoning, costUsd: s.costUsd, error: s.error };
  }
  throw new TypeError(`scorer "${name}" must return a boolean or { pass: boolean, value?, reasoning? }; got ${r === null ? "null" : typeof r}`);
}

export function toScorer(name: string, def: InlineScorer): Scorer {
  if (typeof def === "function") {
    return {
      name,
      fingerprint: stableHash(def.toString()),
      async score(args) {
        return normalizeScore(name, await def(args));
      },
    };
  }
  if (!def || typeof def.score !== "function") {
    throw new ConfigError(`inline scorer "${name}" must be a function or an object with a score() function`);
  }
  return {
    name,
    requiresExpected: def.requiresExpected,
    preflight: def.preflight,
    fingerprint: def.fingerprint ?? stableHash(def.score.toString()),
    async score(args) {
      return normalizeScore(name, await def.score(args));
    },
  };
}

/** Wrap a pipeline function as an adapter, measuring latency and enforcing the attempt's timeout/interrupt. */
export function functionAdapter(def: PipelineFunction): PipelineAdapter {
  const name = def.name ?? "function";
  return {
    name,
    async run(input, _config, ctx): Promise<AdapterResult> {
      const started = performance.now();
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new AdapterError(abortMessage(ctx.signal)));
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        const result = await Promise.race([Promise.resolve().then(() => def.run(input, ctx)), aborted]);
        const latencyMs = performance.now() - started;
        if (typeof result === "string") return { output: result, latencyMs, costUsd: null };
        if (result && typeof result === "object" && typeof result.output === "string") {
          return {
            output: result.output,
            latencyMs,
            costUsd: typeof result.costUsd === "number" ? result.costUsd : null,
            usage: result.usage,
            steps: result.steps,
            metadata: result.metadata,
          };
        }
        throw new AdapterError('the pipeline function must return a string or { output: string, ... }');
      } catch (err) {
        if (err instanceof AdapterError) throw err;
        throw new AdapterError(`pipeline function threw: ${errorMessage(err)}`, { cause: err });
      } finally {
        if (onAbort) ctx.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
