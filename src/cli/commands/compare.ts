import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { renderComparison } from "../../report/compareConsole.js";
import { renderCompareMarkdown } from "../../report/markdown.js";
import { compareRuns, regressionGate } from "../../stats/compare.js";
import { VERSION } from "../version.js";
import { loadRun, openExistingStore, pickComparison } from "./common.js";

export interface CompareOptions {
  db?: string;
  suite?: string;
  all?: boolean;
  json?: string;
  md?: string;
  failOnRegression?: boolean;
  significantOnly?: boolean;
  color?: boolean;
}

function write(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

/** Returns the exit code: 0, or 1 if --fail-on-regression and the gate failed. Throws ConfigError for exit 2. */
export function compareCommand(refs: string[], o: CompareOptions): number {
  const store = openExistingStore(o.db);
  try {
    const { base, head } = pickComparison(store, refs, o.suite);
    const cmp = compareRuns({ base: loadRun(store, base.runId), head: loadRun(store, head.runId) });
    const gate = o.failOnRegression || o.significantOnly ? regressionGate(cmp, { significantOnly: o.significantOnly }) : undefined;

    process.stdout.write(renderComparison(cmp, { all: o.all, color: o.color === false ? false : undefined, gate }));
    if (o.json) {
      write(o.json, `${JSON.stringify({ schemaVersion: 1, comparison: cmp, gate: gate ?? null }, null, 2)}\n`);
      process.stdout.write(`  json → ${o.json}\n`);
    }
    if (o.md) {
      write(o.md, renderCompareMarkdown(cmp, gate, VERSION));
      process.stdout.write(`  markdown → ${o.md}\n`);
    }
    return gate?.failed ? 1 : 0;
  } finally {
    store.close();
  }
}
