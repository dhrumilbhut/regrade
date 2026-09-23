import { afterEach, describe, expect, it } from "vitest";
import { ConfigError } from "../../src/core/errors.js";
import { runSuite, type RunOptions, type RunOverrides } from "../../src/core/runner.js";
import type { AttemptRecord, TestCase, TestSuite } from "../../src/core/types.js";
import type { RunReporter } from "../../src/report/types.js";
import { SqliteStore } from "../../src/store/sqliteStore.js";
import { startMockPipeline, type MockPipeline } from "../fixtures/mock-pipeline.js";
import { startStubJudge, type StubLlm } from "../fixtures/stub-llm.js";
import { httpSuite, registry } from "../helpers.js";

let mock: MockPipeline | undefined;
let stub: StubLlm | undefined;
let store: SqliteStore | undefined;

afterEach(async () => {
  await mock?.close();
  await stub?.close();
  store?.close();
  mock = stub = undefined;
  store = undefined;
});

async function setup(): Promise<{ mock: MockPipeline; store: SqliteStore }> {
  mock = await startMockPipeline();
  store = new SqliteStore(":memory:");
  return { mock, store };
}

const exact = (id: string, input: string, expected: string, extra: Partial<TestCase> = {}): TestCase => ({
  id,
  input,
  expected,
  scorers: ["exactMatch"],
  ...extra,
});

function run(suite: TestSuite, over: Partial<RunOptions> = {}, overrides: RunOverrides = {}) {
  return runSuite({ suite, registry: registry(), store: store!, regradeVersion: "0.1.0-test", env: {}, overrides, ...over });
}

describe("runSuite: outcomes and exit codes", () => {
  it("passes a suite: completed run, persisted attempts, exit 0", async () => {
    const { mock } = await setup();
    const out = await run(
      httpSuite(mock.url, [exact("france", "What is the capital of France?", "Paris"), exact("math", "What is 2 + 2?", "4")]),
    );
    expect(out.exitCode).toBe(0);
    expect(out.run.status).toBe("completed");
    expect(out.summary.cases).toMatchObject({ total: 2, passed: 2 });
    expect(store!.getAttempts(out.run.runId)).toHaveLength(2);
    expect(store!.getRun(out.run.runId)?.summary?.cases.passed).toBe(2);
  });

  it("fails a case whose output does not match: exit 1, scores recorded", async () => {
    const { mock } = await setup();
    const out = await run(httpSuite(mock.url, [exact("bad", "What is 2 + 2?", "5")]));
    expect(out.exitCode).toBe(1);
    expect(out.cases[0]?.verdict).toBe("failed");
    const [a] = store!.getAttempts(out.run.runId);
    expect(a?.status).toBe("failed");
    expect(a?.scores[0]).toMatchObject({ scorerName: "exactMatch", pass: false, value: 0 });
  });

  it("records a pipeline failure as errored (not failed) and still exits 1", async () => {
    const { mock } = await setup();
    const suite = httpSuite(mock.url, [exact("boom", "FAIL:500", "x"), exact("ok", "What is 2 + 2?", "4")]);
    suite.pipeline.config.retries = 0;
    const out = await run(suite);
    expect(out.exitCode).toBe(1);
    const boom = out.cases.find((c) => c.caseId === "boom")!;
    expect(boom.verdict).toBe("errored");
    expect(boom.attempts[0]).toMatchObject({ status: "errored", output: null, latencyMs: null, scores: [] });
    expect(boom.attempts[0]?.error).toContain("HTTP 500");
    expect(out.cases.find((c) => c.caseId === "ok")?.verdict).toBe("passed");
  });

  it("a scorer that cannot evaluate makes the attempt errored, never a pass", async () => {
    const { mock } = await setup();
    const out = await run(
      httpSuite(mock.url, [{ id: "c", input: "What is 2 + 2?", scorers: ["latencyCost"], scorerConfig: { latencyCost: { maxCostUsd: 0.1 } } }]),
    );
    expect(out.cases[0]?.verdict).toBe("errored");
    expect(out.cases[0]?.attempts[0]?.scores[0]?.error).toContain("cost is unknown");
    expect(out.exitCode).toBe(1);
  });

  it("enforces latencyCost thresholds", async () => {
    const { mock } = await setup();
    const out = await run(
      httpSuite(mock.url, [
        { id: "slow", input: "SLOW:200", scorers: ["latencyCost"], scorerConfig: { latencyCost: { maxLatencyMs: 50 } } },
        { id: "fast", input: "SLOW:0", scorers: ["latencyCost"], scorerConfig: { latencyCost: { maxLatencyMs: 5000 } } },
      ]),
    );
    expect(out.cases.find((c) => c.caseId === "slow")?.verdict).toBe("failed");
    expect(out.cases.find((c) => c.caseId === "fast")?.verdict).toBe("passed");
  });

  it("uses self-reported cost from the pipeline", async () => {
    const { mock } = await setup();
    const out = await run(httpSuite(mock.url, [{ id: "c", input: "COST", scorers: ["latencyCost"], scorerConfig: { latencyCost: { maxCostUsd: 0.01 } } }]));
    expect(out.exitCode).toBe(0);
    expect(out.summary.costUsd.pipeline).toBeCloseTo(0.002);
    expect(out.summary.costUsd.unknownAttempts).toBe(0);
  });
});

describe("runSuite: repeats and flakiness", () => {
  it("runs each case N times and labels a non-deterministic case flaky", async () => {
    const { mock } = await setup();
    const out = await run(httpSuite(mock.url, [exact("flaky", "FLAKY", "Paris"), exact("steady", "What is 2 + 2?", "4")]), {}, { repeat: 4, concurrency: 1 });
    expect(out.attempts).toHaveLength(8);
    const flaky = out.cases.find((c) => c.caseId === "flaky")!;
    expect(flaky.verdict).toBe("flaky");
    expect(flaky.attempts.map((a) => a.status)).toEqual(["passed", "failed", "passed", "failed"]);
    expect(out.cases.find((c) => c.caseId === "steady")?.verdict).toBe("passed");
    expect(out.summary.cases).toMatchObject({ passed: 1, flaky: 1 });
    expect(out.exitCode).toBe(1); // flaky is not green
  });

  it("stores one row per attempt", async () => {
    const { mock } = await setup();
    const out = await run(httpSuite(mock.url, [exact("c", "What is 2 + 2?", "4")]), {}, { repeat: 3 });
    expect(store!.getAttempts(out.run.runId).map((a) => a.attempt).sort()).toEqual([1, 2, 3]);
  });

  it("prefers the CLI repeat over case and suite values", async () => {
    const { mock } = await setup();
    const suite = httpSuite(mock.url, [exact("c", "What is 2 + 2?", "4", { repeat: 5 })], { defaults: { repeat: 2 } });
    expect((await run(suite)).attempts).toHaveLength(5);
    expect((await run(suite, {}, { repeat: 1 })).attempts).toHaveLength(1);
  });
});

describe("runSuite: concurrency, timeouts, interruption", () => {
  it("never exceeds the concurrency limit, and does use it", async () => {
    const { mock } = await setup();
    const cases = Array.from({ length: 8 }, (_, i) => exact(`s${i}`, "SLOW:80", "Paris"));
    await run(httpSuite(mock.url, cases), {}, { concurrency: 2 });
    expect(mock.maxInFlight()).toBe(2);
  });

  it("runs serially with concurrency 1", async () => {
    const { mock } = await setup();
    const cases = Array.from({ length: 4 }, (_, i) => exact(`s${i}`, "SLOW:20", "Paris"));
    await run(httpSuite(mock.url, cases), {}, { concurrency: 1 });
    expect(mock.maxInFlight()).toBe(1);
  });

  it("times out a hanging attempt and carries on with the rest", async () => {
    const { mock } = await setup();
    const out = await run(
      httpSuite(mock.url, [exact("hang", "FAIL:hang", "x", { timeoutMs: 150 }), exact("ok", "What is 2 + 2?", "4")]),
    );
    const hang = out.cases.find((c) => c.caseId === "hang")!;
    expect(hang.verdict).toBe("errored");
    expect(hang.attempts[0]?.error).toContain("timed out");
    expect(out.cases.find((c) => c.caseId === "ok")?.verdict).toBe("passed");
  });

  it("an interrupt keeps completed attempts, drops in-flight ones, and marks the run interrupted (exit 130)", async () => {
    const { mock } = await setup();
    const ctrl = new AbortController();
    const reporter: RunReporter = { onAttempt: () => ctrl.abort() }; // interrupt after the first result lands
    const cases = [exact("first", "What is 2 + 2?", "4"), ...Array.from({ length: 5 }, (_, i) => exact(`later${i}`, "SLOW:400", "Paris"))];
    const out = await run(httpSuite(mock.url, cases), { signal: ctrl.signal, reporter }, { concurrency: 1 });

    expect(out.exitCode).toBe(130);
    expect(out.run.status).toBe("interrupted");
    expect(out.run.finishedAt).not.toBeNull();
    const saved = store!.getAttempts(out.run.runId);
    expect(saved.length).toBeGreaterThanOrEqual(1);
    expect(saved.length).toBeLessThan(cases.length);
    expect(saved[0]?.caseId).toBe("first");
    expect(saved.every((a) => a.status !== "errored")).toBe(true); // aborted attempts are discarded, not recorded as errors
  });

  it("interrupts an attempt that is in flight", async () => {
    const { mock } = await setup();
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 100);
    const started = performance.now();
    const out = await run(httpSuite(mock.url, [exact("hang", "FAIL:hang", "x")]), { signal: ctrl.signal });
    expect(performance.now() - started).toBeLessThan(2000);
    expect(out.run.status).toBe("interrupted");
    expect(store!.getAttempts(out.run.runId)).toHaveLength(0);
  });
});

describe("runSuite: persistence", () => {
  it("writes each attempt as it completes, while the run is still 'running'", async () => {
    const { mock } = await setup();
    const seen: Array<{ status: string; rows: number }> = [];
    let runId = "";
    const reporter: RunReporter = {
      onRunStart: (i) => {
        runId = i.runId;
      },
      onAttempt: () => {
        seen.push({ status: store!.getRun(runId)!.status, rows: store!.getAttempts(runId).length });
      },
    };
    await run(httpSuite(mock.url, [exact("a", "What is 2 + 2?", "4"), exact("b", "What is 2 + 2?", "4")]), { reporter }, { concurrency: 1 });
    expect(seen).toEqual([
      { status: "running", rows: 1 },
      { status: "running", rows: 2 },
    ]);
  });

  it("snapshots input, expected and a case hash that changes when the case changes", async () => {
    const { mock } = await setup();
    const a = await run(httpSuite(mock.url, [exact("c", "What is 2 + 2?", "4")]));
    const b = await run(httpSuite(mock.url, [exact("c", "What is 2 + 2?", "5")]));
    const c = await run(httpSuite(mock.url, [exact("c", "What is 2 + 2?", "4")]));
    const [ra] = store!.getAttempts(a.run.runId);
    const [rb] = store!.getAttempts(b.run.runId);
    const [rc] = store!.getAttempts(c.run.runId);
    expect(ra).toMatchObject({ input: "What is 2 + 2?", expected: "4" });
    expect(ra?.caseHash).toBe(rc?.caseHash);
    expect(ra?.caseHash).not.toBe(rb?.caseHash);
    expect(a.run.suiteHash).not.toBe(b.run.suiteHash);
    expect(a.run.suiteHash).toBe(c.run.suiteHash);
  });

  it("folds the run's judge into the hash of cases that use llmJudge, and only those", async () => {
    const { mock } = await setup();
    stub = await startStubJudge();
    const env = { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: stub.anthropicBaseUrl };
    const suite = httpSuite(mock.url, [
      exact("judged", "What is 2 + 2?", "4", { scorers: ["llmJudge"] }),
      exact("pinned", "What is 2 + 2?", "4", {
        scorers: ["llmJudge"],
        scorerConfig: { llmJudge: { judge: "anthropic:claude-haiku-4-5" } },
      }),
      exact("plain", "What is 2 + 2?", "4"),
    ]);
    const hashes = async (judge: string) => {
      const out = await run(suite, { env }, { judge });
      return Object.fromEntries(store!.getAttempts(out.run.runId).map((a) => [a.caseId, a.caseHash]));
    };
    const a = await hashes("anthropic:claude-sonnet-5");
    const b = await hashes("anthropic:claude-opus-5");
    const c = await hashes("anthropic:claude-sonnet-5");
    expect(a.judged).not.toBe(b.judged);
    expect(a.judged).toBe(c.judged);
    expect(a.pinned).toBe(b.pinned); // its own judge is in scorerConfig, so the run's judge is irrelevant
    expect(a.plain).toBe(b.plain);
  });

  it("stores label and git info", async () => {
    const { mock } = await setup();
    const out = await run(httpSuite(mock.url, [exact("c", "What is 2 + 2?", "4")]), { git: { sha: "deadbeef", dirty: false } }, { label: "prompt-v7" });
    expect(out.run).toMatchObject({ label: "prompt-v7", gitSha: "deadbeef", gitDirty: false, regradeVersion: "0.1.0-test" });
  });
});

describe("runSuite: secrets and env", () => {
  it("resolves ${ENV} in pipeline config at run time, but never stores the value", async () => {
    const { mock } = await setup();
    const suite = httpSuite(mock.url, [exact("c", "What is 2 + 2?", "4")]);
    suite.pipeline.config.headers = { Authorization: "Bearer ${PIPELINE_TOKEN}" };
    const out = await run(suite, { env: { PIPELINE_TOKEN: "s3cret-value" } });

    expect(mock.requests[0]?.headers.authorization).toBe("Bearer s3cret-value");
    const stored = JSON.stringify(store!.getRun(out.run.runId));
    expect(stored).not.toContain("s3cret-value");
    expect(stored).toContain("${PIPELINE_TOKEN}");
  });

  it("masks a hard-coded secret before storing it and warns", async () => {
    const { mock } = await setup();
    const suite = httpSuite(mock.url, [exact("c", "What is 2 + 2?", "4")]);
    suite.pipeline.config.headers = { Authorization: "Bearer hard-coded-secret" };
    const warnings: string[] = [];
    const out = await run(suite, { reporter: { onWarning: (m) => warnings.push(m) } });

    expect(JSON.stringify(store!.getRun(out.run.runId))).not.toContain("hard-coded-secret");
    expect(warnings.some((w) => w.includes("headers.Authorization") && w.includes("hard-coded secret"))).toBe(true);
    expect(mock.requests[0]?.headers.authorization).toBe("Bearer hard-coded-secret"); // still used at run time
  });

  it("fails fast on a missing env var, before creating a run or calling the pipeline", async () => {
    const { mock } = await setup();
    const suite = httpSuite(mock.url, [exact("c", "What is 2 + 2?", "4")]);
    suite.pipeline.config.headers = { Authorization: "Bearer ${MISSING_TOKEN}" };
    await expect(run(suite)).rejects.toThrow(/MISSING_TOKEN/);
    expect(mock.requests).toHaveLength(0);
    expect(store!.listRuns()).toHaveLength(0);
  });
});

describe("runSuite: preflight and filters", () => {
  it("fails before running when llmJudge has no judge configured", async () => {
    const { mock } = await setup();
    const suite = httpSuite(mock.url, [{ id: "c", input: "hi", scorers: ["llmJudge"] }]);
    await expect(run(suite)).rejects.toThrow(/no judge model is configured/);
    expect(mock.requests).toHaveLength(0);
    expect(store!.listRuns()).toHaveLength(0);
  });

  it("fails before running when the judge's API key is missing", async () => {
    const { mock } = await setup();
    const suite = httpSuite(mock.url, [{ id: "c", input: "hi", scorers: ["llmJudge"] }], { defaults: { judge: "anthropic:claude-sonnet-5" } });
    await expect(run(suite)).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(mock.requests).toHaveLength(0);
  });

  it("resolves the judge with precedence: --judge over suite defaults over REGRADE_JUDGE", async () => {
    const { mock } = await setup();
    stub = await startStubJudge();
    const env = { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: stub.anthropicBaseUrl, REGRADE_JUDGE: "anthropic:from-env" };
    const suite = httpSuite(mock.url, [{ id: "c", input: "What is 2 + 2?", scorers: ["llmJudge"] }], { defaults: { judge: "anthropic:from-suite" } });

    await run(suite, { env });
    await run(suite, { env }, { judge: "anthropic:from-cli" });
    await run({ ...suite, defaults: {} }, { env });
    expect(stub.requests.map((r) => r.body.model)).toEqual(["from-suite", "from-cli", "from-env"]);
  });

  it("scores with llmJudge end to end and separates judge cost from pipeline cost", async () => {
    const { mock } = await setup();
    stub = await startStubJudge();
    const env = { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: stub.anthropicBaseUrl };
    const suite = httpSuite(mock.url, [exact("c", "What is the capital of France?", "Paris", { scorers: ["exactMatch", "llmJudge"] })], {
      defaults: { judge: "anthropic:claude-sonnet-5" },
    });
    const out = await run(suite, { env });
    expect(out.exitCode).toBe(0);
    const judgeScore = out.attempts[0]?.scores.find((s) => s.scorerName === "llmJudge");
    expect(judgeScore?.reasoning).toBeTruthy();
    expect(judgeScore?.costUsd).toBeGreaterThan(0);
    expect(out.summary.costUsd.judge).toBeGreaterThan(0);
    expect(out.summary.costUsd.unknownAttempts).toBe(1); // HTTP pipeline reported no cost
  });

  it("a failing judge verdict fails the case; a broken judge errors it", async () => {
    const { mock } = await setup();
    stub = await startStubJudge("normal", () => "fail");
    const env = { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: stub.anthropicBaseUrl };
    const suite = httpSuite(mock.url, [{ id: "c", input: "What is 2 + 2?", scorers: ["llmJudge"] }], { defaults: { judge: "anthropic:m" } });
    expect((await run(suite, { env })).cases[0]?.verdict).toBe("failed");

    await stub.close();
    stub = await startStubJudge("freetext");
    const env2 = { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: stub.anthropicBaseUrl };
    const broken = await run(suite, { env: env2 });
    expect(broken.cases[0]?.verdict).toBe("errored");
    expect(broken.exitCode).toBe(1);
  });

  it("warns when the judge model is the pipeline model", async () => {
    stub = await startStubJudge();
    store = new SqliteStore(":memory:");
    const env = { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: stub.anthropicBaseUrl };
    const suite: TestSuite = {
      name: "s",
      pipeline: { adapter: "anthropic", config: { model: "claude-sonnet-5" } },
      defaults: { judge: "anthropic:claude-sonnet-5" },
      cases: [{ id: "c", input: "hi", scorers: ["llmJudge"] }],
    };
    const warnings: string[] = [];
    await run(suite, { env, reporter: { onWarning: (m) => warnings.push(m) } });
    expect(warnings.some((w) => w.includes("same as the pipeline model"))).toBe(true);
  });

  it("filters by tag and by case id, and errors on nothing selected or an unknown id", async () => {
    const { mock } = await setup();
    const suite = httpSuite(mock.url, [
      exact("a", "What is 2 + 2?", "4", { tags: ["math"] }),
      exact("b", "What is the capital of France?", "Paris", { tags: ["geo"] }),
      exact("c", "What is 2 + 2?", "4"),
    ]);
    expect((await run(suite, {}, { tags: ["math"] })).attempts.map((a) => a.caseId)).toEqual(["a"]);
    expect((await run(suite, {}, { caseIds: ["b", "c"] })).attempts.map((a) => a.caseId).sort()).toEqual(["b", "c"]);
    expect((await run(suite, {}, { tags: ["geo"], caseIds: ["b"] })).attempts).toHaveLength(1);
    await expect(run(suite, {}, { tags: ["nope"] })).rejects.toThrow(/matched nothing/);
    await expect(run(suite, {}, { caseIds: ["zzz"] })).rejects.toThrow(/unknown case id: zzz/);
    await expect(run(suite, {}, { tags: ["geo"], caseIds: ["a"] })).rejects.toThrow(ConfigError);
  });
});

describe("runSuite: reporter events", () => {
  it("emits start, one event per attempt, and end", async () => {
    const { mock } = await setup();
    const events: string[] = [];
    const attempts: AttemptRecord[] = [];
    const reporter: RunReporter = {
      onRunStart: (i) => events.push(`start:${i.caseCount}:${i.attemptCount}:${i.concurrency}`),
      onAttempt: (a) => {
        events.push("attempt");
        attempts.push(a);
      },
      onRunEnd: ({ run }) => events.push(`end:${run.status}`),
    };
    await run(httpSuite(mock.url, [exact("a", "What is 2 + 2?", "4"), exact("b", "What is 2 + 2?", "4")]), { reporter }, { repeat: 2, concurrency: 2 });
    expect(events).toEqual(["start:2:4:2", "attempt", "attempt", "attempt", "attempt", "end:completed"]);
    expect(attempts).toHaveLength(4);
  });
});
