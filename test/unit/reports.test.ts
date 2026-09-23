import { describe, expect, it } from "vitest";
import type { AttemptRecord, RunRecord } from "../../src/core/types.js";
import { summarize } from "../../src/core/verdict.js";
import { CSS, JS } from "../../src/report/html/assets.js";
import { renderHtmlReport, safeJson } from "../../src/report/html/render.js";
import { renderComparison } from "../../src/report/compareConsole.js";
import { cell, renderCompareMarkdown, renderRunMarkdown } from "../../src/report/markdown.js";
import { buildRunReport } from "../../src/report/model.js";
import { renderRuns } from "../../src/cli/commands/runs.js";
import { renderCaseDetail, renderRunSummary } from "../../src/cli/commands/show.js";
import { compareRuns, regressionGate } from "../../src/stats/compare.js";
import { attempt } from "../helpers.js";

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

const run = (runId: string, attempts: AttemptRecord[], over: Partial<RunRecord> = {}): RunRecord => ({
  runId,
  suiteName: "support-bot",
  suiteHash: "sh",
  startedAt: "2026-09-21T10:00:00.000Z",
  finishedAt: "2026-09-21T10:00:05.000Z",
  status: "completed",
  regradeVersion: "0.2.0",
  gitSha: "abcdef1234567890",
  gitDirty: true,
  label: "prompt-v7",
  pipeline: {},
  summary: summarize(attempts),
  ...over,
});

const mk = (caseId: string, statuses: Array<"passed" | "failed" | "errored">, extra: Partial<AttemptRecord> = {}): AttemptRecord[] =>
  statuses.map((status, i) =>
    attempt({
      caseId,
      attempt: i + 1,
      status,
      output: status === "errored" ? null : `answer ${i + 1}`,
      latencyMs: status === "errored" ? null : 100 + i,
      error: status === "errored" ? "HTTP 500 from http://x/p: boom" : undefined,
      scores:
        status === "errored"
          ? []
          : [{ scorerName: "exactMatch", pass: status === "passed", value: status === "passed" ? 1 : 0, reasoning: status === "passed" ? undefined : "expected A, got B" }],
      ...extra,
    }),
  );

const baseAttempts = [...mk("steady", ["passed", "passed"]), ...mk("regresses", ["passed", "passed"]), ...mk("gets-fixed", ["failed", "failed"]), ...mk("broken|case", ["passed"])];
const headAttempts = [...mk("steady", ["passed", "passed"]), ...mk("regresses", ["failed", "failed"]), ...mk("gets-fixed", ["passed", "passed"]), ...mk("broken|case", ["errored"])];
const baseRun = run("aaaaaaaa-1111", baseAttempts, { label: "prompt-v6", startedAt: "2026-09-20T10:00:00.000Z" });
const headRun = run("bbbbbbbb-2222", headAttempts);
const cmp = compareRuns({ base: { run: baseRun, attempts: baseAttempts }, head: { run: headRun, attempts: headAttempts } });

describe("comparison console output", () => {
  const text = renderComparison(cmp, { color: false, gate: regressionGate(cmp) });

  it("shows both runs with label and git sha, the regressed case first, and the counts", () => {
    expect(text).toContain("regrade compare · support-bot");
    expect(text).toMatch(/base\s+aaaaaaaa .*prompt-v6/);
    expect(text).toMatch(/head\s+bbbbbbbb .*prompt-v7\s+abcdef1\*/);
    const lines = text.split("\n");
    expect(lines.findIndex((l) => l.includes("regressed regresses"))).toBeLessThan(lines.findIndex((l) => l.includes("improved  gets-fixed")));
    expect(text).toContain("2/2 → 0/2");
    expect(text).toContain("cases  regressed 1 · improved 1");
  });

  it("explains significance honestly and lists non-comparable cases", () => {
    expect(text).toContain("p=0.333"); // 2/2 vs 0/2 can never be significant
    expect(text).toContain("not statistically significant at this sample size");
    expect(text).toMatch(/errored\s+broken\|case/);
    expect(text).toContain("errored in head");
  });

  it("hides unchanged cases unless asked, and prints the gate result", () => {
    expect(text).toContain("1 unchanged case hidden");
    expect(text).not.toMatch(/unchanged\s+steady/);
    expect(renderComparison(cmp, { color: false, all: true })).toMatch(/unchanged\s+steady/);
    expect(text).toContain("Gate failed:");
    expect(renderComparison(compareRuns({ base: { run: baseRun, attempts: baseAttempts }, head: { run: baseRun, attempts: baseAttempts } }), { color: false, gate: { failed: false, reasons: [] } })).toContain("Gate passed");
  });

  it("supports ASCII symbols", () => {
    const t = renderComparison(cmp, { color: false, ascii: true });
    expect(t).toContain("FAIL");
    expect(t).not.toContain("✗");
  });
});

describe("Markdown reporters", () => {
  it("run summary: headline, table of cases needing attention, passing cases folded", () => {
    const md = renderRunMarkdown(buildRunReport(headRun, headAttempts), "0.2.0");
    expect(md).toContain("## Regrade · support-bot");
    expect(md).toContain("**✗ 2 of 4 cases did not pass**");
    expect(md).toContain("| ✗ failed | `regresses` | 0/2 | exactMatch: expected A, got B |");
    expect(md).toContain("| ! errored | `broken\\|case` | 0/1 | error: HTTP 500 from http://x/p: boom |"); // pipes escaped
    expect(md).toContain("<summary>2 passing cases</summary>");
    expect(md).toContain("Generated by Regrade 0.2.0");
  });

  it("run summary: all-passing headline", () => {
    const attempts = mk("a", ["passed"]);
    expect(renderRunMarkdown(buildRunReport(run("r", attempts), attempts))).toContain("**✓ All 1 case passed**");
  });

  it("compare summary: gate line, facts, changed-case table with p-values", () => {
    const md = renderCompareMarkdown(cmp, regressionGate(cmp), "0.2.0");
    expect(md).toContain("**✗ Regression gate failed:**");
    expect(md).toContain("- base: aaaaaaaa");
    expect(md).toContain("| ✗ | `regresses` | 2/2 (100%) | 0/2 (0%) | regressed p=0.333 |");
    expect(md).toContain("| ✓ | `gets-fixed` |");
    expect(md).toContain("1 unchanged case not listed.");
    expect(renderCompareMarkdown(compareRuns({ base: { run: baseRun, attempts: baseAttempts }, head: { run: baseRun, attempts: baseAttempts } }), { failed: false, reasons: [] })).toContain("**✓ No regressions**");
  });

  it("escapes markup and pipes in table cells", () => {
    expect(cell("a | b <script>x</script>\nnext")).toBe("a \\| b &lt;script>x&lt;/script> next");
    expect(cell("x".repeat(500), 20)).toHaveLength(20);
  });
});

describe("HTML report", () => {
  const report = buildRunReport(headRun, headAttempts);
  const html = renderHtmlReport({ report, comparison: cmp, version: "0.2.0", generatedAt: "2026-09-21T12:00:00.000Z" });

  function embedded(doc: string): { cases: Array<{ caseId: string; attempts: Array<{ output: string | null }> }>; comparison: unknown; version: string } {
    const m = /<script type="application\/json" id="regrade-data">([\s\S]*?)<\/script>/.exec(doc);
    if (!m?.[1]) throw new Error("no embedded data block");
    return JSON.parse(m[1]);
  }

  it("is a single self-contained document that loads nothing from the network", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/\b(src|href)\s*=\s*["']?(https?:)?\/\//i); // no external scripts, styles, images, links
    expect(html).not.toMatch(/@import|url\(\s*["']?https?:/i);
    expect(html).not.toContain("innerHTML");
    expect(JS).not.toContain("innerHTML");
    expect(JS).not.toContain("document.write");
    expect(JS).not.toContain("eval(");
  });

  it("embeds the run, the cases and the comparison as JSON", () => {
    const data = embedded(html);
    expect(data.version).toBe("0.2.0");
    expect(data.cases.map((c) => c.caseId)).toEqual(["steady", "regresses", "gets-fixed", "broken|case"]);
    expect((data.comparison as { counts: { regressed: number } }).counts.regressed).toBe(1);
    expect(renderHtmlReport({ report, version: "1" })).toContain('"comparison":null');
  });

  it("has a title, a no-JavaScript fallback, and both themes", () => {
    expect(html).toContain("<title>Regrade · support-bot</title>");
    expect(html).toContain("<noscript>");
    expect(html).toContain("1 of 4 cases passed".replace("1 of 4", "2 of 4"));
    expect(CSS).toContain('prefers-color-scheme: dark');
    expect(CSS).toContain(':root[data-theme="dark"]');
    expect(CSS).toContain(':root:not([data-theme="light"])');
  });

  it("the client script is syntactically valid JavaScript", () => {
    expect(() => new Function(JS)).not.toThrow();
  });

  it("cannot be broken out of by hostile pipeline output (script close tags, comments, tags, separators)", () => {
    const hostile = '</script><img src=x onerror="alert(1)"><!-- ' + LS + ' ' + PS + ' </SCRIPT><script>alert(2)</script>';
    const attempts = mk("evil", ["passed"], { output: hostile, input: hostile, expected: hostile, tags: [hostile] });
    attempts[0]!.scores = [{ scorerName: hostile, pass: true, value: 1, reasoning: hostile }];
    const doc = renderHtmlReport({ report: buildRunReport(run("r", attempts), attempts), version: "1" });

    // Only our own two <script> blocks and the JSON data block exist: no injected markup survives.
    expect(doc.match(/<script/gi)).toHaveLength(3);
    expect(doc.match(/<\/script>/gi)).toHaveLength(3);
    expect(doc).not.toContain("<img");
    expect(doc).not.toContain("<!-- ");
    expect(doc).not.toMatch(new RegExp("[" + LS + PS + "]"));
    // ...and the data still round-trips exactly, so the viewer shows what the pipeline really said.
    expect(embedded(doc).cases[0]?.attempts[0]?.output).toBe(hostile);
  });

  it("safeJson escapes <, >, & and the JS line separators, and round-trips", () => {
    const v = { s: "</script> & <b> " + LS + " " + PS + "", n: [1, null, true] };
    const out = safeJson(v);
    expect(out).not.toMatch(new RegExp("[<>&" + LS + PS + "]"));
    expect(JSON.parse(out)).toEqual(v);
  });

  it("truncates huge outputs to keep the file small, and says so", () => {
    const big = "x".repeat(50_000);
    const attempts = mk("big", ["passed"], { output: big });
    const doc = renderHtmlReport({ report: buildRunReport(run("r", attempts), attempts), version: "1", maxTextChars: 1000 });
    const out = embedded(doc).cases[0]?.attempts[0]?.output ?? "";
    expect(out.length).toBeLessThan(1300);
    expect(out).toContain("truncated 49000 characters");
    expect(doc.length).toBeLessThan(60_000);
  });

  it("escapes the suite name in the static title and fallback", () => {
    const attempts = mk("a", ["passed"]);
    const doc = renderHtmlReport({ report: buildRunReport(run("r", attempts, { suiteName: "<b>x</b> & y" }), attempts), version: "1" });
    expect(doc).toContain("<title>Regrade · &lt;b&gt;x&lt;/b&gt; &amp; y</title>");
    expect(doc).not.toContain("<b>x</b>");
  });
});

describe("runs and show output", () => {
  it("lists runs newest first with cases passed, label and git", () => {
    const text = renderRuns([headRun, baseRun], false);
    expect(text).toContain("RUN");
    expect(text).toMatch(/bbbbbbbb .*support-bot\s+completed\s+2\/4\s+prompt-v7\s+abcdef1\*/);
    expect(text).toMatch(/aaaaaaaa .*support-bot\s+completed\s+3\/4/);
    expect(renderRuns([], false)).toBe("No runs found.\n");
  });

  it("shows a run summary with every case", () => {
    const text = renderRunSummary(headRun, headAttempts, false);
    expect(text).toContain(`run ${headRun.runId}`);
    expect(text).toContain("git      abcdef123456 (uncommitted changes)");
    expect(text).toMatch(/✗ failed\s+regresses\s+0\/2 passed/);
    expect(text).toMatch(/! errored\s+broken\|case/);
  });

  it("shows one case in detail: input, expected, each attempt's output, scores and errors", () => {
    const attempts = mk("regresses", ["failed", "passed"], { expected: "A", input: { q: "why?" }, tags: ["policy"] });
    const text = renderCaseDetail(run("r-1", attempts), attempts, "regresses", false, false);
    expect(text).toContain("tags     policy");
    expect(text).toContain('"q": "why?"');
    expect(text).toContain("expected");
    expect(text).toContain("attempt 1  ✗ failed");
    expect(text).toContain("✗ exactMatch (0)  expected A, got B");
    expect(text).toContain("attempt 2  ✓ passed");
    const err = mk("down", ["errored"]);
    expect(renderCaseDetail(run("r-2", err), err, "down", false, false)).toContain("error: HTTP 500");
  });

  it("shows which judge scored a verdict, and flags a default temperature", () => {
    const judged = mk("j", ["passed", "passed"]).map((a, i) => ({
      ...a,
      scores: [{ scorerName: "llmJudge", pass: true, value: 1, reasoning: "ok", metadata: { judge: "openai:gpt-6-luna", temperature: i === 0 ? 0 : "default" } }],
    }));
    const text = renderCaseDetail(run("r-3", judged), judged, "j", false, false);
    expect(text).toContain("judge openai:gpt-6-luna\n");
    expect(text).toContain("judge openai:gpt-6-luna · default temperature");
    const html = renderHtmlReport({ report: buildRunReport(run("r-3", judged), judged), version: "1" });
    expect(html).toContain('"note":"judge openai:gpt-6-luna · default temperature"');
    expect(JS).toContain("s.note");
  });

  it("truncates very long text unless --full, and names the available cases when the id is wrong", () => {
    const attempts = mk("long", ["passed"], { output: "y".repeat(9000) });
    expect(renderCaseDetail(run("r", attempts), attempts, "long", false, false)).toContain("use --full");
    expect(renderCaseDetail(run("r", attempts), attempts, "long", true, false)).not.toContain("use --full");
    expect(() => renderCaseDetail(run("r", attempts), attempts, "nope", false, false)).toThrow(/has no case "nope"\. Cases: long/);
  });
});
