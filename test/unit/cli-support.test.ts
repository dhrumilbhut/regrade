import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildSuiteJsonSchema } from "../../src/cli/commands/schema.js";
import { initCommand } from "../../src/cli/commands/init.js";
import { INIT_SUITE, MOCK_PIPELINE } from "../../src/cli/templates.js";
import { checkSuite, parseSuiteText } from "../../src/core/testSuite.js";
import type { RunRecord } from "../../src/core/types.js";
import { groupCases, summarize } from "../../src/core/verdict.js";
import { createConsoleReporter, formatCost, formatMs, formatUsd } from "../../src/report/console.js";
import { buildRunReport } from "../../src/report/model.js";
import { attempt, registry } from "../helpers.js";

const root = resolve(import.meta.dirname, "..", "..");
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "regrade-cli-"));
  dirs.push(d);
  return d;
};

function capture() {
  let text = "";
  return { out: { write: (s: string) => (text += s) }, text: () => text };
}

function runRecord(over: Partial<RunRecord> = {}): RunRecord {
  return {
    runId: "3f9c1a2e-0000-0000-0000-000000000000",
    suiteName: "s",
    suiteHash: "h",
    startedAt: "2026-09-21T00:00:00.000Z",
    finishedAt: "2026-09-21T00:00:01.000Z",
    status: "completed",
    regradeVersion: "0.1.0",
    gitSha: null,
    gitDirty: null,
    label: null,
    pipeline: {},
    summary: null,
    ...over,
  };
}

describe("console reporter", () => {
  const info = { runId: "r", suiteName: "demo", pipelineLabel: "http → localhost:4000/pipeline", judge: "anthropic:claude-sonnet-5", caseIds: ["capital", "latency"], caseCount: 2, attemptCount: 2, repeat: 1, concurrency: 4 };

  it("prints a header, one line per attempt, and a summary (no ANSI when colour is off)", () => {
    const cap = capture();
    const rep = createConsoleReporter({ version: "9.9.9", out: cap.out, color: false, dbPath: ".regrade/results.db" });
    const passed = attempt({ caseId: "capital", latencyMs: 412, scores: [{ scorerName: "exactMatch", pass: true, value: 1 }, { scorerName: "llmJudge", pass: true, value: 1 }] });
    const failed = attempt({
      caseId: "latency",
      latencyMs: 3204,
      status: "failed",
      scores: [{ scorerName: "latencyCost", pass: false, value: 3204, reasoning: "latency 3204 ms exceeds maxLatencyMs 3000 by 204 ms" }],
    });
    rep.onRunStart!(info);
    rep.onAttempt!(passed, { totalAttempts: 2, repeat: 1 });
    rep.onAttempt!(failed, { totalAttempts: 2, repeat: 1 });
    const all = [passed, failed];
    rep.onRunEnd!({ run: runRecord({ summary: summarize(all) }), cases: groupCases(all) });

    const text = cap.text();
    // eslint-disable-next-line no-control-regex
    expect(text).not.toMatch(/\u001b\[/);
    expect(text).toContain("regrade 9.9.9 · demo · http → localhost:4000/pipeline · judge anthropic:claude-sonnet-5");
    expect(text).toMatch(/✓ capital\s+412 ms\s+exactMatch ✓\s+llmJudge ✓/);
    expect(text).toMatch(/✗ latency\s+3,204 ms\s+latencyCost ✗ \(latency 3204 ms exceeds maxLatencyMs 3000 by 204 ms\)/);
    expect(text).toContain("cases 2 · passed 1 · failed 1 · flaky 0 · errored 0");
    expect(text).toContain("latency avg 1,808 ms · p95 3,204 ms");
    expect(text).toContain("1 of 2 cases did not pass.");
    expect(text).toContain("run 3f9c1a2e saved → .regrade/results.db");
  });

  it("shows errors, flaky cases and attempt numbers when repeating", () => {
    const cap = capture();
    const rep = createConsoleReporter({ version: "1", out: cap.out, color: false });
    const runs = [
      attempt({ caseId: "capital", attempt: 1 }),
      attempt({ caseId: "capital", attempt: 2, status: "failed", scores: [{ scorerName: "exactMatch", pass: false, value: 0 }] }),
      attempt({ caseId: "down", status: "errored", output: null, latencyMs: null, scores: [], error: "HTTP 500 from http://x/p: boom" }),
    ];
    rep.onRunStart!({ ...info, repeat: 2, caseIds: ["capital", "down"] });
    for (const a of runs) rep.onAttempt!(a, { totalAttempts: 3, repeat: 2 });
    rep.onRunEnd!({ run: runRecord({ summary: summarize(runs) }), cases: groupCases(runs) });
    const text = cap.text();
    expect(text).toContain("capital #1/2");
    expect(text).toContain("capital #2/2");
    expect(text).toContain("error: HTTP 500 from http://x/p: boom");
    expect(text).toContain("flaky: capital (1/2 attempts passed)");
    expect(text).toContain("errored: down");
    expect(text).toContain("attempts 3 · passed 1 · failed 1 · errored 1");
  });

  it("prints warnings after the header even if they were raised during preflight", () => {
    const cap = capture();
    const rep = createConsoleReporter({ version: "1", out: cap.out, color: false });
    rep.onWarning!("early");
    rep.onRunStart!(info);
    rep.onWarning!("late");
    const text = cap.text();
    expect(text.indexOf("regrade 1")).toBeLessThan(text.indexOf("warning: early"));
    expect(text).toContain("warning: late");
  });

  it("supports ASCII symbols and reports interrupted runs", () => {
    const cap = capture();
    const rep = createConsoleReporter({ version: "1", out: cap.out, color: false, ascii: true });
    const a = attempt();
    rep.onRunStart!(info);
    rep.onAttempt!(a, { totalAttempts: 1, repeat: 1 });
    rep.onRunEnd!({ run: runRecord({ status: "interrupted", summary: summarize([a]) }), cases: groupCases([a]) });
    expect(cap.text()).toContain("PASS c1");
    expect(cap.text()).toContain("interrupted");
    expect(cap.text()).not.toContain("✓");
  });

  it("emits colour codes when colour is forced on", () => {
    const cap = capture();
    const rep = createConsoleReporter({ version: "1", out: cap.out, color: true });
    rep.onRunStart!(info);
    rep.onAttempt!(attempt(), { totalAttempts: 1, repeat: 1 });
    // eslint-disable-next-line no-control-regex
    expect(cap.text()).toMatch(/\u001b\[/);
  });

  it("formats money, time and cost honestly", () => {
    expect(formatUsd(0)).toBe("$0");
    expect(formatUsd(0.00001)).toBe("<$0.0001");
    expect(formatUsd(0.0031)).toBe("$0.0031");
    expect(formatMs(1234.6)).toBe("1,235 ms");
    const all = [attempt({ costUsd: null }), attempt({ caseId: "d", costUsd: null })];
    expect(formatCost(summarize(all))).toBe("pipeline unknown");
    const mixed = [attempt({ costUsd: 0.01 }), attempt({ caseId: "d", costUsd: null, scores: [{ scorerName: "llmJudge", pass: true, value: 1, costUsd: 0.002 }] })];
    expect(formatCost(summarize(mixed))).toBe("pipeline $0.0100 (+1 attempt unknown) · judge $0.0020");
  });
});

describe("JSON report model", () => {
  it("is versioned and carries verdicts, attempts and scores", () => {
    const attempts = [attempt({ caseId: "a" }), attempt({ caseId: "b", status: "failed", scores: [{ scorerName: "x", pass: false, value: 0 }] })];
    const report = buildRunReport(runRecord({ summary: null }), attempts);
    expect(report.schemaVersion).toBe(1);
    expect(report.cases.map((c) => [c.caseId, c.verdict])).toEqual([["a", "passed"], ["b", "failed"]]);
    expect(report.summary.cases.total).toBe(2);
    expect(report.cases[1]?.attempts[0]?.scores[0]?.scorerName).toBe("x");
    expect(report).not.toHaveProperty("run.summary");
  });
});

describe("init", () => {
  it("scaffolds a suite and mock pipeline, and git-ignores the results directory", () => {
    const cwd = tmp();
    const lines: string[] = [];
    const r = initCommand({ dir: "regrade", cwd, log: (l) => lines.push(l) });
    expect(r.written).toEqual(["regrade/suite.json", "regrade/mock-pipeline.mjs", ".gitignore (added .regrade/)"]);
    expect(readFileSync(join(cwd, "regrade", "suite.json"), "utf8")).toBe(INIT_SUITE);
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe(".regrade/\n");
    expect(lines.join("\n")).toContain("regrade run regrade/suite.json");
  });

  it("does not overwrite existing files without --force, and does not duplicate the gitignore entry", () => {
    const cwd = tmp();
    initCommand({ dir: "regrade", cwd, log: () => {} });
    writeFileSync(join(cwd, "regrade", "suite.json"), "mine");
    const again = initCommand({ dir: "regrade", cwd, log: () => {} });
    expect(again.skipped).toContain("regrade/suite.json");
    expect(readFileSync(join(cwd, "regrade", "suite.json"), "utf8")).toBe("mine");
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe(".regrade/\n");
    initCommand({ dir: "regrade", cwd, force: true, log: () => {} });
    expect(readFileSync(join(cwd, "regrade", "suite.json"), "utf8")).toBe(INIT_SUITE);
  });

  it("appends to an existing .gitignore that lacks a trailing newline", () => {
    const cwd = tmp();
    writeFileSync(join(cwd, ".gitignore"), "node_modules");
    initCommand({ dir: "regrade", cwd, log: () => {} });
    expect(readFileSync(join(cwd, ".gitignore"), "utf8")).toBe("node_modules\n.regrade/\n");
  });

  it("scaffolded suite is valid", () => {
    checkSuite(parseSuiteText(INIT_SUITE, "init"), registry());
  });

  it("examples/qa-http stays identical to the init templates and is valid", () => {
    expect(readFileSync(join(root, "examples", "qa-http", "mock-pipeline.mjs"), "utf8")).toBe(MOCK_PIPELINE);
    const suite = parseSuiteText(readFileSync(join(root, "examples", "qa-http", "suite.json"), "utf8"), "example");
    checkSuite(suite, registry());
    expect(suite.cases.map((c) => c.id)).toEqual(["capital-of-france", "latency-check"]);
  });
});

describe("suite JSON Schema", () => {
  it("describes the suite and is strict about unknown keys", () => {
    const schema = buildSuiteJsonSchema() as { title: string; type: string; required: string[]; additionalProperties: boolean; properties: Record<string, unknown> };
    expect(schema.title).toBe("Regrade test suite");
    expect(schema.type).toBe("object");
    expect(schema.required).toEqual(expect.arrayContaining(["name", "pipeline", "cases"]));
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(["$schema", "defaults", "pricing", "cases"]));
  });

  it("the committed schema/suite.schema.json matches what the code generates (run `npm run build`)", () => {
    const committed = JSON.parse(readFileSync(join(root, "schema", "suite.schema.json"), "utf8")) as unknown;
    expect(committed).toEqual(buildSuiteJsonSchema());
  });
});
