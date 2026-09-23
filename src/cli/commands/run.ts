import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConfigError, errorMessage } from "../../core/errors.js";
import { readGitInfo } from "../../core/git.js";
import { runSuite } from "../../core/runner.js";
import { loadSuiteFile } from "../../core/loadSuiteFile.js";
import { priceEntriesSchema } from "../../core/testSuite.js";
import type { PriceEntryInput } from "../../core/types.js";
import { createConsoleReporter } from "../../report/console.js";
import { renderRunMarkdown } from "../../report/markdown.js";
import { buildRunReport, writeJsonReport } from "../../report/model.js";
import { buildRunFile, writeRunFile } from "../../store/runFile.js";
import { SqliteStore } from "../../store/sqliteStore.js";
import { VERSION } from "../version.js";

export const DEFAULT_DB_PATH = ".regrade/results.db";

export interface RunCommandOptions {
  db?: string;
  json?: string;
  md?: string;
  /** Also write a portable run file. */
  export?: string;
  /** With --export: keep only what a comparison needs. */
  compact?: boolean;
  minPassRate?: number;
  concurrency?: number;
  repeat?: number;
  timeout?: number;
  tag?: string[];
  case?: string[];
  label?: string;
  judge?: string;
  /** commander's `--no-judge-check` sets this to false. */
  judgeCheck?: boolean;
  /** commander's `--no-trace` sets this to false. */
  trace?: boolean;
  prices?: string;
  /** commander's `--no-color` sets this to false. */
  color?: boolean;
}

function loadPrices(path: string): PriceEntryInput[] {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`Cannot read --prices file "${path}": ${errorMessage(err)}`);
  }
  const list = Array.isArray(raw) ? raw : (raw as { entries?: unknown } | null)?.entries;
  const parsed = priceEntriesSchema.safeParse(list);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new ConfigError(
      `Invalid --prices file "${path}": ${first ? `${first.path.join(".")}: ${first.message}` : "unexpected shape"}. ` +
        "Expected an array (or {entries: [...]}) of {provider, model, inputPerMTok, outputPerMTok, ...}.",
    );
  }
  return parsed.data;
}

/** Returns the process exit code: 0 all passed, 1 failures, 130 interrupted. Throws ConfigError for exit code 2. */
export async function runCommand(suitePath: string, o: RunCommandOptions): Promise<number> {
  const { suite, registry } = await loadSuiteFile(suitePath);
  const prices = o.prices ? loadPrices(o.prices) : undefined;

  const dbPath = o.db ?? DEFAULT_DB_PATH;
  const store = new SqliteStore(dbPath);
  const controller = new AbortController();
  let interrupts = 0;
  const onSignal = () => {
    interrupts++;
    if (interrupts === 1) {
      process.stderr.write("\ninterrupting… saving partial results (press Ctrl+C again to force quit)\n");
      controller.abort();
    } else {
      process.exit(130);
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const reporter = createConsoleReporter({
      version: VERSION,
      color: o.color === false ? false : undefined,
      dbPath,
    });
    const outcome = await runSuite({
      suite,
      registry,
      store,
      reporter,
      regradeVersion: VERSION,
      git: readGitInfo(),
      signal: controller.signal,
      overrides: {
        concurrency: o.concurrency,
        repeat: o.repeat,
        timeoutMs: o.timeout,
        tags: o.tag,
        caseIds: o.case,
        label: o.label,
        judge: o.judge,
        judgeCheck: o.judgeCheck,
        storeTraces: o.trace,
        prices,
        minPassRate: o.minPassRate,
      },
    });
    if (o.minPassRate !== undefined && outcome.exitCode !== 130) {
      const met = outcome.passRate >= o.minPassRate;
      process.stdout.write(
        `  gate: attempt pass rate ${(outcome.passRate * 100).toFixed(1)}% ${met ? "meets" : "is below"} the required ` +
          `${(o.minPassRate * 100).toFixed(1)}% (--min-pass-rate)\n`,
      );
    }
    const report = o.json || o.md ? buildRunReport(outcome.run, outcome.attempts) : undefined;
    if (o.json && report) {
      writeJsonReport(o.json, report);
      process.stdout.write(`  json report → ${o.json}\n`);
    }
    if (o.md && report) {
      mkdirSync(dirname(o.md), { recursive: true });
      writeFileSync(o.md, renderRunMarkdown(report, VERSION), "utf8");
      process.stdout.write(`  markdown report → ${o.md}\n`);
    }
    if (o.export) {
      const run = store.getRun(outcome.run.runId) ?? outcome.run;
      writeRunFile(o.export, buildRunFile(run, outcome.attempts, { regradeVersion: VERSION, compact: o.compact }));
      process.stdout.write(`  run file → ${o.export}${o.compact ? " (compact)" : ""}
`);
    }
    return outcome.exitCode;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    store.close();
  }
}
