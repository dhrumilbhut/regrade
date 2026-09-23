import { z } from "zod";
import { ConfigError } from "../core/errors.js";
import { flattenTrace } from "../core/trace.js";
import type { Scorer, ScoreResult, TestCase, TraceStep } from "../core/types.js";

const kindSchema = z.enum(["llm", "tool", "retrieval", "agent", "other"]);

const toolCalledSchema = z.strictObject({
  tool: z.string().min(1),
  /** Exactly this many calls (default: at least one). */
  times: z.number().int().min(0).optional(),
  /** Only calls whose input contains these values (objects match partially, everything else exactly). */
  argsInclude: z.record(z.string(), z.unknown()).optional(),
  /** Pass only if the tool was NOT called (with matching arguments). */
  not: z.boolean().optional(),
});

const maxStepsSchema = z.strictObject({
  max: z.number().int().min(0),
  /** Count only steps of this kind. */
  kind: kindSchema.optional(),
});

const NO_TRACE =
  "the pipeline reported no trace (return `steps` from the pipeline: see the README's trace section), so this cannot be checked";

/** `expected` is contained in `actual`: objects partially and recursively, arrays and other values exactly. */
function includes(actual: unknown, expected: unknown): boolean {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) return false;
    return Object.entries(expected).every(([k, v]) => includes((actual as Record<string, unknown>)[k], v));
  }
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function checkConfigs<T>(cases: readonly TestCase[], name: string, schema: z.ZodType<T>): void {
  for (const c of cases.filter((x) => x.scorers.includes(name))) {
    const r = schema.safeParse(c.scorerConfig?.[name] ?? {});
    if (!r.success) {
      const issue = r.error.issues[0];
      throw new ConfigError(`case "${c.id}": invalid ${name} config: ${issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "?"}`);
    }
  }
}

function parse<T>(name: string, schema: z.ZodType<T>, config: unknown): T | ScoreResult {
  const r = schema.safeParse(config ?? {});
  return r.success ? r.data : { pass: false, value: null, error: `invalid ${name} config: ${r.error.issues[0]?.message ?? "?"}` };
}

const isResult = (v: unknown): v is ScoreResult => typeof v === "object" && v !== null && "pass" in v && "value" in v;

/** Did the agent call a tool (with these arguments, this many times)? Reads `kind: "tool"` steps. */
export const toolCalled: Scorer = {
  name: "toolCalled",

  preflight({ cases }) {
    checkConfigs(cases, "toolCalled", toolCalledSchema);
  },

  async score({ trace, config }) {
    const cfg = parse("toolCalled", toolCalledSchema, config);
    if (isResult(cfg)) return cfg;
    if (!trace) return { pass: false, value: null, error: NO_TRACE };

    const tools = flattenTrace(trace).filter((s) => s.kind === "tool");
    const calls = tools.filter((s) => s.name === cfg.tool && (!cfg.argsInclude || includes(s.input, cfg.argsInclude)));
    const n = calls.length;
    const what = `"${cfg.tool}"${cfg.argsInclude ? ` with ${JSON.stringify(cfg.argsInclude)}` : ""}`;
    const seen = [...new Set(tools.map((s) => s.name))];
    const called = `${what} was called ${n === 1 ? "once" : `${n} times`}`;
    const others = seen.length > 0 ? `tools called: ${seen.join(", ")}` : "no tools were called";

    let pass: boolean;
    let reasoning: string;
    if (cfg.not) {
      pass = n === 0;
      reasoning = pass ? `${what} was not called (${others})` : called;
    } else if (cfg.times !== undefined) {
      pass = n === cfg.times;
      reasoning = `${called}; expected ${cfg.times}${pass ? "" : ` (${others})`}`;
    } else {
      pass = n > 0;
      reasoning = pass ? called : `${what} was never called (${others})`;
    }
    return { pass, value: n, reasoning };
  },
};

/** Did the agent finish within a step budget? Catches loops and runaway retries. */
export const maxSteps: Scorer = {
  name: "maxSteps",

  preflight({ cases }) {
    checkConfigs(cases, "maxSteps", maxStepsSchema);
  },

  async score({ trace, config }) {
    const cfg = parse("maxSteps", maxStepsSchema, config);
    if (isResult(cfg)) return cfg;
    if (!trace) return { pass: false, value: null, error: NO_TRACE };

    const counted: TraceStep[] = flattenTrace(trace).filter((s) => cfg.kind === undefined || s.kind === cfg.kind);
    const n = counted.length;
    const label = cfg.kind ? `${cfg.kind} steps` : "steps";
    return {
      pass: n <= cfg.max,
      value: n,
      reasoning: n <= cfg.max ? `${n} ${label} (max ${cfg.max})` : `${n} ${label}, over the maximum of ${cfg.max}`,
    };
  },
};
