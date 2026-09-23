import { randomUUID } from "node:crypto";
import { mergePrices, defaultPrices } from "../pricing/cost.js";
import type { PriceTable } from "../pricing/cost.js";
import type { RunReporter } from "../report/types.js";
import type { Store } from "../store/store.js";
import { raceAbort } from "./abortable.js";
import { resolveEnv, type Env } from "./env.js";
import { AdapterError, ConfigError, errorMessage } from "./errors.js";
import type { GitInfo } from "./git.js";
import { stableHash } from "./hash.js";
import { prepareTrace } from "./trace.js";
import { runPool } from "./pool.js";
import { redactConfig } from "./redact.js";
import type { Registry } from "./registry.js";
import type {
  AdapterResult,
  AttemptRecord,
  AttemptStatus,
  PriceEntryInput,
  RunRecord,
  RunStatus,
  RunSummary,
  ScoreRecord,
  ScoreResult,
  TestCase,
  TestSuite,
} from "./types.js";
import { groupCases, summarize, type CaseOutcome } from "./verdict.js";

export const DEFAULT_CONCURRENCY = 4;
export const DEFAULT_TIMEOUT_MS = 30_000;

export interface RunOverrides {
  concurrency?: number;
  repeat?: number;
  timeoutMs?: number;
  /** Only cases having at least one of these tags. */
  tags?: string[];
  /** Only these case ids. */
  caseIds?: string[];
  label?: string;
  /** Judge model as `provider:model`; beats suite defaults and REGRADE_JUDGE. */
  judge?: string;
  /** Default true: before any case runs, make one tiny call to each judge to check it works. */
  judgeCheck?: boolean;
  /** Default true: store the steps pipelines report. False keeps the database small (scorers still see them). */
  storeTraces?: boolean;
  prices?: PriceEntryInput[];
  /**
   * Gate on the attempt-level pass rate (0..1) instead of requiring every case to pass.
   * Errored attempts count as not passed. Exit is 0 when the rate is at least this value.
   */
  minPassRate?: number;
}

export interface RunOptions {
  suite: TestSuite;
  registry: Registry;
  store: Store;
  regradeVersion: string;
  reporter?: RunReporter;
  env?: Env;
  overrides?: RunOverrides;
  git?: GitInfo;
  /** Abort to interrupt: in-flight attempts are cancelled and partial results kept. */
  signal?: AbortSignal;
  now?: () => Date;
}

export interface RunOutcome {
  run: RunRecord;
  cases: CaseOutcome[];
  attempts: AttemptRecord[];
  summary: RunSummary;
  warnings: string[];
  /** Attempts passed / attempts run (errored attempts count as not passed); 0 if none ran. */
  passRate: number;
  /** 0 all cases passed (or --min-pass-rate met), 1 otherwise, 130 interrupted. */
  exitCode: 0 | 1 | 130;
}

function selectCases(cases: readonly TestCase[], o: RunOverrides): TestCase[] {
  let selected = [...cases];
  if (o.caseIds && o.caseIds.length > 0) {
    const known = new Set(cases.map((c) => c.id));
    const unknown = o.caseIds.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new ConfigError(`--case: unknown case id${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`);
    }
    selected = selected.filter((c) => o.caseIds?.includes(c.id));
  }
  if (o.tags && o.tags.length > 0) {
    selected = selected.filter((c) => (c.tags ?? []).some((t) => o.tags?.includes(t)));
  }
  if (selected.length === 0) {
    throw new ConfigError("No cases selected: the --case / --tag filters matched nothing.");
  }
  return selected;
}

function pipelineLabel(adapter: string, config: Record<string, unknown>): string {
  if (adapter === "http" && typeof config.url === "string") {
    try {
      const u = new URL(config.url);
      return `http → ${u.host}${u.pathname === "/" ? "" : u.pathname}`;
    } catch {
      return "http";
    }
  }
  if ((adapter === "openai" || adapter === "anthropic") && typeof config.model === "string") {
    return `${adapter}:${config.model}`;
  }
  return adapter;
}

export async function runSuite(opts: RunOptions): Promise<RunOutcome> {
  const { suite, registry, store, reporter } = opts;
  const env = opts.env ?? process.env;
  const overrides = opts.overrides ?? {};
  const defaults = suite.defaults ?? {};
  const now = opts.now ?? (() => new Date());
  const warnings: string[] = [];
  const warn = (m: string) => {
    warnings.push(m);
    reporter?.onWarning?.(m);
  };

  // ---- Preflight: everything that can be checked before any case runs. ----
  if (overrides.minPassRate !== undefined && !(overrides.minPassRate >= 0 && overrides.minPassRate <= 1)) {
    throw new ConfigError("--min-pass-rate must be a number between 0 and 1 (for example 0.9 for 90%).");
  }
  const cases = selectCases(suite.cases, overrides);
  const pipelineConfig = resolveEnv(suite.pipeline.config, env, "pipeline.config");
  const adapter = registry.getAdapter(suite.pipeline.adapter);
  adapter.preflight?.(
    pipelineConfig,
    cases.map((c) => ({ id: c.id, input: c.input })),
    env,
  );

  const judgeFromEnv = env.REGRADE_JUDGE ? env.REGRADE_JUDGE : undefined;
  const judge = overrides.judge ?? defaults.judge ?? judgeFromEnv;
  const scorerNames = [...new Set(cases.flatMap((c) => c.scorers))];
  for (const name of scorerNames) {
    await registry.getScorer(name).preflight?.({ cases, judge, env, signal: opts.signal, warn, liveChecks: overrides.judgeCheck !== false });
  }

  const prices: PriceTable = mergePrices(mergePrices(defaultPrices(), suite.pricing), overrides.prices);
  const label = pipelineLabel(suite.pipeline.adapter, pipelineConfig);

  const pipelineModel =
    (suite.pipeline.adapter === "openai" || suite.pipeline.adapter === "anthropic") &&
    typeof pipelineConfig.model === "string"
      ? `${suite.pipeline.adapter}:${pipelineConfig.model}`
      : undefined;
  if (judge && pipelineModel === judge && scorerNames.includes("llmJudge")) {
    warn(
      `the judge model (${judge}) is the same as the pipeline model: LLM judges tend to favour their own outputs, ` +
        "so scores may be optimistic. Prefer a different judge.",
    );
  }

  const concurrency = overrides.concurrency ?? defaults.concurrency ?? DEFAULT_CONCURRENCY;
  const repeatFor = (c: TestCase) => overrides.repeat ?? c.repeat ?? defaults.repeat ?? 1;
  const timeoutFor = (c: TestCase) => overrides.timeoutMs ?? c.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const jobs: Array<{ testCase: TestCase; attempt: number }> = [];
  for (const testCase of cases) {
    for (let attempt = 1; attempt <= repeatFor(testCase); attempt++) jobs.push({ testCase, attempt });
  }

  // ---- Create the run: config is redacted; secret values never reach the database. ----
  const redacted = redactConfig({ adapter: suite.pipeline.adapter, config: suite.pipeline.config });
  for (const path of redacted.masked) {
    warn(
      `${path} looks like a hard-coded secret and was masked before storing. Use a \${ENV_VAR} placeholder instead.`,
    );
  }
  const { $schema: _ignored, ...suiteForHash } = suite;
  const runId = randomUUID();
  const startedAt = now().toISOString();
  store.createRun({
    runId,
    suiteName: suite.name,
    suiteHash: stableHash(suiteForHash),
    startedAt,
    regradeVersion: opts.regradeVersion,
    gitSha: opts.git?.sha ?? null,
    gitDirty: opts.git?.dirty ?? null,
    label: overrides.label ?? null,
    pipeline: {
      ...redacted.value,
      judge: judge ?? null,
      settings: { concurrency, repeat: overrides.repeat ?? defaults.repeat ?? null, timeoutMs: overrides.timeoutMs ?? defaults.timeoutMs ?? DEFAULT_TIMEOUT_MS },
      filters: { tags: overrides.tags ?? null, caseIds: overrides.caseIds ?? null },
    },
  });

  reporter?.onRunStart?.({
    runId,
    suiteName: suite.name,
    pipelineLabel: label,
    judge: scorerNames.includes("llmJudge") ? judge : undefined,
    caseIds: cases.map((c) => c.id),
    caseCount: cases.length,
    attemptCount: jobs.length,
    repeat: Math.max(...cases.map(repeatFor)),
    concurrency,
  });

  // ---- Execute. ----
  const runSignal = opts.signal ?? new AbortController().signal;
  const attempts: AttemptRecord[] = [];

  const executeAttempt = async (testCase: TestCase, attemptNo: number): Promise<AttemptRecord | null> => {
    const timeoutMs = timeoutFor(testCase);
    const scores: ScoreRecord[] = [];
    let result: AdapterResult | undefined;
    let error: string | undefined;

    try {
      const attemptSignal = AbortSignal.any([runSignal, AbortSignal.timeout(timeoutMs)]);
      result = await raceAbort(
        adapter.run(testCase.input, pipelineConfig, {
          signal: attemptSignal,
          caseId: testCase.id,
          attempt: attemptNo,
          env,
          prices,
        }),
        attemptSignal,
        (why) => new AdapterError(`${why} (limit ${timeoutMs} ms)`),
      );
    } catch (err) {
      if (runSignal.aborted) return null;
      error = errorMessage(err);
    }

    if (result) {
      for (const name of testCase.scorers) {
        if (runSignal.aborted) return null;
        let res: ScoreResult;
        const scoreSignal = AbortSignal.any([runSignal, AbortSignal.timeout(timeoutMs)]);
        try {
          res = await raceAbort(registry.getScorer(name).score({
            input: testCase.input,
            expected: testCase.expected,
            output: result.output,
            config: testCase.scorerConfig?.[name],
            meta: {
              caseId: testCase.id,
              attempt: attemptNo,
              latencyMs: result.latencyMs,
              costUsd: result.costUsd,
              usage: result.usage,
            },
            trace: result.steps,
            runtime: { judge, env, prices, signal: scoreSignal },
          }), scoreSignal, (why) => new Error(`scorer "${name}" ${why} (limit ${timeoutMs} ms)`));
        } catch (err) {
          res = { pass: false, value: null, error: errorMessage(err) };
        }
        if (runSignal.aborted) return null;
        scores.push({
          scorerName: name,
          pass: res.error ? false : res.pass,
          value: res.value,
          reasoning: res.reasoning,
          costUsd: res.costUsd,
          error: res.error,
          config: testCase.scorerConfig?.[name],
          metadata: res.metadata,
        });
      }
    }

    const fingerprints = testCase.scorers.map((n) => registry.getScorer(n).fingerprint ?? null);
    // A different judge is a different measuring stick; a per-case judge is already in scorerConfig.
    const runJudge =
      testCase.scorers.includes("llmJudge") && testCase.scorerConfig?.llmJudge?.judge === undefined ? judge : undefined;
    let status: AttemptStatus;
    if (error !== undefined || scores.some((s) => s.error)) status = "errored";
    else if (scores.some((s) => !s.pass)) status = "failed";
    else status = "passed";

    return {
      caseId: testCase.id,
      attempt: attemptNo,
      caseHash: stableHash({
        input: testCase.input,
        expected: testCase.expected ?? null,
        scorers: testCase.scorers,
        scorerConfig: testCase.scorerConfig ?? null,
        // only present when some scorer has a fingerprint, so hashes of built-in-only suites are unchanged
        ...(fingerprints.some((f) => f !== null) ? { scorerFingerprints: fingerprints } : {}),
        ...(runJudge ? { judge: runJudge } : {}),
      }),
      input: testCase.input,
      expected: testCase.expected,
      tags: testCase.tags,
      output: result?.output ?? null,
      latencyMs: result?.latencyMs ?? null,
      costUsd: result?.costUsd ?? null,
      usage: result?.usage,
      status,
      error,
      completedAt: now().toISOString(),
      scores,
      trace: overrides.storeTraces === false ? undefined : prepareTrace(result?.steps),
    };
  };

  // AbortSignal.timeout() timers are unref'd and a pending promise holds nothing open, so a hung pipeline
  // function would let Node exit silently with code 0 mid-run. Keep the event loop alive until we are done.
  const keepAlive = setInterval(() => {}, 60_000);
  try {
    await runPool(
      jobs,
      concurrency,
      async ({ testCase, attempt }) => {
        const record = await executeAttempt(testCase, attempt);
        if (!record) return; // interrupted mid-attempt: discard the partial attempt
        store.saveAttempt(runId, record);
        attempts.push(record);
        reporter?.onAttempt?.(record, { totalAttempts: jobs.length, repeat: repeatFor(testCase) });
      },
      () => runSignal.aborted,
    );
  } catch (err) {
    store.finishRun(runId, "failed", now().toISOString(), summarize(attempts));
    throw err;
  } finally {
    clearInterval(keepAlive);
  }

  const interrupted = runSignal.aborted;
  const status: RunStatus = interrupted ? "interrupted" : "completed";
  const summary = summarize(attempts);
  store.finishRun(runId, status, now().toISOString(), summary);

  const run = store.getRun(runId);
  if (!run) throw new Error(`run ${runId} vanished from the store`);
  const outcomeCases = groupCases(attempts);
  reporter?.onRunEnd?.({ run, cases: outcomeCases });

  const allPassed = outcomeCases.length > 0 && outcomeCases.every((c) => c.verdict === "passed");
  const passRate = summary.attempts.total === 0 ? 0 : summary.attempts.passed / summary.attempts.total;
  const ok = overrides.minPassRate === undefined ? allPassed : passRate >= overrides.minPassRate;
  return {
    run,
    cases: outcomeCases,
    attempts,
    summary,
    warnings,
    passRate,
    exitCode: interrupted ? 130 : ok ? 0 : 1,
  };
}
