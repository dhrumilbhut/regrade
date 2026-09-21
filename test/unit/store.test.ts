import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../src/core/errors.js";
import type { RunSummary } from "../../src/core/types.js";
import { LATEST_SCHEMA_VERSION } from "../../src/store/migrations.js";
import { SqliteStore } from "../../src/store/sqliteStore.js";
import { attempt } from "../helpers.js";

const dirs: string[] = [];
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) {
    try {
      s.close();
    } catch {
      /* already closed */
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmpDb(): string {
  const d = mkdtempSync(join(tmpdir(), "regrade-store-"));
  dirs.push(d);
  return join(d, "nested", "results.db");
}

function open(path = ":memory:"): SqliteStore {
  const s = new SqliteStore(path);
  stores.push(s);
  return s;
}

const newRun = (runId: string, over = {}) => ({
  runId,
  suiteName: "suite",
  suiteHash: "sh",
  startedAt: "2026-09-21T10:00:00.000Z",
  regradeVersion: "0.1.0",
  gitSha: "abc123",
  gitDirty: true,
  label: "v1",
  pipeline: { adapter: "http", config: { url: "http://x" } },
  ...over,
});

const summary: RunSummary = {
  cases: { total: 1, passed: 1, failed: 0, flaky: 0, errored: 0 },
  attempts: { total: 1, passed: 1, failed: 0, errored: 0 },
  latency: { avgMs: 10, p95Ms: 10 },
  costUsd: { pipeline: 0, judge: 0, unknownAttempts: 1 },
};

describe("SqliteStore", () => {
  it("writes a run and reads it back, including attempts and scores", () => {
    const store = open();
    store.createRun(newRun("run-1"));
    store.saveAttempt(
      "run-1",
      attempt({
        caseId: "capital",
        expected: "Paris",
        tags: ["geo"],
        input: { messages: [{ role: "user", content: "hi" }] },
        usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 },
        costUsd: 0.001,
        scores: [
          { scorerName: "exactMatch", pass: true, value: 1 },
          { scorerName: "llmJudge", pass: false, value: 0, reasoning: "nope", costUsd: 0.0004, config: { rubric: "r" } },
        ],
        status: "failed",
      }),
    );
    store.finishRun("run-1", "completed", "2026-09-21T10:00:05.000Z", summary);

    const run = store.getRun("run-1")!;
    expect(run).toMatchObject({
      runId: "run-1",
      suiteName: "suite",
      status: "completed",
      finishedAt: "2026-09-21T10:00:05.000Z",
      gitSha: "abc123",
      gitDirty: true,
      label: "v1",
      pipeline: { adapter: "http", config: { url: "http://x" } },
      summary,
    });

    const [a] = store.getAttempts("run-1");
    expect(a).toMatchObject({
      caseId: "capital",
      attempt: 1,
      expected: "Paris",
      tags: ["geo"],
      input: { messages: [{ role: "user", content: "hi" }] },
      costUsd: 0.001,
      status: "failed",
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 },
    });
    expect(a?.scores).toHaveLength(2);
    expect(a?.scores[1]).toMatchObject({ scorerName: "llmJudge", pass: false, reasoning: "nope", costUsd: 0.0004, config: { rubric: "r" } });
  });

  it("stores one row per case per attempt and rejects a duplicate", () => {
    const store = open();
    store.createRun(newRun("r"));
    store.saveAttempt("r", attempt({ caseId: "c", attempt: 1 }));
    store.saveAttempt("r", attempt({ caseId: "c", attempt: 2 }));
    expect(store.getAttempts("r").map((a) => a.attempt)).toEqual([1, 2]);
    expect(() => store.saveAttempt("r", attempt({ caseId: "c", attempt: 2 }))).toThrow(/UNIQUE/);
  });

  it("is atomic: a failing score insert does not leave a half-written result", () => {
    const store = open();
    store.createRun(newRun("r"));
    const bad = attempt({ caseId: "c", scores: [{ scorerName: "x", pass: true, value: 1, config: { big: 10n as unknown as number } }] });
    expect(() => store.saveAttempt("r", bad)).toThrow();
    expect(store.getAttempts("r")).toHaveLength(0);
  });

  it("marks runs as running until finished, and stores null cost as NULL", () => {
    const store = open();
    store.createRun(newRun("r"));
    expect(store.getRun("r")).toMatchObject({ status: "running", finishedAt: null, summary: null });
    store.saveAttempt("r", attempt({ costUsd: null, latencyMs: null, output: null, status: "errored", error: "boom", scores: [] }));
    expect(store.getAttempts("r")[0]).toMatchObject({ costUsd: null, latencyMs: null, output: null, error: "boom" });
  });

  it("resolves a unique id prefix and rejects an ambiguous one", () => {
    const store = open();
    store.createRun(newRun("abcd1111"));
    store.createRun(newRun("abcd2222"));
    expect(store.getRun("abcd1")?.runId).toBe("abcd1111");
    expect(() => store.getRun("abcd")).toThrow(ConfigError);
    expect(store.getRun("zzzz")).toBeUndefined();
    expect(store.getRun("ab_d")).toBeUndefined(); // '_' is not a wildcard
  });

  it("lists runs newest first, optionally per suite", () => {
    const store = open();
    store.createRun(newRun("old", { startedAt: "2026-01-01T00:00:00.000Z" }));
    store.createRun(newRun("new", { startedAt: "2026-06-01T00:00:00.000Z" }));
    store.createRun(newRun("other", { suiteName: "other-suite", startedAt: "2026-07-01T00:00:00.000Z" }));
    expect(store.listRuns().map((r) => r.runId)).toEqual(["other", "new", "old"]);
    expect(store.listRuns({ suiteName: "suite" }).map((r) => r.runId)).toEqual(["new", "old"]);
    expect(store.listRuns({ limit: 1 })).toHaveLength(1);
  });

  it("cascades deletes from runs to results to scores (foreign keys are on)", () => {
    const path = tmpDb();
    const store = open(path);
    store.createRun(newRun("r"));
    store.saveAttempt("r", attempt());
    store.close();

    const raw = new Database(path);
    raw.pragma("foreign_keys = ON");
    raw.prepare("DELETE FROM runs WHERE run_id = 'r'").run();
    expect((raw.prepare("SELECT count(*) c FROM results").get() as { c: number }).c).toBe(0);
    expect((raw.prepare("SELECT count(*) c FROM scores").get() as { c: number }).c).toBe(0);
    raw.close();
  });

  it("creates parent directories, enables WAL, and records the schema version", () => {
    const path = tmpDb();
    const store = open(path);
    expect(store.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    store.close();
    const raw = new Database(path);
    expect(raw.pragma("journal_mode", { simple: true })).toBe("wal");
    raw.close();
  });

  it("re-opening an existing database keeps data and does not re-run migrations", () => {
    const path = tmpDb();
    const a = open(path);
    a.createRun(newRun("keep"));
    a.close();
    const b = open(path);
    expect(b.getRun("keep")).toBeDefined();
    expect(b.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
  });

  it("refuses a database created by a newer Regrade", () => {
    const path = tmpDb();
    open(path).close();
    const raw = new Database(path);
    raw.pragma(`user_version = ${LATEST_SCHEMA_VERSION + 5}`);
    raw.close();
    expect(() => new SqliteStore(path)).toThrow(/newer than this Regrade/);
  });

  it("rejects an invalid status via CHECK constraints", () => {
    const path = tmpDb();
    const store = open(path);
    store.createRun(newRun("r"));
    store.close();
    const raw = new Database(path);
    expect(() => raw.prepare("UPDATE runs SET status = 'bogus'").run()).toThrow(/CHECK/);
    raw.close();
  });
});
