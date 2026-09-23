import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startMockPipeline, type MockPipeline } from "../fixtures/mock-pipeline.js";
import { startStubJudge, type StubLlm } from "../fixtures/stub-llm.js";

const root = resolve(import.meta.dirname, "..", "..");
const cli = join(root, "dist", "cli.js");

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], opts: { cwd: string; env?: Record<string, string> }): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1", CI: "1", ...opts.env };
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "REGRADE_JUDGE", "ANTHROPIC_BASE_URL", "OPENAI_BASE_URL"]) {
      if (!(opts.env && k in opts.env)) delete env[k];
    }
    const child = spawn(process.execPath, [cli, ...args], { cwd: opts.cwd, env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

let mock: MockPipeline;
let stub: StubLlm | undefined;
const dirs: string[] = [];

beforeAll(async () => {
  expect(existsSync(cli), "dist/cli.js is missing: run `npm run build`").toBe(true);
  mock = await startMockPipeline();
});
afterAll(async () => {
  await mock.close();
});
afterEach(async () => {
  await stub?.close();
  stub = undefined;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function workdir(): string {
  const d = mkdtempSync(join(tmpdir(), "regrade-e2e-"));
  dirs.push(d);
  return d;
}

function writeSuite(dir: string, cases: unknown[], extra: Record<string, unknown> = {}, name = "suite.json"): string {
  const path = join(dir, name);
  writeFileSync(
    path,
    JSON.stringify({ name: "e2e-suite", pipeline: { adapter: "http", config: { url: "${PIPELINE_URL}", retryBaseDelayMs: 1 } }, cases, ...extra }, null, 2),
  );
  return path;
}

const env = () => ({ PIPELINE_URL: mock.url });

describe("regrade CLI (built binary)", () => {
  it("prints its version and help, exiting 0", async () => {
    const cwd = workdir();
    const v = await runCli(["--version"], { cwd });
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toBe(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version);
    const h = await runCli(["run", "--help"], { cwd });
    expect(h.code).toBe(0);
    expect(h.stdout).toContain("Exit codes:");
    expect(h.stdout).toContain("--repeat");
  });

  it("runs a passing suite: live output, exit 0, rows in SQLite, JSON report", async () => {
    const cwd = workdir();
    const suite = writeSuite(cwd, [
      { id: "capital", input: "What is the capital of France?", expected: "Paris", scorers: ["exactMatch", "latencyCost"], scorerConfig: { latencyCost: { maxLatencyMs: 5000 } } },
      { id: "math", input: "What is 2 + 2?", expected: "4", scorers: ["exactMatch"] },
    ]);
    const r = await runCli(["run", suite, "--json", "out/report.json"], { cwd, env: env() });

    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/✓ capital\s+\d[\d,]* ms\s+exactMatch ✓\s+latencyCost ✓/);
    expect(r.stdout).toContain("All 2 cases passed.");
    expect(r.stdout).toContain("saved → .regrade/results.db");

    const db = new Database(join(cwd, ".regrade", "results.db"), { readonly: true });
    expect(db.prepare("SELECT status FROM runs").pluck().all()).toEqual(["completed"]);
    expect(db.prepare("SELECT count(*) FROM results WHERE status = 'passed'").pluck().get()).toBe(2);
    expect(db.prepare("SELECT count(*) FROM scores").pluck().get()).toBe(3);
    db.close();

    const report = JSON.parse(readFileSync(join(cwd, "out", "report.json"), "utf8"));
    expect(report.schemaVersion).toBe(1);
    expect(report.summary.cases.passed).toBe(2);
  });

  it("exits 1 when a case fails, and shows why", async () => {
    const cwd = workdir();
    const suite = writeSuite(cwd, [{ id: "wrong", input: "What is 2 + 2?", expected: "5", scorers: ["exactMatch"] }]);
    const r = await runCli(["run", suite], { cwd, env: env() });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('expected "5", got "4"');
    expect(r.stdout).toContain("1 of 1 cases did not pass.");
  });

  it("exits 1 for a broken pipeline and reports the case as errored", async () => {
    const cwd = workdir();
    const suite = writeSuite(cwd, [{ id: "down", input: "FAIL:500", expected: "x", scorers: ["exactMatch"] }], {
      pipeline: { adapter: "http", config: { url: "${PIPELINE_URL}", retries: 0 } },
    });
    const r = await runCli(["run", suite], { cwd, env: env() });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("error: HTTP 500");
    expect(r.stdout).toContain("errored 1");
  });

  it("--repeat exposes a flaky case and exits 1", async () => {
    const cwd = workdir();
    const suite = writeSuite(cwd, [{ id: "flaky", input: "FLAKY", expected: "Paris", scorers: ["exactMatch"] }]);
    const r = await runCli(["run", suite, "--repeat", "4", "--concurrency", "1"], { cwd, env: env() });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("flaky #1/4");
    expect(r.stdout).toContain("flaky: flaky (2/4 attempts passed)");
    const db = new Database(join(cwd, ".regrade", "results.db"), { readonly: true });
    expect(db.prepare("SELECT count(*) FROM results").pluck().get()).toBe(4);
    db.close();
  });

  it("honours --db, --tag, --case and --label", async () => {
    const cwd = workdir();
    const suite = writeSuite(cwd, [
      { id: "a", input: "What is 2 + 2?", expected: "4", scorers: ["exactMatch"], tags: ["math"] },
      { id: "b", input: "What is the capital of France?", expected: "Paris", scorers: ["exactMatch"], tags: ["geo"] },
    ]);
    const r = await runCli(["run", suite, "--db", "custom/my.db", "--tag", "math", "--label", "prompt-v7"], { cwd, env: env() });
    expect(r.code).toBe(0);
    const db = new Database(join(cwd, "custom", "my.db"), { readonly: true });
    expect(db.prepare("SELECT case_id FROM results").pluck().all()).toEqual(["a"]);
    expect(db.prepare("SELECT label FROM runs").pluck().get()).toBe("prompt-v7");
    db.close();
    const c = await runCli(["run", suite, "--db", "custom/my.db", "--case", "b"], { cwd, env: env() });
    expect(c.stdout).toContain("1 case");
  });

  it("a judge that does not work stops the run with exit 2 before any case runs; --no-judge-check skips the check", async () => {
    stub = await startStubJudge("http400");
    const cwd = workdir();
    const env = { PIPELINE_URL: mock.url, ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: stub.anthropicBaseUrl };
    const suite = join(root, "examples", "qa-http", "suite.json");
    const r = await runCli(["run", suite], { cwd, env });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("judge anthropic:claude-sonnet-5 does not work");
    expect(r.stderr).toContain("--no-judge-check");
    const db = new Database(join(cwd, ".regrade", "results.db"), { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM runs").get()).toEqual({ n: 0 });
    db.close();
    const skipped = await runCli(["run", suite, "--no-judge-check"], { cwd, env });
    expect(skipped.code).toBe(1); // ran; the judged attempts errored
    expect(skipped.stdout).toContain("errored");
  });

  it("runs the shipped example suite end to end with a judge (stubbed provider)", async () => {
    stub = await startStubJudge();
    const cwd = workdir();
    const r = await runCli(["run", join(root, "examples", "qa-http", "suite.json"), "--json", "r.json"], {
      cwd,
      env: { PIPELINE_URL: mock.url, ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: stub.anthropicBaseUrl },
    });
    expect(r.stdout).toContain("judge anthropic:claude-sonnet-5");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("All 2 cases passed.");
    expect(stub.requests).toHaveLength(3); // the judge check, then one verdict per case
    const report = JSON.parse(readFileSync(join(cwd, "r.json"), "utf8"));
    const judgeScores = report.cases.flatMap((c: { attempts: Array<{ scores: Array<{ scorerName: string; reasoning?: string; costUsd: number }> }> }) =>
      c.attempts.flatMap((a) => a.scores.filter((s) => s.scorerName === "llmJudge")),
    );
    expect(judgeScores).toHaveLength(2);
    expect(judgeScores.every((s: { reasoning?: string; costUsd: number }) => s.reasoning && s.costUsd > 0)).toBe(true);
  });

  it("fails a case the judge rejects", async () => {
    stub = await startStubJudge("normal", () => "fail");
    const cwd = workdir();
    const suite = writeSuite(cwd, [{ id: "j", input: "What is 2 + 2?", scorers: ["llmJudge"] }], { defaults: { judge: "anthropic:claude-sonnet-5" } });
    const r = await runCli(["run", suite], { cwd, env: { ...env(), ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: stub.anthropicBaseUrl } });
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("llmJudge ✗");
    expect(r.stdout).toContain("Does not address the input.");
  });

  describe("exit code 2: usage and configuration errors, before anything runs", () => {
    it("invalid JSON", async () => {
      const cwd = workdir();
      writeFileSync(join(cwd, "bad.json"), "{ nope");
      const r = await runCli(["run", "bad.json"], { cwd, env: env() });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Invalid JSON in bad.json");
    });

    it("schema violations name the path", async () => {
      const cwd = workdir();
      const suite = writeSuite(cwd, [{ id: "a", input: "hi", scorers: ["exactMatch"] }]); // missing expected
      const r = await runCli(["run", suite], { cwd, env: env() });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('scorer "exactMatch" requires an "expected" value');
      expect(mock.requests.filter((q) => q.input === "hi")).toHaveLength(0);
    });

    it("missing file", async () => {
      const r = await runCli(["run", "nope.json"], { cwd: workdir(), env: env() });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Cannot read suite file");
    });

    it("missing env var: nothing is run, no database is created", async () => {
      const cwd = workdir();
      const before = mock.requests.length;
      const suite = writeSuite(cwd, [{ id: "a", input: "What is 2 + 2?", expected: "4", scorers: ["exactMatch"] }]);
      const r = await runCli(["run", suite], { cwd, env: {} });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("PIPELINE_URL");
      expect(mock.requests.length).toBe(before);
    });

    it("llmJudge without a judge or key", async () => {
      const cwd = workdir();
      const suite = writeSuite(cwd, [{ id: "a", input: "hi", scorers: ["llmJudge"] }]);
      const r = await runCli(["run", suite], { cwd, env: env() });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("no judge model is configured");
    });

    it("bad flag values and unknown options", async () => {
      const cwd = workdir();
      const suite = writeSuite(cwd, [{ id: "a", input: "hi", scorers: ["latencyCost"] }]);
      expect((await runCli(["run", suite, "--repeat", "0"], { cwd, env: env() })).code).toBe(2);
      expect((await runCli(["run", suite, "--concurrency", "abc"], { cwd, env: env() })).code).toBe(2);
      const unknown = await runCli(["run", suite, "--bogus"], { cwd, env: env() });
      expect(unknown.code).toBe(2);
      expect(unknown.stderr).toContain("unknown option");
    });

    it("a --case that does not exist", async () => {
      const cwd = workdir();
      const suite = writeSuite(cwd, [{ id: "a", input: "hi", scorers: ["latencyCost"] }]);
      const r = await runCli(["run", suite, "--case", "zzz"], { cwd, env: env() });
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("unknown case id: zzz");
    });
  });

  it("never writes a secret from the environment into the database", async () => {
    const cwd = workdir();
    const suite = writeSuite(
      cwd,
      [{ id: "a", input: "What is 2 + 2?", expected: "4", scorers: ["exactMatch"] }],
      { pipeline: { adapter: "http", config: { url: "${PIPELINE_URL}", headers: { Authorization: "Bearer ${PIPELINE_TOKEN}" } } } },
    );
    const r = await runCli(["run", suite], { cwd, env: { ...env(), PIPELINE_TOKEN: "super-secret-token-123" } });
    expect(r.code).toBe(0);
    const db = new Database(join(cwd, ".regrade", "results.db"), { readonly: true });
    const stored = JSON.stringify(db.prepare("SELECT * FROM runs").all());
    db.close();
    expect(stored).not.toContain("super-secret-token-123");
    expect(stored).toContain("${PIPELINE_TOKEN}");
    expect(r.stdout + r.stderr).not.toContain("super-secret-token-123");
  });

  it("init scaffolds a suite that runs against its own mock pipeline (keyless quickstart)", async () => {
    const cwd = workdir();
    const init = await runCli(["init"], { cwd });
    expect(init.code).toBe(0);
    expect(existsSync(join(cwd, "regrade", "suite.json"))).toBe(true);

    // start the scaffolded mock pipeline on a free port
    const port = 41000 + Math.floor(Math.random() * 1000);
    const server = spawn(process.execPath, [join(cwd, "regrade", "mock-pipeline.mjs")], { env: { ...process.env, PORT: String(port) } });
    try {
      await new Promise<void>((res, rej) => {
        server.stdout.on("data", (d) => String(d).includes("listening") && res());
        server.on("error", rej);
        setTimeout(() => rej(new Error("mock pipeline did not start")), 5000);
      });
      const r = await runCli(["run", "regrade/suite.json"], { cwd, env: { PIPELINE_URL: `http://localhost:${port}/pipeline` } });
      expect(r.stdout).toContain("All 2 cases passed.");
      expect(r.code).toBe(0);
    } finally {
      server.kill();
    }
  });

  it("schema prints valid JSON, and --out writes a file", async () => {
    const cwd = workdir();
    const r = await runCli(["schema"], { cwd });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).title).toBe("Regrade test suite");
    mkdirSync(join(cwd, "s"));
    await runCli(["schema", "--out", "s/x.json"], { cwd });
    expect(JSON.parse(readFileSync(join(cwd, "s", "x.json"), "utf8")).properties.cases).toBeDefined();
  });

  it.skipIf(process.platform === "win32")("SIGINT keeps partial results, marks the run interrupted, exits 130", async () => {
    const cwd = workdir();
    const suite = writeSuite(cwd, [
      { id: "fast", input: "What is 2 + 2?", expected: "4", scorers: ["exactMatch"] },
      { id: "hang", input: "FAIL:hang", expected: "x", scorers: ["exactMatch"] },
    ]);
    const child = spawn(process.execPath, [cli, "run", suite, "--concurrency", "2"], { cwd, env: { ...process.env, ...env(), NO_COLOR: "1" } });
    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      if (out.includes("fast") && !child.killed) child.kill("SIGINT");
    });
    const code = await new Promise<number | null>((res) => child.on("close", res));
    expect(code).toBe(130);
    expect(out).toContain("partial results saved");
    const db = new Database(join(cwd, ".regrade", "results.db"), { readonly: true });
    expect(db.prepare("SELECT status FROM runs").pluck().get()).toBe("interrupted");
    expect(db.prepare("SELECT case_id FROM results").pluck().all()).toEqual(["fast"]);
    db.close();
  });
});
