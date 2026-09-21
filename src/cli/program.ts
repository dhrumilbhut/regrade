import { Command, CommanderError, InvalidArgumentError } from "commander";
import pc from "picocolors";
import { ConfigError, errorMessage } from "../core/errors.js";
import { compareCommand } from "./commands/compare.js";
import { initCommand } from "./commands/init.js";
import { reportCommand } from "./commands/report.js";
import { runsCommand } from "./commands/runs.js";
import { showCommand } from "./commands/show.js";
import { runCommand } from "./commands/run.js";
import { schemaCommand } from "./commands/schema.js";
import { VERSION } from "./version.js";

function intOption(name: string, min: number, max = Number.MAX_SAFE_INTEGER) {
  return (value: string): number => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < min || n > max) {
      throw new InvalidArgumentError(`${name} must be an integer between ${min} and ${max}`);
    }
    return n;
  };
}

const collect = (value: string, previous: string[] = []): string[] => [...previous, value];

function rateOption(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 1) {
    throw new InvalidArgumentError("--min-pass-rate must be a number between 0 and 1 (e.g. 0.9 for 90%)");
  }
  return n;
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("regrade")
    .description("Regression tests for AI agents and RAG pipelines. Git diff for AI behavior.")
    .version(VERSION, "-v, --version")
    .exitOverride();

  program
    .command("run")
    .description("Run a test suite against your pipeline, score the outputs, and save the run")
    .argument("<suite>", "path to a suite file (.json, or a code suite: .ts .mts .js .mjs)")
    .option("--db <path>", "SQLite database to save results to", ".regrade/results.db")
    .option("--json <file>", "also write a JSON report to this file")
    .option("--md <file>", "also write a Markdown summary (e.g. for a CI job summary)")
    .option("--min-pass-rate <rate>", "pass if at least this fraction of attempts pass (0-1), instead of requiring every case", rateOption)
    .option("--concurrency <n>", "max attempts in flight (default 4)", intOption("--concurrency", 1, 32))
    .option("--repeat <n>", "attempts per case (overrides the suite)", intOption("--repeat", 1, 50))
    .option("--timeout <ms>", "per-attempt timeout in ms (default 30000)", intOption("--timeout", 1))
    .option("--tag <tag>", "only run cases with this tag (repeatable)", collect)
    .option("--case <id>", "only run this case id (repeatable)", collect)
    .option("--label <text>", "label this run, e.g. a prompt version")
    .option("--judge <provider:model>", "LLM judge model, e.g. anthropic:claude-sonnet-5")
    .option("--prices <file>", "JSON file with extra/override model prices")
    .option("--no-color", "disable coloured output")
    .addHelpText(
      "after",
      `
Exit codes:
  0    every case passed (or --min-pass-rate was met)
  1    at least one case failed, was flaky, or errored
  2    usage or configuration error (nothing was run)
  130  interrupted (partial results are saved)`,
    )
    .action(async (suite: string, opts) => {
      process.exitCode = await runCommand(suite, opts);
    });

  program
    .command("runs")
    .description("List saved runs, newest first")
    .option("--db <path>", "results database", ".regrade/results.db")
    .option("--suite <name>", "only runs of this suite")
    .option("--limit <n>", "how many runs to show (default 20)", intOption("--limit", 1, 1000))
    .option("--no-color", "disable coloured output")
    .action((opts) => runsCommand(opts));

  program
    .command("show")
    .description("Show a run's summary, or one case's input, outputs, and scores")
    .argument("<run>", "run id or a unique prefix of it")
    .argument("[case]", "a case id")
    .option("--db <path>", "results database", ".regrade/results.db")
    .option("--full", "do not truncate long inputs and outputs")
    .option("--no-color", "disable coloured output")
    .action((run: string, caseId: string | undefined, opts) => showCommand(run, caseId, opts));

  program
    .command("compare")
    .description("Compare two runs: what regressed, what improved, and whether it is real or noise")
    .argument("[runs...]", "base and head run ids; with one, compares it with the run before it; with none, the latest two")
    .option("--db <path>", "results database", ".regrade/results.db")
    .option("--suite <name>", "with no run ids: which suite's latest runs to compare")
    .option("--all", "also list unchanged cases")
    .option("--json <file>", "write the full comparison as JSON")
    .option("--md <file>", "write a Markdown summary (e.g. for a CI job summary or PR comment)")
    .option("--fail-on-regression", "exit 1 if any case regressed, errored in the head run, or the overall pass rate dropped significantly")
    .option("--significant-only", "like --fail-on-regression, but ignore regressions that are not statistically significant")
    .option("--no-color", "disable coloured output")
    .addHelpText(
      "after",
      `
A regression is a case whose pass rate went down. It is "significant" when Fisher's exact test gives
p < 0.05, which needs several attempts per case (--repeat): with 3 attempts per side even 3/3 -> 0/3
is p = 0.1. Single-attempt changes are still reported, flagged as unconfirmed. Cases whose definition
changed (or that only exist in one run, or errored) are listed but never counted as regressions.`,
    )
    .action((runs: string[], opts) => {
      process.exitCode = compareCommand(runs, opts);
    });

  program
    .command("report")
    .description("Write a single-file, self-contained HTML report for a run")
    .argument("<run>", "run id or a unique prefix of it (the head run when using --against)")
    .option("--against <run>", "base run: adds a comparison against it")
    .option("--out <file>", "output file", "regrade-report.html")
    .option("--db <path>", "results database", ".regrade/results.db")
    .action((run: string, opts) => {
      reportCommand(run, opts);
    });

  program
    .command("init")
    .description("Scaffold an example suite (and a mock pipeline, or with --ts a code-first suite)")
    .option("--dir <dir>", "directory to create", "regrade")
    .option("--force", "overwrite existing files")
    .option("--ts", "scaffold a code-first TypeScript suite instead (no mock server needed)")
    .action((opts: { dir: string; force?: boolean; ts?: boolean }) => {
      initCommand(opts);
    });

  program
    .command("schema")
    .description("Print the suite JSON Schema (for editor autocomplete via \"$schema\")")
    .option("--out <file>", "write to a file instead of stdout")
    .action((opts: { out?: string }) => {
      schemaCommand(opts);
    });

  return program;
}

/**
 * Code suites run user code, which can leave handles open (an interval, a socket) and keep the process
 * alive after the work is done. Give stdout a moment to flush, then exit with the right code.
 */
const EXIT_GRACE_MS = 2000;

export async function main(argv: string[] = process.argv): Promise<void> {
  const program = buildProgram();
  try {
    await runProgram(program, argv);
  } finally {
    setTimeout(() => process.exit(process.exitCode ?? 0), EXIT_GRACE_MS).unref();
  }
}

async function runProgram(program: Command, argv: string[]): Promise<void> {
  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof CommanderError) {
      // help/version exit 0; usage errors are already printed by commander.
      process.exitCode = err.exitCode === 0 ? 0 : 2;
      return;
    }
    if (err instanceof ConfigError) {
      process.stderr.write(`${pc.red("error:")} ${err.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(
      `${pc.red("internal error:")} ${process.env.DEBUG && err instanceof Error ? (err.stack ?? err.message) : errorMessage(err)}\n` +
        "Re-run with DEBUG=1 for a stack trace, and please report it.\n",
    );
    process.exitCode = 2;
  }
}

