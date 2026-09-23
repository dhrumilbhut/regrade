import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { ConfigError, errorMessage } from "../core/errors.js";
import type { AttemptRecord, RunRecord } from "../core/types.js";

export const RUN_FILE_KIND = "regrade.run";
export const RUN_FILE_VERSION = 1;

/**
 * A saved run, portable between machines: a baseline committed to git, a CI artifact, or a run to
 * import into another database. Unlike the JSON report it keeps every attempt's case hash, so
 * `compare` can tell a changed case from a regression.
 *
 * A compact file keeps only what a comparison needs (ids, hashes, statuses, latency, cost, pass/fail
 * per scorer): no inputs, expected answers, outputs, error text or judge reasoning. It is small and
 * safe to commit, and can be compared against but not imported.
 */
export interface RunFile {
  kind: typeof RUN_FILE_KIND;
  schemaVersion: typeof RUN_FILE_VERSION;
  /** Version of Regrade that wrote the file. */
  regradeVersion: string;
  exportedAt: string;
  compact: boolean;
  run: RunRecord;
  attempts: AttemptRecord[];
}

export interface LoadedRun {
  run: RunRecord;
  attempts: AttemptRecord[];
  /** Set when the run came from a file. */
  file?: { path: string; compact: boolean };
}

function compactAttempt(a: AttemptRecord): AttemptRecord {
  return {
    caseId: a.caseId,
    attempt: a.attempt,
    caseHash: a.caseHash,
    input: "",
    tags: a.tags,
    output: null,
    latencyMs: a.latencyMs,
    costUsd: a.costUsd,
    usage: a.usage,
    status: a.status,
    completedAt: a.completedAt,
    scores: a.scores.map((s) => ({
      scorerName: s.scorerName,
      pass: s.pass,
      value: s.value,
      costUsd: s.costUsd,
      metadata: s.metadata,
    })),
  };
}

export function buildRunFile(
  run: RunRecord,
  attempts: readonly AttemptRecord[],
  opts: { regradeVersion: string; compact?: boolean; now?: Date },
): RunFile {
  const compact = opts.compact ?? false;
  return {
    kind: RUN_FILE_KIND,
    schemaVersion: RUN_FILE_VERSION,
    regradeVersion: opts.regradeVersion,
    exportedAt: (opts.now ?? new Date()).toISOString(),
    compact,
    run,
    // compact attempts carry no input/output; the placeholders are not written
    attempts: compact ? attempts.map(compactAttempt) : [...attempts],
  };
}

export function serializeRunFile(file: RunFile): string {
  const attempts = file.compact
    ? file.attempts.map(({ input: _input, output: _output, ...rest }) => rest)
    : file.attempts;
  return `${JSON.stringify({ ...file, attempts }, null, 2)}\n`;
}

export function writeRunFile(path: string, file: RunFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, serializeRunFile(file), "utf8");
}

// Validation: strict about what comparisons rely on, tolerant of extra fields (added in later versions).
const scoreSchema = z.looseObject({
  scorerName: z.string(),
  pass: z.boolean(),
  value: z.number().nullable(),
  reasoning: z.string().optional(),
  costUsd: z.number().nullable().optional(),
  error: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

const attemptSchema = z.looseObject({
  caseId: z.string().min(1),
  attempt: z.number().int().min(1),
  caseHash: z.string().min(1),
  input: z.unknown().optional(),
  expected: z.string().optional(),
  tags: z.array(z.string()).optional(),
  output: z.string().nullable().optional(),
  latencyMs: z.number().nullable(),
  costUsd: z.number().nullable(),
  usage: z.record(z.string(), z.number()).optional(),
  status: z.enum(["passed", "failed", "errored"]),
  error: z.string().optional(),
  completedAt: z.string(),
  scores: z.array(scoreSchema),
});

const runSchema = z.looseObject({
  runId: z.string().min(1),
  suiteName: z.string().min(1),
  suiteHash: z.string(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  status: z.enum(["running", "completed", "interrupted", "failed"]),
  regradeVersion: z.string(),
  gitSha: z.string().nullable(),
  gitDirty: z.boolean().nullable(),
  label: z.string().nullable(),
  pipeline: z.record(z.string(), z.unknown()),
  summary: z.record(z.string(), z.unknown()).nullable(),
});

const fileSchema = z.looseObject({
  kind: z.literal(RUN_FILE_KIND),
  schemaVersion: z.literal(RUN_FILE_VERSION),
  regradeVersion: z.string(),
  exportedAt: z.string(),
  compact: z.boolean(),
  run: runSchema,
  attempts: z.array(attemptSchema),
});

/** Parse a run file's text; `path` names it in errors. Throws `ConfigError` for anything that is not a valid run file. */
export function parseRunFile(text: string, path: string): LoadedRun {
  const source = `"${path}"`;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`${source} is not valid JSON: ${errorMessage(err)}`);
  }
  const head = raw as { kind?: unknown; schemaVersion?: unknown } | null;
  if (head?.kind !== RUN_FILE_KIND) {
    throw new ConfigError(
      `${source} is not a Regrade run file (expected "kind": "${RUN_FILE_KIND}"). ` +
        "Create one with `regrade export <run>` or `regrade run --export <file>`; a `--json` report cannot be used as a run.",
    );
  }
  if (typeof head.schemaVersion === "number" && head.schemaVersion > RUN_FILE_VERSION) {
    throw new ConfigError(`${source} was written by a newer Regrade (run file version ${head.schemaVersion}). Upgrade Regrade.`);
  }
  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ConfigError(`${source} is not a valid run file: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "unexpected shape"}`);
  }
  const f = parsed.data;
  const attempts = f.attempts.map(
    (a) => ({ ...a, input: a.input ?? "", output: a.output ?? null }) as unknown as AttemptRecord,
  );
  return { run: f.run as unknown as RunRecord, attempts, file: { path, compact: f.compact } };
}

export function readRunFile(path: string): LoadedRun {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new ConfigError(`Cannot read run file "${path}": ${errorMessage(err)}`);
  }
  return parseRunFile(text, path);
}
