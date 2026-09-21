import pc from "picocolors";
import type { AttemptRecord, RunSummary } from "../core/types.js";
import type { RunReporter } from "./types.js";

export interface ConsoleReporterOptions {
  version: string;
  /** Where to write. Default: process.stdout. */
  out?: { write(chunk: string): unknown };
  /** Force colour on/off. Default: on only for a TTY without NO_COLOR. */
  color?: boolean;
  /** Shown in the final "saved" line. */
  dbPath?: string;
  /** Use plain ASCII symbols. Default: REGRADE_ASCII=1. */
  ascii?: boolean;
}

export function formatUsd(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.0001) return "<$0.0001";
  return `$${n.toFixed(4)}`;
}

export function formatMs(ms: number): string {
  return `${Math.round(ms).toLocaleString("en-US")} ms`;
}

function clip(s: string, max: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function formatCost(summary: RunSummary): string {
  const { pipeline, judge, unknownAttempts } = summary.costUsd;
  const total = summary.attempts.total;
  let p: string;
  if (total > 0 && unknownAttempts === total) p = "unknown";
  else if (unknownAttempts > 0) p = `${formatUsd(pipeline)} (+${unknownAttempts} attempt${unknownAttempts > 1 ? "s" : ""} unknown)`;
  else p = formatUsd(pipeline);
  return judge > 0 ? `pipeline ${p} · judge ${formatUsd(judge)}` : `pipeline ${p}`;
}

/**
 * Append-only console output: one line per attempt as it completes, then a
 * summary. No cursor control, so it reads the same in a terminal and in CI logs.
 */
export function createConsoleReporter(opts: ConsoleReporterOptions): RunReporter {
  const out = opts.out ?? process.stdout;
  const color = opts.color ?? (Boolean(process.stdout.isTTY) && !process.env.NO_COLOR);
  const c = pc.createColors(color);
  const ascii = opts.ascii ?? Boolean(process.env.REGRADE_ASCII);
  const sym = ascii
    ? { ok: "PASS", bad: "FAIL", err: "ERR ", dot: "-", arrow: "->", flaky: "~" }
    : { ok: "✓", bad: "✗", err: "!", dot: "·", arrow: "→", flaky: "~" };
  const line = (s = "") => out.write(`${s}\n`);

  let started = false;
  const pending: string[] = [];
  let width = 12;

  const printWarning = (m: string) => line(`  ${c.yellow("warning:")} ${m}`);

  return {
    onWarning(message) {
      if (started) printWarning(message);
      else pending.push(message);
    },

    onRunStart(info) {
      started = true;
      width = Math.min(40, Math.max(12, ...info.caseIds.map((id) => id.length + (info.repeat > 1 ? 6 : 0))));
      const parts = [c.bold(`regrade ${opts.version}`), info.suiteName, info.pipelineLabel];
      if (info.judge) parts.push(`judge ${info.judge}`);
      line(parts.join(` ${sym.dot} `));
      line(
        c.dim(
          `  ${info.caseCount} case${info.caseCount === 1 ? "" : "s"}` +
            (info.repeat > 1 ? ` × up to ${info.repeat} attempts` : "") +
            ` ${sym.dot} concurrency ${info.concurrency}`,
        ),
      );
      for (const m of pending.splice(0)) printWarning(m);
      line();
    },

    onAttempt(a: AttemptRecord, info) {
      const label = info.repeat > 1 ? `${a.caseId} #${a.attempt}/${info.repeat}` : a.caseId;
      const mark =
        a.status === "passed" ? c.green(sym.ok) : a.status === "failed" ? c.red(sym.bad) : c.yellow(sym.err);
      const latency = a.latencyMs === null ? "" : formatMs(a.latencyMs);
      let detail: string;
      if (a.scores.length === 0) {
        detail = c.yellow(`error: ${clip(a.error ?? "unknown error", 110)}`);
      } else {
        detail = a.scores
          .map((s) => {
            if (s.error) return `${s.scorerName} ${c.yellow(sym.err)} ${c.dim(`(${clip(s.error, 90)})`)}`;
            if (s.pass) return `${s.scorerName} ${c.green(sym.ok)}`;
            return `${s.scorerName} ${c.red(sym.bad)}${s.reasoning ? ` ${c.dim(`(${clip(s.reasoning, 90)})`)}` : ""}`;
          })
          .join("  ");
      }
      line(`  ${mark} ${label.padEnd(width)} ${latency.padStart(9)}  ${detail}`);
    },

    onRunEnd({ run, cases }) {
      const s = run.summary;
      line();
      if (s) {
        line(
          `  cases ${s.cases.total} ${sym.dot} passed ${s.cases.passed} ${sym.dot} failed ${s.cases.failed} ` +
            `${sym.dot} flaky ${s.cases.flaky} ${sym.dot} errored ${s.cases.errored}`,
        );
        if (s.attempts.total !== s.cases.total) {
          line(
            `  attempts ${s.attempts.total} ${sym.dot} passed ${s.attempts.passed} ${sym.dot} failed ${s.attempts.failed} ` +
              `${sym.dot} errored ${s.attempts.errored}`,
          );
        }
        if (s.latency) line(`  latency avg ${formatMs(s.latency.avgMs)} ${sym.dot} p95 ${formatMs(s.latency.p95Ms)}`);
        line(`  cost ${formatCost(s)}`);
      }
      const notable = cases.filter((k) => k.verdict === "flaky" || k.verdict === "errored").slice(0, 10);
      if (notable.length > 0) {
        line();
        for (const k of notable) {
          const passed = k.attempts.filter((a) => a.status === "passed").length;
          if (k.verdict === "flaky") {
            line(`  ${c.yellow(sym.flaky)} flaky: ${k.caseId} (${passed}/${k.attempts.length} attempts passed)`);
          } else {
            line(`  ${c.yellow(sym.err)} errored: ${k.caseId}`);
          }
        }
      }
      line();
      if (run.status === "interrupted") {
        line(`  ${c.yellow("interrupted")} ${sym.dot} partial results saved`);
      } else if (s) {
        const ok = s.cases.passed === s.cases.total;
        line(
          ok
            ? `  ${c.green(c.bold(`All ${s.cases.total} case${s.cases.total === 1 ? "" : "s"} passed.`))}`
            : `  ${c.red(c.bold(`${s.cases.total - s.cases.passed} of ${s.cases.total} cases did not pass.`))}`,
        );
      }
      line(
        c.dim(`  run ${run.runId.slice(0, 8)} saved${opts.dbPath ? ` ${sym.arrow} ${opts.dbPath}` : ""}`),
      );
    },
  };
}
