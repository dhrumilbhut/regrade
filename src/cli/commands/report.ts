import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConfigError } from "../../core/errors.js";
import { renderHtmlReport } from "../../report/html/render.js";
import { buildRunReport } from "../../report/model.js";
import { compareRuns } from "../../stats/compare.js";
import { VERSION } from "../version.js";
import { RunSource } from "./common.js";

export interface ReportOptions {
  db?: string;
  against?: string;
  out?: string;
}

export const DEFAULT_REPORT_PATH = "regrade-report.html";

/** Write a single-file HTML report for a run, optionally compared against a base run. */
export function reportCommand(runRef: string, o: ReportOptions): string {
  const source = new RunSource(o.db);
  try {
    const head = source.load(runRef);
    if (head.file?.compact) {
      throw new ConfigError(`${runRef} is a compact run file (no inputs or outputs); a report needs a full run. Use it with --against.`);
    }
    const comparison = o.against ? compareRuns({ base: source.load(o.against), head }) : undefined;
    const html = renderHtmlReport({ report: buildRunReport(head.run, head.attempts), comparison, version: VERSION });
    const out = o.out ?? DEFAULT_REPORT_PATH;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, html, "utf8");
    const kb = Math.round(statSync(out).size / 1024);
    process.stdout.write(`report → ${out} (${kb} KB, single self-contained file)\n`);
    return out;
  } finally {
    source.close();
  }
}
