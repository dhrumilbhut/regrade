import pc from "picocolors";
import type { CaseComparison, Comparison, GateResult, OverallVerdict } from "../stats/compare.js";
import { formatCost, formatMs } from "./console.js";
import { CHANGE_LABEL, countsLine, pct, pctWithInterval, points, runLine } from "./format.js";

export interface CompareRenderOptions {
  color?: boolean;
  ascii?: boolean;
  /** Also list unchanged cases. */
  all?: boolean;
  gate?: GateResult;
}

const VERDICT_TEXT: Record<OverallVerdict, string> = {
  "significant-regression": "significant regression",
  "significant-improvement": "significant improvement",
  "not-significant": "not significant",
  "no-comparable-cases": "no comparable cases",
};

function outcome(c: CaseComparison): string {
  const b = c.base ? `${c.base.passed}/${c.base.attempts}` : "–";
  const h = c.head ? `${c.head.passed}/${c.head.attempts}` : "–";
  return `${b} → ${h}`;
}

export function renderComparison(cmp: Comparison, opts: CompareRenderOptions = {}): string {
  const color = opts.color ?? (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);
  const c = pc.createColors(color);
  const ascii = opts.ascii ?? Boolean(process.env.REGRADE_ASCII);
  const sym = ascii
    ? { regressed: "FAIL", improved: "PASS", flaky: "~", errored: "ERR ", other: "-", arrow: "->", dash: "-" }
    : { regressed: "✗", improved: "✓", flaky: "~", errored: "!", other: "·", arrow: "→", dash: "–" };
  const out: string[] = [];
  const line = (s = "") => out.push(s);

  const icon = (change: CaseComparison["change"]): string => {
    switch (change) {
      case "regressed":
        return c.red(sym.regressed);
      case "improved":
        return c.green(sym.improved);
      case "flaky":
        return c.yellow(sym.flaky);
      case "errored":
        return c.yellow(sym.errored);
      default:
        return c.dim(sym.other);
    }
  };

  line(`${c.bold("regrade compare")} ${sym.other} ${cmp.head.suiteName}`);
  line(`  base  ${runLine(cmp.base)}`);
  line(`  head  ${runLine(cmp.head)}`);
  for (const w of cmp.warnings) line(`  ${c.yellow("warning:")} ${w}`);
  line();

  const shown = cmp.cases.filter((k) => opts.all || k.change !== "unchanged");
  const idW = Math.min(36, Math.max(10, ...shown.map((k) => k.caseId.length)));
  const label = (k: CaseComparison) => CHANGE_LABEL[k.change].padEnd(9);
  for (const k of shown) {
    let detail = "";
    if (k.base && k.head) {
      detail = `${outcome(k).padEnd(11)} ${pct(k.base.rate)} ${sym.arrow} ${pct(k.head.rate)}`;
      if (k.change === "regressed" || k.change === "improved") {
        detail += `  ${c.dim(`p=${(k.pValue ?? 1).toFixed(3)}${k.significant ? " significant" : ""}`)}`;
      }
    } else if (k.head) detail = `${c.dim("only in head:")} ${k.head.passed}/${k.head.attempts} passed`;
    else if (k.base) detail = `${c.dim("only in base:")} ${k.base.passed}/${k.base.attempts} passed`;
    if (k.change === "errored") detail = c.dim(`errored in ${k.erroredIn}`);
    if (k.change === "modified") detail = c.dim("definition changed, not compared");
    const id = k.caseId.length > idW ? `${k.caseId.slice(0, idW - 1)}…` : k.caseId;
    line(`  ${icon(k.change)} ${label(k)} ${id.padEnd(idW)} ${detail}`);
    if (k.note && (k.change === "regressed" || k.change === "improved")) line(`      ${c.dim(k.note)}`);
  }
  const hidden = cmp.counts.unchanged - shown.filter((k) => k.change === "unchanged").length;
  if (hidden > 0) line(c.dim(`  ${hidden} unchanged case${hidden === 1 ? "" : "s"} hidden (use --all to list them)`));
  if (shown.length === 0 && hidden === 0) line(c.dim("  no cases to compare"));

  line();
  line(`  cases  ${countsLine(cmp.counts)}`);
  const o = cmp.overall;
  if (o.base && o.head) {
    line(
      `  attempt pass rate  ${pctWithInterval(o.base)} ${sym.arrow} ${pctWithInterval(o.head)}  ` +
        c.dim(`(${o.comparableCases} comparable case${o.comparableCases === 1 ? "" : "s"}; descriptive)`),
    );
  }
  if (o.meanDelta !== null) {
    const ci = o.ci ? `, 95% CI [${points(o.ci.lo)}, ${points(o.ci.hi)}]` : "";
    const p = o.pValue === null ? "" : `, p=${o.pValue < 0.0001 ? "<0.0001" : o.pValue.toFixed(4)}`;
    line(`  overall change     mean per case ${points(o.meanDelta)}${ci}${p} ${sym.arrow} ${c.bold(VERDICT_TEXT[o.verdict])}`);
    line(c.dim("                     (case-stratified permutation test; interval from a within-case bootstrap)"));
  } else line(`  overall            ${VERDICT_TEXT[o.verdict]}`);

  const bl = cmp.metrics.base.latency;
  const hl = cmp.metrics.head.latency;
  if (bl && hl) {
    line(`  latency  avg ${formatMs(bl.avgMs)} ${sym.arrow} ${formatMs(hl.avgMs)} ${sym.other} p95 ${formatMs(bl.p95Ms)} ${sym.arrow} ${formatMs(hl.p95Ms)}`);
  }
  const costKnown = (s: Comparison["metrics"]["base"]) => s.costUsd.unknownAttempts < s.attempts.total || s.costUsd.judge > 0;
  if (costKnown(cmp.metrics.base) || costKnown(cmp.metrics.head)) {
    line(`  cost     ${formatCost(cmp.metrics.base)} ${sym.arrow} ${formatCost(cmp.metrics.head)}`);
  }

  if (opts.gate) {
    line();
    if (opts.gate.failed) {
      line(`  ${c.red(c.bold("Gate failed:"))} ${opts.gate.reasons.join("; ")}`);
    } else {
      line(`  ${c.green(c.bold("Gate passed:"))} no regressions.`);
    }
  }
  return `${out.join("\n")}\n`;
}
