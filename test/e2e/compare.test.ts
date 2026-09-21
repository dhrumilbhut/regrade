import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, NO_COLOR: "1", CI: "1", ...env },
    });
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
  const d = mkdtempSync(join(tmpdir(), "regrade-e2e2-"));
  dirs.push(d);
  return d;
};

/** A suite of `n` deterministic cases; `expectedFor(i)` decides which ones will pass against the mock. */
function writeSuite(dir: string, name: string, expectedFor: (i: number) => string, n = 6, extra: Record<string, unknown> = {}): string {
  const path = join(dir, `${name}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      name: "compare-suite",
      pipeline: { adapter: "http", config: { url: "${PIPELINE_URL}", retryBaseDelayMs: 1 } },
      cases: Array.from({ length: n }, (_, i) => ({ id: `case-${i + 1}`, input: "What is 2 + 2?", expected: expectedFor(i), scorers: ["exactMatch"] })),
      ...extra,
    }),
  );
  return path;
}

const env = () => ({ PIPELINE_URL: mock.url });
const runId = (out: string): string => /run ([0-9a-f]{8}) saved/.exec(out)?.[1] ?? "";

describe("regrade runs / show / compare / report (built binary)", () => {
  it("two runs of an unchanged pipeline: compare reports no regressions and the gate passes", async () => {
    const cwd = workdir();
    const suite = writeSuite(cwd, "s", () => "4");
    await runCli(["run", suite, "--label", "before"], cwd, env());
    await runCli(["run", suite, "--label", "after"], cwd, env());

    const r = await runCli(["compare", "--fail-on-regression"], cwd);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("regrade compare · compare-suite");
    expect(r.stdout).toContain("before");
    expect(r.stdout).toContain("after");
    expect(r.stdout).toContain("regressed 0");
    expect(r.stdout).toContain("Gate passed");
    expect(r.stdout).not.toContain(String.fromCharCode(27)); // plain text when piped
  });

  it("cases whose definition changed are reported as modified and never blamed as regressions", async () => {
    const cwd = workdir();
    const good = writeSuite(cwd, "good", () => "4");
    // the "degraded" run expects an answer the mock never gives for cases 1-3, i.e. those cases now fail
    const degraded = writeSuite(cwd, "degraded", (i) => (i < 3 ? "5" : "4"));
    const a = await runCli(["run", good, "--label", "v1", "--repeat", "3"], cwd, env());
    const b = await runCli(["run", degraded, "--label", "v2", "--repeat", "3"], cwd, env());
    expect(a.code).toBe(0);
    expect(b.code).toBe(1);

    const withGate = await runCli(["compare", runId(a.stdout), runId(b.stdout), "--fail-on-regression"], cwd);
    expect(withGate.code).toBe(0); // the gate is about regressions...
    // ...and a changed case definition (a different `expected`) is not comparable: it must NOT be blamed as one
    expect(withGate.stdout).toContain("modified");
    expect(withGate.stdout).toContain("regressed 0 · improved 0");
    expect(withGate.stdout).toContain("modified 3");
    expect(withGate.stdout).toContain("Gate passed");
  });

  it("same suite, worse pipeline: regressions are found with pass counts, the overall drop is significant, and the gate fails", async () => {
    const cwd = workdir();
    const suite = writeSuite(cwd, "s", () => "4"); // identical definition for both runs
    const a = await runCli(["run", suite, "--label", "healthy", "--repeat", "3"], cwd, env());
    const b = await runCli(["run", suite, "--label", "degraded", "--repeat", "3"], cwd, { PIPELINE_URL: `${mock.url}?mode=degraded` });
    expect(a.code).toBe(0);
    expect(b.code).toBe(1);

    const r = await runCli(["compare", "--fail-on-regression"], cwd);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("regressed 6");
    expect(r.stdout).toMatch(/✗ regressed\s+case-1\s+3\/3 → 0\/3\s+100% → 0%\s+p=0\.100/); // 3 attempts per side can never reach p < 0.05 per case
    expect(r.stdout).toContain("significant regression"); // ...but six cases collapsing together is overwhelming
    expect(r.stdout).toContain("Gate failed:");
    expect(r.stdout).toContain("healthy");
    expect(r.stdout).toContain("degraded");

    // the strict gate ignores unconfirmed single-case regressions but still trips on the significant overall drop
    const strict = await runCli(["compare", "--significant-only"], cwd);
    expect(strict.code).toBe(1);
    expect(strict.stdout).toContain("dropped significantly");

    // without a gate flag, compare only reports
    expect((await runCli(["compare"], cwd)).code).toBe(0);
  });

  it("runs lists runs, show summarises one, and show <run> <case> prints the case detail", async () => {
    const cwd = workdir();
    const suite = writeSuite(cwd, "s", (i) => (i === 0 ? "5" : "4"), 3);
    const r = await runCli(["run", suite, "--label", "lbl"], cwd, env());
    const id = runId(r.stdout);
    expect(id).toHaveLength(8);

    const list = await runCli(["runs"], cwd);
    expect(list.code).toBe(0);
    expect(list.stdout).toContain(id);
    expect(list.stdout).toMatch(/compare-suite\s+completed\s+2\/3\s+lbl/);

    const show = await runCli(["show", id], cwd);
    expect(show.stdout).toContain("suite    compare-suite");
    expect(show.stdout).toMatch(/✗ failed\s+case-1/);
    expect(show.stdout).toMatch(/✓ passed\s+case-2/);

    const detail = await runCli(["show", id, "case-1"], cwd);
    expect(detail.stdout).toContain("What is 2 + 2?");
    expect(detail.stdout).toContain('expected "5", got "4"');

    // piped output must be plain text: no ANSI escape sequences in logs or files
    const ESC = String.fromCharCode(27);
    for (const out of [list.stdout, show.stdout, detail.stdout]) expect(out).not.toContain(ESC);
  });

  it("compare --json and --md write files; report writes a single self-contained HTML file", async () => {
    const cwd = workdir();
    const suite = writeSuite(cwd, "s", () => "4");
    const a = await runCli(["run", suite], cwd, env());
    const b = await runCli(["run", suite], cwd, env());

    const c = await runCli(["compare", "--json", "out/c.json", "--md", "out/c.md"], cwd);
    expect(c.code).toBe(0);
    const json = JSON.parse(readFileSync(join(cwd, "out", "c.json"), "utf8"));
    expect(json.schemaVersion).toBe(1);
    expect(json.comparison.counts.unchanged).toBe(6);
    expect(readFileSync(join(cwd, "out", "c.md"), "utf8")).toContain("## Regrade compare · compare-suite");

    const rep = await runCli(["report", runId(b.stdout), "--against", runId(a.stdout), "--out", "out/report.html"], cwd);
    expect(rep.code).toBe(0);
    expect(rep.stdout).toContain("single self-contained file");
    const html = readFileSync(join(cwd, "out", "report.html"), "utf8");
    expect(html).toContain("<title>Regrade · compare-suite</title>");
    expect(html).toContain('"comparison":{');
    expect(html).not.toMatch(/(src|href)=["']https?:/);

    const solo = await runCli(["report", runId(a.stdout)], cwd);
    expect(solo.code).toBe(0);
    expect(existsSync(join(cwd, "regrade-report.html"))).toBe(true);
  });

  it("run --md writes a Markdown summary", async () => {
    const cwd = workdir();
    const suite = writeSuite(cwd, "s", (i) => (i === 0 ? "5" : "4"), 3);
    const r = await runCli(["run", suite, "--md", "out/run.md"], cwd, env());
    expect(r.code).toBe(1);
    const md = readFileSync(join(cwd, "out", "run.md"), "utf8");
    expect(md).toContain("**✗ 1 of 3 cases did not pass**");
    expect(md).toContain("`case-1`");
  });

  describe("--min-pass-rate", () => {
    it("passes (exit 0) when enough attempts pass, even though a case failed", async () => {
      const cwd = workdir();
      const suite = writeSuite(cwd, "s", (i) => (i === 0 ? "5" : "4"), 4); // 3 of 4 pass = 75%
      const strict = await runCli(["run", suite], cwd, env());
      expect(strict.code).toBe(1);
      const relaxed = await runCli(["run", suite, "--min-pass-rate", "0.7"], cwd, env());
      expect(relaxed.code).toBe(0);
      expect(relaxed.stdout).toContain("gate: attempt pass rate 75.0% meets the required 70.0%");
    });

    it("fails (exit 1) below the threshold", async () => {
      const cwd = workdir();
      const suite = writeSuite(cwd, "s", (i) => (i === 0 ? "5" : "4"), 4);
      const r = await runCli(["run", suite, "--min-pass-rate", "0.9"], cwd, env());
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("is below the required 90.0%");
    });

    it("rejects out-of-range values with exit 2", async () => {
      const cwd = workdir();
      const suite = writeSuite(cwd, "s", () => "4", 1);
      expect((await runCli(["run", suite, "--min-pass-rate", "90"], cwd, env())).code).toBe(2);
      expect((await runCli(["run", suite, "--min-pass-rate", "abc"], cwd, env())).code).toBe(2);
    });
  });

  describe("errors exit 2 with a helpful message", () => {
    it("no database yet", async () => {
      const cwd = workdir();
      for (const args of [["runs"], ["compare"], ["show", "abc"], ["report", "abc"]]) {
        const r = await runCli(args, cwd);
        expect(r.code, args.join(" ")).toBe(2);
        expect(r.stderr).toContain("No results database");
      }
      expect(existsSync(join(cwd, ".regrade"))).toBe(false); // reading never creates an empty database
    });

    it("unknown run, and nothing earlier to compare with", async () => {
      const cwd = workdir();
      const suite = writeSuite(cwd, "s", () => "4", 1);
      const a = await runCli(["run", suite], cwd, env());
      const unknown = await runCli(["show", "ffffffff"], cwd);
      expect(unknown.code).toBe(2);
      expect(unknown.stderr).toContain('No run matching "ffffffff"');
      const lonely = await runCli(["compare"], cwd);
      expect(lonely.code).toBe(2);
      expect(lonely.stderr).toContain("no earlier run");
      const badCase = await runCli(["show", runId(a.stdout), "nope"], cwd);
      expect(badCase.code).toBe(2);
      expect(badCase.stderr).toContain('has no case "nope"');
    });
  });
});
