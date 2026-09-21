import type { RunRecord } from "../../core/types.js";
import { fmtDate } from "../../report/format.js";
import { colorFor, openExistingStore } from "./common.js";

export interface RunsOptions {
  db?: string;
  suite?: string;
  limit?: number;
  color?: boolean;
}

export function renderRuns(runs: RunRecord[], color?: boolean): string {
  const c = colorFor(color);
  if (runs.length === 0) return "No runs found.\n";
  const rows = runs.map((r) => {
    const s = r.summary;
    return {
      id: r.runId.slice(0, 8),
      started: fmtDate(r.startedAt),
      suite: r.suiteName,
      status: r.status,
      cases: s ? `${s.cases.passed}/${s.cases.total}` : "–",
      flaky: s && s.cases.flaky > 0 ? `${s.cases.flaky} flaky` : "",
      label: r.label ?? "",
      git: r.gitSha ? `${r.gitSha.slice(0, 7)}${r.gitDirty ? "*" : ""}` : "",
    };
  });
  const w = (k: keyof (typeof rows)[number], min: number) => Math.max(min, ...rows.map((r) => r[k].length));
  const wSuite = Math.min(28, w("suite", 5));
  const header = `${"RUN".padEnd(8)}  ${"STARTED".padEnd(16)}  ${"SUITE".padEnd(wSuite)}  ${"STATUS".padEnd(11)}  ${"PASSED".padEnd(7)}  LABEL / GIT`;
  const lines = [c.dim(header)];
  for (const r of rows) {
    const status = r.status === "completed" ? r.status : c.yellow(r.status);
    const pad = " ".repeat(Math.max(0, 11 - r.status.length));
    const extra = [r.flaky, r.label, r.git].filter(Boolean).join("  ");
    lines.push(`${r.id.padEnd(8)}  ${r.started.padEnd(16)}  ${r.suite.slice(0, wSuite).padEnd(wSuite)}  ${status}${pad}  ${r.cases.padEnd(7)}  ${extra}`.trimEnd());
  }
  return `${lines.join("\n")}\n`;
}

export function runsCommand(o: RunsOptions): void {
  const store = openExistingStore(o.db);
  try {
    process.stdout.write(renderRuns(store.listRuns({ suiteName: o.suite, limit: o.limit ?? 20 }), o.color === false ? false : undefined));
  } finally {
    store.close();
  }
}
