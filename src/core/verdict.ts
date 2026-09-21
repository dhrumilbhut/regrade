import type { AttemptRecord, AttemptStatus, CaseVerdict, RunSummary } from "./types.js";

/**
 * A case's verdict over all its attempts:
 * - passed:  every attempt passed
 * - failed:  no attempt passed and none errored
 * - flaky:   a mix of passed and failed attempts (non-deterministic pipeline)
 * - errored: at least one attempt errored, so there is not enough evidence
 */
export function caseVerdict(statuses: readonly AttemptStatus[]): CaseVerdict {
  if (statuses.length === 0) return "errored";
  if (statuses.includes("errored")) return "errored";
  const passed = statuses.filter((s) => s === "passed").length;
  if (passed === statuses.length) return "passed";
  if (passed === 0) return "failed";
  return "flaky";
}

export interface CaseOutcome {
  caseId: string;
  verdict: CaseVerdict;
  attempts: AttemptRecord[];
}

/** Group attempts by case (in first-seen order) and compute each verdict. */
export function groupCases(attempts: readonly AttemptRecord[]): CaseOutcome[] {
  const byCase = new Map<string, AttemptRecord[]>();
  for (const a of attempts) {
    const list = byCase.get(a.caseId);
    if (list) list.push(a);
    else byCase.set(a.caseId, [a]);
  }
  return [...byCase.entries()].map(([caseId, list]) => {
    const sorted = [...list].sort((x, y) => x.attempt - y.attempt);
    return { caseId, verdict: caseVerdict(sorted.map((a) => a.status)), attempts: sorted };
  });
}

/** Nearest-rank percentile of an ascending-sorted list. */
export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1] ?? 0;
}

export function summarize(attempts: readonly AttemptRecord[]): RunSummary {
  const cases = groupCases(attempts);
  const latencies = attempts
    .map((a) => a.latencyMs)
    .filter((l): l is number => l !== null)
    .sort((a, b) => a - b);

  let pipeline = 0;
  let judge = 0;
  let unknownAttempts = 0;
  for (const a of attempts) {
    if (a.costUsd === null) unknownAttempts++;
    else pipeline += a.costUsd;
    for (const s of a.scores) if (typeof s.costUsd === "number") judge += s.costUsd;
  }

  return {
    cases: {
      total: cases.length,
      passed: cases.filter((c) => c.verdict === "passed").length,
      failed: cases.filter((c) => c.verdict === "failed").length,
      flaky: cases.filter((c) => c.verdict === "flaky").length,
      errored: cases.filter((c) => c.verdict === "errored").length,
    },
    attempts: {
      total: attempts.length,
      passed: attempts.filter((a) => a.status === "passed").length,
      failed: attempts.filter((a) => a.status === "failed").length,
      errored: attempts.filter((a) => a.status === "errored").length,
    },
    latency:
      latencies.length === 0
        ? null
        : { avgMs: latencies.reduce((s, x) => s + x, 0) / latencies.length, p95Ms: percentile(latencies, 95) },
    costUsd: { pipeline, judge, unknownAttempts },
  };
}
