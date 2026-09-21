import { existsSync } from "node:fs";
import pc from "picocolors";
import { ConfigError } from "../../core/errors.js";
import type { AttemptRecord, RunRecord } from "../../core/types.js";
import { SqliteStore } from "../../store/sqliteStore.js";
import type { Store } from "../../store/store.js";
import { DEFAULT_DB_PATH } from "./run.js";

/** Open an existing results database for reading; never creates an empty one by accident. */
export function openExistingStore(dbPath: string | undefined): SqliteStore {
  const path = dbPath ?? DEFAULT_DB_PATH;
  if (!existsSync(path)) {
    throw new ConfigError(`No results database at "${path}". Run \`regrade run <suite>\` first, or pass --db <path>.`);
  }
  return new SqliteStore(path);
}

export function requireRun(store: Store, ref: string): RunRecord {
  const run = store.getRun(ref);
  if (!run) throw new ConfigError(`No run matching "${ref}". Use \`regrade runs\` to list runs.`);
  return run;
}

export interface RunWithAttempts {
  run: RunRecord;
  attempts: AttemptRecord[];
}

export function loadRun(store: Store, ref: string): RunWithAttempts {
  const run = requireRun(store, ref);
  return { run, attempts: store.getAttempts(run.runId) };
}

/**
 * Choose which two runs to compare:
 * - no arguments: the latest run and the one before it (same suite; `suite` picks one, else the most recent run's suite)
 * - one argument: that run (head) against the previous run of the same suite
 * - two arguments: base then head
 */
export function pickComparison(store: Store, refs: string[], suite?: string): { base: RunRecord; head: RunRecord } {
  if (refs.length >= 2) return { base: requireRun(store, refs[0] as string), head: requireRun(store, refs[1] as string) };

  let head: RunRecord;
  if (refs.length === 1) {
    head = requireRun(store, refs[0] as string);
  } else {
    const recent = store.listRuns({ suiteName: suite, limit: 1 })[0];
    if (!recent) {
      throw new ConfigError(suite ? `No runs found for suite "${suite}".` : "No runs in the database yet. Run `regrade run <suite>` first.");
    }
    head = recent;
  }
  // the previous run of the same suite that started before the head
  const previous = store
    .listRuns({ suiteName: head.suiteName, limit: 200 })
    .find((r) => r.runId !== head.runId && r.startedAt < head.startedAt && r.status !== "running");
  if (!previous) {
    throw new ConfigError(
      `There is no earlier run of "${head.suiteName}" to compare run ${head.runId.slice(0, 8)} against. ` +
        "Run the suite again, or name two runs: `regrade compare <base> <head>`.",
    );
  }
  return { base: previous, head };
}

export function colorFor(color: boolean | undefined) {
  return pc.createColors(color ?? (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR));
}
