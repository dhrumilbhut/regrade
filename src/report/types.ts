import type { CaseOutcome } from "../core/verdict.js";
import type { AttemptRecord, RunRecord } from "../core/types.js";

export interface RunStartInfo {
  runId: string;
  suiteName: string;
  /** e.g. `http → localhost:4000/pipeline` or `anthropic:claude-sonnet-5`. */
  pipelineLabel: string;
  judge?: string;
  caseIds: string[];
  caseCount: number;
  attemptCount: number;
  repeat: number;
  concurrency: number;
}

export interface RunReporter {
  onRunStart?(info: RunStartInfo): void;
  onWarning?(message: string): void;
  /** Called after each attempt has been persisted. */
  onAttempt?(attempt: AttemptRecord, info: { totalAttempts: number; repeat: number }): void;
  onRunEnd?(outcome: { run: RunRecord; cases: CaseOutcome[] }): void;
}
