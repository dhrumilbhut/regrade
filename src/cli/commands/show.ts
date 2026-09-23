import { ConfigError } from "../../core/errors.js";
import type { AttemptRecord, RunRecord } from "../../core/types.js";
import { groupCases } from "../../core/verdict.js";
import { formatCost, formatMs } from "../../report/console.js";
import { fmtDate, scoreNote } from "../../report/format.js";
import { colorFor, loadRun, openExistingStore } from "./common.js";

export interface ShowOptions {
  db?: string;
  full?: boolean;
  color?: boolean;
}

const MAX_TEXT = 4000;

function block(text: string, full: boolean, indent = "      "): string {
  const t = !full && text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n… [${text.length - MAX_TEXT} more characters; use --full]` : text;
  return t
    .split("\n")
    .map((l) => `${indent}${l}`)
    .join("\n");
}

const inputText = (i: AttemptRecord["input"]): string => (typeof i === "string" ? i : JSON.stringify(i, null, 2));

export function renderRunSummary(run: RunRecord, attempts: AttemptRecord[], color?: boolean): string {
  const c = colorFor(color);
  const cases = groupCases(attempts);
  const out: string[] = [];
  out.push(`${c.bold("run")} ${run.runId}  ${c.dim(`(${run.status})`)}`);
  out.push(`  suite    ${run.suiteName}`);
  out.push(`  started  ${fmtDate(run.startedAt)}${run.finishedAt ? `  →  ${fmtDate(run.finishedAt)}` : ""}`);
  if (run.label) out.push(`  label    ${run.label}`);
  if (run.gitSha) out.push(`  git      ${run.gitSha.slice(0, 12)}${run.gitDirty ? " (uncommitted changes)" : ""}`);
  out.push(`  regrade  ${run.regradeVersion}`);
  const s = run.summary;
  if (s) {
    out.push(`  cases    passed ${s.cases.passed} · failed ${s.cases.failed} · flaky ${s.cases.flaky} · errored ${s.cases.errored}`);
    if (s.latency) out.push(`  latency  avg ${formatMs(s.latency.avgMs)} · p95 ${formatMs(s.latency.p95Ms)}`);
    out.push(`  cost     ${formatCost(s)}`);
  }
  out.push("");
  for (const k of cases) {
    const passed = k.attempts.filter((a) => a.status === "passed").length;
    const mark = k.verdict === "passed" ? c.green("✓") : k.verdict === "failed" ? c.red("✗") : c.yellow(k.verdict === "flaky" ? "~" : "!");
    out.push(`  ${mark} ${k.verdict.padEnd(8)} ${k.caseId.padEnd(32)} ${passed}/${k.attempts.length} passed`);
  }
  out.push("");
  out.push(c.dim("  regrade show <run> <case>   for a case's input, outputs, and scores"));
  return `${out.join("\n")}\n`;
}

export function renderCaseDetail(run: RunRecord, attempts: AttemptRecord[], caseId: string, full = false, color?: boolean): string {
  const c = colorFor(color);
  const mine = attempts.filter((a) => a.caseId === caseId).sort((a, b) => a.attempt - b.attempt);
  if (mine.length === 0) {
    const ids = [...new Set(attempts.map((a) => a.caseId))];
    throw new ConfigError(`Run ${run.runId.slice(0, 8)} has no case "${caseId}". Cases: ${ids.slice(0, 20).join(", ")}${ids.length > 20 ? ", …" : ""}`);
  }
  const first = mine[0] as AttemptRecord;
  const out: string[] = [];
  out.push(`${c.bold(caseId)}  ${c.dim(`run ${run.runId.slice(0, 8)} · ${run.suiteName}`)}`);
  if (first.tags?.length) out.push(`  tags     ${first.tags.join(", ")}`);
  out.push("  input");
  out.push(block(inputText(first.input), full));
  if (first.expected !== undefined) {
    out.push("  expected");
    out.push(block(first.expected, full));
  }
  for (const a of mine) {
    const mark = a.status === "passed" ? c.green("✓ passed") : a.status === "failed" ? c.red("✗ failed") : c.yellow("! errored");
    const bits = [a.latencyMs === null ? "" : formatMs(a.latencyMs), a.costUsd === null ? "cost unknown" : `$${a.costUsd.toFixed(6)}`].filter(Boolean);
    out.push("");
    out.push(`  attempt ${a.attempt}  ${mark}  ${c.dim(bits.join(" · "))}`);
    if (a.error) out.push(`    ${c.yellow("error:")} ${a.error}`);
    if (a.output !== null) {
      out.push("    output");
      out.push(block(a.output, full, "      "));
    }
    for (const s of a.scores) {
      const m = s.error ? c.yellow("!") : s.pass ? c.green("✓") : c.red("✗");
      const detail = s.error ? `error: ${s.error}` : (s.reasoning ?? "");
      out.push(`    ${m} ${s.scorerName}${s.value !== null ? c.dim(` (${s.value})`) : ""}${detail ? `  ${detail}` : ""}`);
      const note = scoreNote(s);
      if (note) out.push(`      ${c.dim(note)}`);
    }
  }
  return `${out.join("\n")}\n`;
}

export function showCommand(runRef: string, caseId: string | undefined, o: ShowOptions): void {
  const store = openExistingStore(o.db);
  try {
    const { run, attempts } = loadRun(store, runRef);
    const color = o.color === false ? false : undefined; // commander defaults a negatable --no-color option to true
    process.stdout.write(caseId ? renderCaseDetail(run, attempts, caseId, o.full, color) : renderRunSummary(run, attempts, color));
  } finally {
    store.close();
  }
}
