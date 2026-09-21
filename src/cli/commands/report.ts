import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { renderHtmlReport } from "../../report/html/render.js";
import { buildRunReport } from "../../report/model.js";
import { compareRuns } from "../../stats/compare.js";
import { VERSION } from "../version.js";
import { loadRun, openExistingStore } from "./common.js";

export interface ReportOptions {
  db?: string;
  against?: string;
  out?: string;
}

export const DEFAULT_REPORT_PATH = "regrade-report.html";

/** Write a single-file HTML report for a run, optionally compared against a base run. */
export function reportCommand(runRef: string, o: ReportOptions): string {
  const store = openExistingStore(o.db);
  try {
    const head = loadRun(store, runRef);
    const comparison = o.against ? compareRuns({ base: loadRun(store, o.against), head }) : undefined;
    const html = renderHtmlReport({ report: buildRunReport(head.run, head.attempts), comparison, version: VERSION });
    const out = o.out ?? DEFAULT_REPORT_PATH;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html, "utf8");
    const kb = Math.round(statSync(out).size / 1024);
    process.stdout.write(`report → ${out} (${kb} KB, single self-contained file)\n`);
    return out;
  } finally {
    store.close();
  }
}
