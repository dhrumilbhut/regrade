import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/core/errors.js";
import type { AttemptRecord, RunRecord } from "../../src/core/types.js";
import { summarize } from "../../src/core/verdict.js";
import { buildRunReport } from "../../src/report/model.js";
import { compareRuns } from "../../src/stats/compare.js";
import { buildRunFile, parseRunFile, serializeRunFile } from "../../src/store/runFile.js";
import { SqliteStore } from "../../src/store/sqliteStore.js";
import { attempt } from "../helpers.js";

const run = (runId: string, attempts: AttemptRecord[]): RunRecord => ({
  runId,
  suiteName: "support-bot",
  suiteHash: "sh",
  startedAt: "2026-09-23T10:00:00.000Z",
  finishedAt: "2026-09-23T10:00:05.000Z",
  status: "completed",
  regradeVersion: "0.4.0",
  gitSha: "abc1234",
  gitDirty: false,
  label: "prompt-v7",
  pipeline: { adapter: "http", config: { url: "http://x" }, judge: "openai:gpt-6-luna" },
  summary: summarize(attempts),
});

const SECRET_INPUT = "customer 4711 asks about their refund";
const SECRET_OUTPUT = "Refund for order 4711 approved";

function attempts(statuses: Record<string, Array<"passed" | "failed" | "errored">>): AttemptRecord[] {
  return Object.entries(statuses).flatMap(([caseId, list]) =>
    list.map((status, i) =>
      attempt({
        caseId,
        attempt: i + 1,
        caseHash: `hash-${caseId}`,
        input: { question: SECRET_INPUT },
        expected: "the 30-day policy",
        tags: ["policy"],
        output: status === "errored" ? null : SECRET_OUTPUT,
        latencyMs: 100 + i,
        costUsd: 0.001,
        usage: { inputTokens: 10, outputTokens: 5 },
        status,
        error: status === "errored" ? `HTTP 500: ${SECRET_OUTPUT}` : undefined,
        scores:
          status === "errored"
            ? []
            : [
                {
                  scorerName: "llmJudge",
                  pass: status === "passed",
                  value: status === "passed" ? 1 : 0,
                  reasoning: `It says "${SECRET_OUTPUT}"`,
                  costUsd: 0.0002,
                  config: { rubric: "cites the policy?" },
                  metadata: { judge: "openai:gpt-6-luna", temperature: "default" },
                },
              ],
      }),
    ),
  );
}

const baseAttempts = attempts({ a: ["passed", "passed"], b: ["passed", "passed"], c: ["failed", "failed"], d: ["passed", "errored"] });
const headAttempts = attempts({ a: ["passed", "passed"], b: ["failed", "failed"], c: ["passed", "passed"], d: ["passed", "passed"] });
const base = run("base-run", baseAttempts);
const head = run("head-run", headAttempts);

describe("run files", () => {
  it("round-trips a full run exactly", () => {
    const file = buildRunFile(base, baseAttempts, { regradeVersion: "0.4.0" });
    const loaded = parseRunFile(serializeRunFile(file), "base.json");
    expect(loaded.run).toEqual(base);
    expect(loaded.attempts).toEqual(baseAttempts);
    expect(loaded.file).toEqual({ path: "base.json", compact: false });
  });

  it("a compact file contains no inputs, expected answers, outputs, error text, reasoning or scorer config", () => {
    const text = serializeRunFile(buildRunFile(base, baseAttempts, { regradeVersion: "0.4.0", compact: true }));
    expect(text).not.toContain(SECRET_INPUT);
    expect(text).not.toContain(SECRET_OUTPUT);
    expect(text).not.toContain("30-day policy");
    expect(text).not.toContain("cites the policy");
    const json = JSON.parse(text) as { compact: boolean; attempts: Array<Record<string, unknown>> };
    expect(json.compact).toBe(true);
    for (const a of json.attempts) {
      for (const k of ["input", "expected", "output", "error"]) expect(a).not.toHaveProperty(k);
    }
    expect(text.length).toBeLessThan(serializeRunFile(buildRunFile(base, baseAttempts, { regradeVersion: "0.4.0" })).length);
  });

  it("comparing against a compact baseline gives exactly the result of comparing against the full run", () => {
    const compact = parseRunFile(serializeRunFile(buildRunFile(base, baseAttempts, { regradeVersion: "0.4.0", compact: true })), "b.json");
    const viaFile = compareRuns({ base: compact, head: { run: head, attempts: headAttempts } });
    const direct = compareRuns({ base: { run: base, attempts: baseAttempts }, head: { run: head, attempts: headAttempts } });
    expect(viaFile).toEqual(direct);
    expect(direct.counts).toMatchObject({ regressed: 1, improved: 1, errored: 1, unchanged: 1 });
  });

  it("rejects what is not a run file, with an actionable message", () => {
    expect(() => parseRunFile("{nope", "x.json")).toThrow(/"x.json" is not valid JSON/);
    const report = JSON.stringify(buildRunReport(base, baseAttempts));
    expect(() => parseRunFile(report, "r.json")).toThrow(/not a Regrade run file.*--json. report cannot be used/s);
    const file = JSON.parse(serializeRunFile(buildRunFile(base, baseAttempts, { regradeVersion: "0.4.0" })));
    expect(() => parseRunFile(JSON.stringify({ ...file, schemaVersion: 2 }), "new.json")).toThrow(/newer Regrade.*Upgrade/);
    delete file.attempts[1].caseHash;
    expect(() => parseRunFile(JSON.stringify(file), "bad.json")).toThrow(/attempts\.1\.caseHash/);
    expect(() => parseRunFile("{}", "e.json")).toThrow(ConfigError);
  });

  it("accepts fields added by later versions of the same format", () => {
    const file = JSON.parse(serializeRunFile(buildRunFile(base, baseAttempts, { regradeVersion: "0.4.0" })));
    file.somethingNew = 1;
    file.attempts[0].trace = [{ kind: "tool", name: "search" }];
    expect(parseRunFile(JSON.stringify(file), "f.json").attempts).toHaveLength(baseAttempts.length);
  });
});

describe("SqliteStore.importRun", () => {
  it("imports a run with its attempts and summary, and is all-or-nothing", () => {
    const store = new SqliteStore(":memory:");
    try {
      store.importRun(base, baseAttempts, base.summary!);
      expect(store.getRun("base-run")).toEqual(base);
      expect(store.getAttempts("base-run")).toEqual(baseAttempts);

      const duplicate = [...headAttempts, headAttempts[0]!]; // violates UNIQUE (run, case, attempt) at the end
      expect(() => store.importRun(head, duplicate, head.summary!)).toThrow();
      expect(store.getRun("head-run")).toBeUndefined();
      expect(store.listRuns()).toHaveLength(1);
    } finally {
      store.close();
    }
  });
});
