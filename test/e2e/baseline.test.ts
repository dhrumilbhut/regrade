import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startMockPipeline, type MockPipeline } from "../fixtures/mock-pipeline.js";

const root = resolve(import.meta.dirname, "..", "..");
const cli = join(root, "dist", "cli.js");

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, NO_COLOR: "1", CI: "1", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

let mock: MockPipeline;
const dirs: string[] = [];
beforeAll(async () => {
  expect(existsSync(cli), "dist/cli.js is missing: run `npm run build`").toBe(true);
  mock = await startMockPipeline();
});
afterAll(async () => {
  await mock.close();
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const workdir = () => {
  const d = mkdtempSync(join(tmpdir(), "regrade-e2e3-"));
  dirs.push(d);
  return d;
};

function writeSuite(dir: string): string {
  const path = join(dir, "suite.json");
  writeFileSync(
    path,
    JSON.stringify({
      name: "baseline-suite",
      pipeline: { adapter: "http", config: { url: "${PIPELINE_URL}", retryBaseDelayMs: 1 } },
      cases: Array.from({ length: 6 }, (_, i) => ({ id: `case-${i + 1}`, input: "What is 2 + 2?", expected: "4", scorers: ["exactMatch"] })),
    }),
  );
  return path;
}

const healthy = () => ({ PIPELINE_URL: mock.url });
const degraded = () => ({ PIPELINE_URL: `${mock.url}?mode=degraded` });
const runId = (out: string): string => /run ([0-9a-f]{8}) saved/.exec(out)?.[1] ?? "";

describe("baselines and run files (built binary)", () => {
  it("committed compact baseline: a fresh checkout with no database compares against it and gates", async () => {
    // on main: run and write the baseline that gets committed
    const main = workdir();
    const made = await runCli(["run", writeSuite(main), "--repeat", "3", "--export", "regrade.baseline.json", "--compact"], main, healthy());
    expect(made.code).toBe(0);
    expect(made.stdout).toContain("run file → regrade.baseline.json (compact)");
    const text = readFileSync(join(main, "regrade.baseline.json"), "utf8");
    expect(text).not.toContain("What is 2 + 2?");
    expect(JSON.parse(text)).toMatchObject({ kind: "regrade.run", compact: true, run: { suiteName: "baseline-suite" } });

    // a PR's CI job: clean checkout (suite + baseline), no .regrade database
    const pr = workdir();
    const suite = writeSuite(pr);
    copyFileSync(join(main, "regrade.baseline.json"), join(pr, "regrade.baseline.json"));

    expect((await runCli(["run", suite, "--repeat", "3"], pr, healthy())).code).toBe(0);
    const ok = await runCli(["compare", "regrade.baseline.json", "--fail-on-regression", "--md", "summary.md"], pr);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("regressed 0");
    expect(readFileSync(join(pr, "summary.md"), "utf8")).toContain("baseline-suite");

    expect((await runCli(["run", suite, "--repeat", "3"], pr, degraded())).code).toBe(1);
    const bad = await runCli(["compare", "regrade.baseline.json", "--fail-on-regression"], pr);
    expect(bad.code).toBe(1);
    expect(bad.stdout).toContain("regressed 6");
    expect(bad.stdout).toContain("Gate failed:");
  });

  it("two run files compare with no database at all; full files import into another database", async () => {
    const a = workdir();
    const suite = writeSuite(a);
    const r1 = await runCli(["run", suite], a, healthy());
    const r2 = await runCli(["run", suite], a, degraded());
    expect((await runCli(["export", runId(r1.stdout), "--out", "base.json"], a)).stdout).toContain("→ base.json");
    const printed = await runCli(["export", runId(r2.stdout)], a);
    expect(JSON.parse(printed.stdout).kind).toBe("regrade.run"); // stdout by default
    writeFileSync(join(a, "head.json"), printed.stdout);

    const elsewhere = workdir();
    for (const f of ["base.json", "head.json"]) copyFileSync(join(a, f), join(elsewhere, f));
    const cmp = await runCli(["compare", "base.json", "head.json", "--fail-on-regression"], elsewhere);
    expect(cmp.code).toBe(1);
    expect(cmp.stdout).toContain("regressed 6");
    expect(existsSync(join(elsewhere, ".regrade"))).toBe(false);

    const report = await runCli(["report", "head.json", "--against", "base.json", "--out", "r.html"], elsewhere);
    expect(report.code).toBe(0);
    expect(readFileSync(join(elsewhere, "r.html"), "utf8")).toContain("I don't know.");

    const imp = await runCli(["import", "head.json"], elsewhere);
    expect(imp.stdout).toContain(`imported run ${runId(r2.stdout)}`);
    expect((await runCli(["import", "head.json"], elsewhere)).stdout).toContain("already in");
    expect((await runCli(["show", runId(r2.stdout), "case-1"], elsewhere)).stdout).toContain("I don't know.");
  });

  it("explains what is wrong with a file that cannot be used (exit 2)", async () => {
    const d = workdir();
    const suite = writeSuite(d);
    const r = await runCli(["run", suite, "--json", "report.json", "--export", "compact.json", "--compact"], d, healthy());
    expect(r.code).toBe(0);

    const report = await runCli(["compare", "report.json"], d);
    expect(report.code).toBe(2);
    expect(report.stderr).toContain("a `--json` report cannot be used as a run");

    const imp = await runCli(["import", "compact.json"], d);
    expect(imp.code).toBe(2);
    expect(imp.stderr).toContain("compact run file");

    const html = await runCli(["report", "compact.json"], d);
    expect(html.code).toBe(2);
    expect(html.stderr).toContain("compact run file");

    const missing = await runCli(["compare", "nope.json", "compact.json"], d);
    expect(missing.code).toBe(2);
    expect(missing.stderr).toContain('Cannot read run file "nope.json"');
  });
});
