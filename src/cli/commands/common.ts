import { existsSync, statSync } from "node:fs";
import pc from "picocolors";
import { ConfigError } from "../../core/errors.js";
import type { RunRecord } from "../../core/types.js";
import { readRunFile, type LoadedRun } from "../../store/runFile.js";
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

export type RunWithAttempts = LoadedRun;

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

/** A run reference that names a run file rather than a run id: an existing file, or anything ending in `.json`. */
export function isRunFileRef(ref: string): boolean {
  return ref.toLowerCase().endsWith(".json") || (existsSync(ref) && statSync(ref).isFile());
}

/**
 * Resolves run references, each either a run id (prefix) in the database or a run file. The database
 * is opened only when a run id needs it, so comparing two files works without one.
 */
export class RunSource {
  private opened: SqliteStore | undefined;
  constructor(private readonly dbPath: string | undefined) {}

  store(): SqliteStore {
    this.opened ??= openExistingStore(this.dbPath);
    return this.opened;
  }

  load(ref: string): LoadedRun {
    return isRunFileRef(ref) ? readRunFile(ref) : loadRun(this.store(), ref);
  }

  /**
   * Which two runs to compare. As `pickComparison`, except that a run file given alone is the
   * base (a baseline), compared with the latest run of its suite in the database.
   */
  pick(refs: string[], suite?: string): { base: LoadedRun; head: LoadedRun } {
    if (refs.length >= 2) return { base: this.load(refs[0] as string), head: this.load(refs[1] as string) };
    if (refs.length === 1 && isRunFileRef(refs[0] as string)) {
      const base = readRunFile(refs[0] as string);
      const latest = this.store()
        .listRuns({ suiteName: base.run.suiteName, limit: 5 })
        .find((r) => r.runId !== base.run.runId && r.status !== "running");
      if (!latest) {
        throw new ConfigError(
          `No run of suite "${base.run.suiteName}" in the database to compare with ${refs[0]}. ` +
            "Run the suite first, or name both runs: `regrade compare <base> <head>`.",
        );
      }
      return { base, head: loadRun(this.store(), latest.runId) };
    }
    const { base, head } = pickComparison(this.store(), refs, suite);
    return { base: loadRun(this.store(), base.runId), head: loadRun(this.store(), head.runId) };
  }

  close(): void {
    this.opened?.close();
  }
}

export function colorFor(color: boolean | undefined) {
  return pc.createColors(color ?? (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR));
}
