/**
 * Numbered migrations, applied in order and tracked with `PRAGMA user_version`.
 * Migrations are embedded as strings (rather than .sql files) so the CLI bundles
 * into one file. Never edit a released migration: add a new one.
 */
export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    description: "runs, results (one row per case per attempt), scores",
    sql: `
CREATE TABLE runs (
  run_id          TEXT PRIMARY KEY,
  suite_name      TEXT NOT NULL,
  suite_hash      TEXT NOT NULL,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  status          TEXT NOT NULL CHECK (status IN ('running','completed','interrupted','failed')),
  regrade_version TEXT NOT NULL,
  git_sha         TEXT,
  git_dirty       INTEGER,
  label           TEXT,
  pipeline_json   TEXT NOT NULL,
  summary_json    TEXT
);

CREATE TABLE results (
  result_id           INTEGER PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(run_id) ON DELETE CASCADE,
  case_id             TEXT NOT NULL,
  attempt             INTEGER NOT NULL DEFAULT 1,
  case_hash           TEXT NOT NULL,
  input_json          TEXT NOT NULL,
  expected            TEXT,
  tags_json           TEXT,
  output              TEXT,
  latency_ms          REAL,
  cost_usd            REAL,
  input_tokens        INTEGER,
  output_tokens       INTEGER,
  cached_input_tokens INTEGER,
  status              TEXT NOT NULL CHECK (status IN ('passed','failed','errored')),
  error               TEXT,
  completed_at        TEXT NOT NULL,
  UNIQUE (run_id, case_id, attempt)
);

CREATE TABLE scores (
  score_id    INTEGER PRIMARY KEY,
  result_id   INTEGER NOT NULL REFERENCES results(result_id) ON DELETE CASCADE,
  scorer_name TEXT NOT NULL,
  pass        INTEGER NOT NULL CHECK (pass IN (0,1)),
  value       REAL,
  reasoning   TEXT,
  cost_usd    REAL,
  error       TEXT,
  config_json TEXT
);

CREATE INDEX idx_runs_suite   ON runs(suite_name, started_at);
CREATE INDEX idx_results_run  ON results(run_id);
CREATE INDEX idx_results_case ON results(case_id, run_id);
CREATE INDEX idx_scores_res   ON scores(result_id);
`,
  },
  {
    version: 2,
    description: "scores.metadata_json: how a score was produced (e.g. the judge model and temperature)",
    sql: `ALTER TABLE scores ADD COLUMN metadata_json TEXT;`,
  },
];

export const LATEST_SCHEMA_VERSION = migrations[migrations.length - 1]?.version ?? 0;
