import type { AttemptRecord, TraceStep } from "../../core/types.js";
import type { Comparison } from "../../stats/compare.js";
import { wilsonInterval } from "../../stats/wilson.js";
import { scoreNote } from "../format.js";
import type { RunReport } from "../model.js";
import { CSS, EARLY_THEME_JS, JS } from "./assets.js";

export interface HtmlReportOptions {
  report: RunReport;
  comparison?: Comparison;
  version: string;
  generatedAt?: string;
  /** Long inputs/outputs are cut to keep the file small; the full data stays in the database/JSON. Default 20000. */
  maxTextChars?: number;
}

const escapeHtml = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Serialise for embedding in a <script type="application/json"> block. `<`, `>` and `&`
 * are escaped so no pipeline output can close the script element or open a tag, and the
 * JS line separators that are legal in JSON but historically not in JS are escaped too.
 */
export function safeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}\n… [truncated ${s.length - max} characters; see the JSON report or database for the full text]` : s;
}

const asText = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

/** Per-step text in the report is short: the full step data stays in the database, run files and JSON report. */
const TRACE_TEXT_CHARS = 2_000;
const STEP_KINDS = new Set(["llm", "tool", "retrieval", "agent", "other"]);

interface ReportStep {
  kind: string;
  name: string;
  start: number | null;
  duration: number | null;
  error: string | null;
  input: string | null;
  output: string | null;
  children: ReportStep[];
}

function reportTrace(steps: readonly TraceStep[]): ReportStep[] {
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return steps.map((s) => ({
    kind: STEP_KINDS.has(s.kind) ? s.kind : "other",
    name: String(s.name),
    start: n(s.startOffsetMs),
    duration: n(s.durationMs),
    error: typeof s.attributes?.error === "string" ? clip(s.attributes.error, TRACE_TEXT_CHARS) : null,
    input: s.input === undefined ? null : clip(asText(s.input), TRACE_TEXT_CHARS),
    output: s.output === undefined ? null : clip(asText(s.output), TRACE_TEXT_CHARS),
    children: reportTrace(s.children ?? []),
  }));
}

/** One self-contained HTML file: no network access, no external assets. Opens from file://. */
export function renderHtmlReport(opts: HtmlReportOptions): string {
  const max = opts.maxTextChars ?? 20_000;
  const { report } = opts;
  const c = (s: string) => clip(s, max);

  const attemptsTotal = report.summary.attempts;
  const scored = attemptsTotal.passed + attemptsTotal.failed; // errored attempts have no verdict
  const data = {
    version: opts.version,
    generatedAt: opts.generatedAt ?? new Date().toISOString(),
    run: report.run,
    summary: report.summary,
    attemptRate: scored > 0 ? wilsonInterval(attemptsTotal.passed, scored) : null,
    cases: report.cases.map((k) => ({
      caseId: k.caseId,
      verdict: k.verdict,
      tags: k.tags ?? [],
      inputText: c(asText(k.input)),
      expected: k.expected === undefined ? null : c(k.expected),
      attempts: k.attempts.map((a) => ({
        attempt: a.attempt,
        status: a.status as AttemptRecord["status"],
        latencyMs: a.latencyMs,
        costUsd: a.costUsd,
        output: a.output === null ? null : c(a.output),
        error: a.error ? c(a.error) : null,
        scores: a.scores.map((s) => ({
          scorerName: s.scorerName,
          pass: s.pass,
          value: s.value,
          reasoning: s.reasoning ? clip(s.reasoning, 4000) : null,
          error: s.error ? clip(s.error, 4000) : null,
          costUsd: s.costUsd ?? null,
          note: scoreNote(s) || null,
        })),
        trace: a.trace && a.trace.length > 0 ? reportTrace(a.trace) : null,
      })),
    })),
    comparison: opts.comparison ?? null,
  };

  const s = report.summary.cases;
  const title = `Regrade · ${report.run.suiteName}`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:">
<title>${escapeHtml(title)}</title>
<script>${EARLY_THEME_JS}</script>
<style>${CSS}</style>
</head>
<body>
<div id="app">
<div class="wrap">
<h1>${escapeHtml(report.run.suiteName)}</h1>
<p class="meta">Regrade report · ${s.passed} of ${s.total} cases passed · ${s.failed} failed · ${s.flaky} flaky · ${s.errored} errored</p>
<noscript><p class="meta">This report needs JavaScript to show case details. The complete data is embedded in this file.</p></noscript>
</div>
</div>
<script type="application/json" id="regrade-data">${safeJson(data)}</script>
<script>${JS}</script>
</body>
</html>
`;
}
