import { stableHash } from "../core/hash.js";
import type { AttemptRecord, CaseVerdict, RunRecord, RunSummary } from "../core/types.js";
import { caseVerdict, summarize } from "../core/verdict.js";
import { stratifiedBootstrapInterval, stratifiedPermutationTest, type PairedCase } from "./bootstrap.js";
import { fisherExact } from "./fisher.js";
import { wilsonInterval, type Proportion } from "./wilson.js";

export type CaseChange = "regressed" | "improved" | "unchanged" | "flaky" | "modified" | "new" | "removed" | "errored";

export type OverallVerdict = "significant-regression" | "significant-improvement" | "not-significant" | "no-comparable-cases";

/** Significance level for the per-case Fisher exact test. */
export const CASE_ALPHA = 0.05;
/** Significance level for the overall stratified permutation test. */
export const OVERALL_ALPHA = 0.05;

export interface RunMeta {
  runId: string;
  suiteName: string;
  suiteHash: string;
  startedAt: string;
  status: RunRecord["status"];
  label: string | null;
  gitSha: string | null;
  gitDirty: boolean | null;
}

export interface CaseComparison {
  caseId: string;
  change: CaseChange;
  /** regressed/improved only: Fisher exact p < CASE_ALPHA. With one attempt per side this is never true. */
  significant?: boolean;
  pValue?: number;
  base?: Proportion;
  head?: Proportion;
  baseVerdict?: CaseVerdict;
  headVerdict?: CaseVerdict;
  /** errored only: which run had errored attempts. */
  erroredIn?: "base" | "head" | "both";
  note?: string;
}

export interface Comparison {
  base: RunMeta;
  head: RunMeta;
  cases: CaseComparison[];
  counts: Record<CaseChange, number>;
  overall: {
    /** Cases present in both runs, unchanged in definition, with no errored attempts. */
    comparableCases: number;
    /** Pooled attempt pass rates over the comparable cases (descriptive: attempts within a case are correlated). */
    base: Proportion | null;
    head: Proportion | null;
    /** Mean over comparable cases of (head pass rate - base pass rate). */
    meanDelta: number | null;
    /** 95% within-case bootstrap interval for meanDelta. */
    ci: { lo: number; hi: number } | null;
    /** Two-sided p-value of the case-stratified permutation test (null if nothing is comparable). */
    pValue: number | null;
    verdict: OverallVerdict;
  };
  metrics: {
    base: RunSummary;
    head: RunSummary;
  };
  warnings: string[];
}

export interface CompareInput {
  base: { run: RunRecord; attempts: readonly AttemptRecord[] };
  head: { run: RunRecord; attempts: readonly AttemptRecord[] };
}

const CHANGE_ORDER: CaseChange[] = ["regressed", "errored", "flaky", "improved", "modified", "new", "removed", "unchanged"];

const meta = (r: RunRecord): RunMeta => ({
  runId: r.runId,
  suiteName: r.suiteName,
  suiteHash: r.suiteHash,
  startedAt: r.startedAt,
  status: r.status,
  label: r.label,
  gitSha: r.gitSha,
  gitDirty: r.gitDirty,
});

function byCase(attempts: readonly AttemptRecord[]): Map<string, AttemptRecord[]> {
  const m = new Map<string, AttemptRecord[]>();
  for (const a of attempts) {
    const list = m.get(a.caseId);
    if (list) list.push(a);
    else m.set(a.caseId, [a]);
  }
  return m;
}

const hashOf = (list: readonly AttemptRecord[]): string => [...new Set(list.map((a) => a.caseHash))].sort().join("|");

function proportion(list: readonly AttemptRecord[]): Proportion {
  return wilsonInterval(list.filter((a) => a.status === "passed").length, list.length);
}

/**
 * Compare two runs, case by case.
 *
 * Cases are matched by id. A case whose definition changed (different case hash)
 * is `modified` and excluded from regression counts; a case with any errored
 * attempt is `errored` (there is no verdict to compare). For the rest:
 * - pass rates (with Wilson 95% intervals) are compared; lower is `regressed`,
 *   higher is `improved`; equal is `unchanged`, or `flaky` if the head outcomes are mixed;
 * - a Fisher exact test says whether a change is statistically significant. With a
 *   single attempt per side it never can be, so such changes are reported as
 *   real but unconfirmed: re-run with --repeat to tell a regression from noise.
 * The aggregate is a case-stratified paired permutation test on the mean change in pass rate,
 * with a within-case bootstrap interval: the randomness that matters for "did this suite get
 * worse?" is the pipeline's sampling noise within each case, not which cases happen to exist.
 */
export function compareRuns(input: CompareInput): Comparison {
  const { base, head } = input;
  const baseCases = byCase(base.attempts);
  const headCases = byCase(head.attempts);
  const warnings: string[] = [];

  if (base.run.runId === head.run.runId) warnings.push("base and head are the same run.");
  if (base.run.suiteName !== head.run.suiteName) {
    warnings.push(`the runs are for different suites ("${base.run.suiteName}" vs "${head.run.suiteName}"); cases are matched by id only.`);
  }
  for (const [label, r] of [["base", base.run], ["head", head.run]] as const) {
    if (r.status !== "completed") warnings.push(`the ${label} run is ${r.status}: results may be partial.`);
  }

  const ids: string[] = [...headCases.keys(), ...[...baseCases.keys()].filter((id) => !headCases.has(id))];
  const cases: CaseComparison[] = [];
  const paired: PairedCase[] = [];
  let pooledBase = { passed: 0, attempts: 0 };
  let pooledHead = { passed: 0, attempts: 0 };
  let differingAttemptCounts = 0;

  for (const caseId of ids) {
    const b = baseCases.get(caseId);
    const h = headCases.get(caseId);
    if (!b && h) {
      cases.push({ caseId, change: "new", head: proportion(h), headVerdict: caseVerdict(h.map((a) => a.status)) });
      continue;
    }
    if (b && !h) {
      cases.push({ caseId, change: "removed", base: proportion(b), baseVerdict: caseVerdict(b.map((a) => a.status)) });
      continue;
    }
    if (!b || !h) continue;

    const baseVerdict = caseVerdict(b.map((a) => a.status));
    const headVerdict = caseVerdict(h.map((a) => a.status));
    const common = { caseId, baseVerdict, headVerdict };

    if (hashOf(b) !== hashOf(h)) {
      cases.push({ ...common, change: "modified", note: "the case definition changed between runs, so results are not comparable" });
      continue;
    }
    const baseErrored = b.some((a) => a.status === "errored");
    const headErrored = h.some((a) => a.status === "errored");
    if (baseErrored || headErrored) {
      cases.push({
        ...common,
        change: "errored",
        erroredIn: baseErrored && headErrored ? "both" : baseErrored ? "base" : "head",
        note: "errored attempts leave no verdict to compare",
      });
      continue;
    }

    const pb = proportion(b);
    const ph = proportion(h);
    if (b.length !== h.length) differingAttemptCounts++;
    const p = fisherExact(pb.passed, pb.attempts, ph.passed, ph.attempts);
    pooledBase = { passed: pooledBase.passed + pb.passed, attempts: pooledBase.attempts + pb.attempts };
    pooledHead = { passed: pooledHead.passed + ph.passed, attempts: pooledHead.attempts + ph.attempts };
    paired.push({
      base: b.map((a) => (a.status === "passed" ? 1 : 0)),
      head: h.map((a) => (a.status === "passed" ? 1 : 0)),
    });

    let change: CaseChange;
    if (ph.rate < pb.rate) change = "regressed";
    else if (ph.rate > pb.rate) change = "improved";
    else change = headVerdict === "flaky" ? "flaky" : "unchanged";

    const changed = change === "regressed" || change === "improved";
    cases.push({
      ...common,
      change,
      base: pb,
      head: ph,
      pValue: p,
      significant: changed ? p < CASE_ALPHA : undefined,
      note:
        changed && !(p < CASE_ALPHA)
          ? pb.attempts === 1 && ph.attempts === 1
            ? "a single attempt on each side: could be noise, re-run with --repeat to confirm"
            : "not statistically significant at this sample size"
          : undefined,
    });
  }

  if (differingAttemptCounts > 0) {
    warnings.push(`${differingAttemptCounts} case(s) were run a different number of times in the two runs.`);
  }
  if (base.run.suiteHash !== head.run.suiteHash && cases.some((c) => c.change === "modified")) {
    warnings.push("the suite definition changed between runs; modified cases were excluded from the comparison.");
  }

  cases.sort((x, y) => CHANGE_ORDER.indexOf(x.change) - CHANGE_ORDER.indexOf(y.change));
  const counts = Object.fromEntries(CHANGE_ORDER.map((c) => [c, 0])) as Record<CaseChange, number>;
  for (const c of cases) counts[c.change]++;

  const n = paired.length;
  let meanDelta: number | null = null;
  let ci: { lo: number; hi: number } | null = null;
  let pValue: number | null = null;
  let verdict: OverallVerdict = "no-comparable-cases";
  if (n > 0) {
    const seed = parseInt(stableHash([base.run.runId, head.run.runId]).slice(0, 8), 16);
    const perm = stratifiedPermutationTest(paired, { seed });
    const boot = stratifiedBootstrapInterval(paired, { seed });
    meanDelta = perm?.observed ?? null;
    pValue = perm?.p ?? null;
    ci = boot ? { lo: boot.lo, hi: boot.hi } : null;
    if (pValue !== null && meanDelta !== null && pValue < OVERALL_ALPHA && meanDelta < 0) verdict = "significant-regression";
    else if (pValue !== null && meanDelta !== null && pValue < OVERALL_ALPHA && meanDelta > 0) verdict = "significant-improvement";
    else verdict = "not-significant";
  }

  return {
    base: meta(base.run),
    head: meta(head.run),
    cases,
    counts,
    overall: {
      comparableCases: n,
      base: n === 0 ? null : wilsonInterval(pooledBase.passed, pooledBase.attempts),
      head: n === 0 ? null : wilsonInterval(pooledHead.passed, pooledHead.attempts),
      meanDelta,
      ci,
      pValue,
      verdict,
    },
    metrics: { base: summarize(base.attempts), head: summarize(head.attempts) },
    warnings,
  };
}

export interface GateResult {
  failed: boolean;
  reasons: string[];
}

/**
 * Should CI fail? Fails on regressed cases, on cases that errored in the head run
 * (nothing can be confirmed about them), and on a significant aggregate regression.
 * With `significantOnly`, unconfirmed regressions (e.g. a single attempt) do not fail the gate.
 */
export function regressionGate(cmp: Comparison, opts: { significantOnly?: boolean } = {}): GateResult {
  const reasons: string[] = [];
  const regressed = cmp.cases.filter((c) => c.change === "regressed");
  const counted = opts.significantOnly ? regressed.filter((c) => c.significant) : regressed;
  if (counted.length > 0) {
    reasons.push(`${counted.length} regressed case${counted.length > 1 ? "s" : ""}: ${counted.map((c) => c.caseId).join(", ")}`);
  }
  const headErrored = cmp.cases.filter((c) => c.change === "errored" && c.erroredIn !== "base");
  if (headErrored.length > 0) {
    reasons.push(`${headErrored.length} case${headErrored.length > 1 ? "s" : ""} errored in the head run: ${headErrored.map((c) => c.caseId).join(", ")}`);
  }
  if (cmp.overall.verdict === "significant-regression") {
    reasons.push("the overall pass rate dropped significantly (case-stratified permutation test)");
  }
  return { failed: reasons.length > 0, reasons };
}
