import { ConfigError } from "../../core/errors.js";
import { summarize } from "../../core/verdict.js";
import { buildRunFile, readRunFile, serializeRunFile, writeRunFile } from "../../store/runFile.js";
import { SqliteStore } from "../../store/sqliteStore.js";
import { VERSION } from "../version.js";
import { loadRun, openExistingStore } from "./common.js";
import { DEFAULT_DB_PATH } from "./run.js";

export interface ExportOptions {
  db?: string;
  out?: string;
  compact?: boolean;
}

/** Write a run to a portable run file (or stdout). */
export function exportCommand(runRef: string, o: ExportOptions): void {
  const store = openExistingStore(o.db);
  try {
    const { run, attempts } = loadRun(store, runRef, { traces: true });
    const file = buildRunFile(run, attempts, { regradeVersion: VERSION, compact: o.compact });
    if (!o.out) {
      process.stdout.write(serializeRunFile(file));
      return;
    }
    writeRunFile(o.out, file);
    process.stdout.write(`run ${run.runId.slice(0, 8)} → ${o.out}${o.compact ? " (compact)" : ""}\n`);
  } finally {
    store.close();
  }
}

export interface ImportOptions {
  db?: string;
}

/** Load a full run file into the database. Importing a run that is already there does nothing. */
export function importCommand(path: string, o: ImportOptions): void {
  const { run, attempts, file } = readRunFile(path);
  if (file?.compact) {
    throw new ConfigError(
      `"${path}" is a compact run file: it has no inputs or outputs, so it can be compared against but not imported.`,
    );
  }
  const dbPath = o.db ?? DEFAULT_DB_PATH;
  const store = new SqliteStore(dbPath);
  try {
    if (store.getRun(run.runId)?.runId === run.runId) {
      process.stdout.write(`run ${run.runId.slice(0, 8)} is already in ${dbPath}; nothing to import.\n`);
      return;
    }
    store.importRun(run, attempts, run.summary ?? summarize(attempts));
    process.stdout.write(`imported run ${run.runId.slice(0, 8)} (${run.suiteName}, ${attempts.length} attempts) → ${dbPath}\n`);
  } finally {
    store.close();
  }
}
