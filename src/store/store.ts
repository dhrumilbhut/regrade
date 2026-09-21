import type { AttemptRecord, RunRecord, RunStatus, RunSummary } from "../core/types.js";

export type NewRun = Omit<RunRecord, "finishedAt" | "summary" | "status">;

/**
 * Persistence contract. SQLite is the default implementation; the interface
 * keeps a future Postgres store a port rather than a redesign.
 */
export interface Store {
  /** Creates the run with status "running". */
  createRun(run: NewRun): void;
  /** Persists one attempt and its scores atomically. */
  saveAttempt(runId: string, attempt: AttemptRecord): void;
  finishRun(runId: string, status: RunStatus, finishedAt: string, summary: RunSummary): void;
  /** Accepts a full run id or a unique prefix. Throws `ConfigError` if ambiguous. */
  getRun(idOrPrefix: string): RunRecord | undefined;
  listRuns(opts?: { suiteName?: string; limit?: number }): RunRecord[];
  getAttempts(runId: string): AttemptRecord[];
  close(): void;
}
