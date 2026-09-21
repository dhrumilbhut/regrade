import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AttemptRecord, CaseVerdict, RunRecord, RunSummary } from "../core/types.js";
import { groupCases, summarize } from "../core/verdict.js";

/** Stable, versioned shape of the JSON report (also the input for future HTML/Markdown reporters). */
export interface RunReport {
  schemaVersion: 1;
  run: Omit<RunRecord, "summary">;
  summary: RunSummary;
  cases: Array<{
    caseId: string;
    verdict: CaseVerdict;
    /** Snapshot of the case as it ran (from its first attempt). */
    input: AttemptRecord["input"];
    expected?: string;
    tags?: string[];
    attempts: Array<{
      attempt: number;
      status: AttemptRecord["status"];
      latencyMs: number | null;
      costUsd: number | null;
      output: string | null;
      error?: string;
      scores: AttemptRecord["scores"];
    }>;
  }>;
}

export function buildRunReport(run: RunRecord, attempts: readonly AttemptRecord[]): RunReport {
  const { summary: stored, ...meta } = run;
  return {
    schemaVersion: 1,
    run: meta,
    summary: stored ?? summarize(attempts),
    cases: groupCases(attempts).map((c) => ({
      caseId: c.caseId,
      verdict: c.verdict,
      input: c.attempts[0]?.input ?? "",
      expected: c.attempts[0]?.expected,
      tags: c.attempts[0]?.tags,
      attempts: c.attempts.map((a) => ({
        attempt: a.attempt,
        status: a.status,
        latencyMs: a.latencyMs,
        costUsd: a.costUsd,
        output: a.output,
        error: a.error,
        scores: a.scores,
      })),
    })),
  };
}

export function writeJsonReport(path: string, report: RunReport): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
