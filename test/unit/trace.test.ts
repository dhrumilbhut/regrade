import { afterEach, describe, expect, it } from "vitest";
import { renderCaseDetail } from "../../src/cli/commands/show.js";
import { ConfigError } from "../../src/core/errors.js";
import { runSuite } from "../../src/core/runner.js";
import { flattenTrace, prepareTrace, tracer, TRACE_STEP_LIMIT, TRACE_TEXT_LIMIT } from "../../src/core/trace.js";
import type { AttemptRecord, RunRecord, TestCase, TraceStep } from "../../src/core/types.js";
import { summarize } from "../../src/core/verdict.js";
import { JS } from "../../src/report/html/assets.js";
import { renderHtmlReport } from "../../src/report/html/render.js";
import { buildRunReport } from "../../src/report/model.js";
import { buildRunFile, parseRunFile, serializeRunFile } from "../../src/store/runFile.js";
import { SqliteStore } from "../../src/store/sqliteStore.js";
import { maxSteps, toolCalled } from "../../src/scorers/traceScorers.js";
import { startMockPipeline, type MockPipeline } from "../fixtures/mock-pipeline.js";
import { attempt, httpSuite, registry, scoreArgs } from "../helpers.js";

let mock: MockPipeline | undefined;
let store: SqliteStore | undefined;
afterEach(async () => {
  await mock?.close();
  store?.close();
  mock = undefined;
  store = undefined;
});

const agentTrace: TraceStep[] = [
  {
    kind: "agent",
    name: "order-agent",
    startOffsetMs: 0,
    durationMs: 78,
    children: [
      { kind: "retrieval", name: "search", startOffsetMs: 1, durationMs: 9, input: { query: "order 123" } },
      { kind: "tool", name: "lookup_order", startOffsetMs: 11, durationMs: 25, input: { orderId: 123, fields: ["status"] } },
      { kind: "llm", name: "answer", startOffsetMs: 37, durationMs: 40, input: "Summarise.", output: "Shipped." },
    ],
  },
];

describe("prepareTrace", () => {
  it("keeps a well-formed trace as it is", () => {
    expect(prepareTrace(agentTrace)).toEqual(agentTrace);
    expect(prepareTrace([])).toEqual([]);
    expect(prepareTrace(undefined)).toBeUndefined();
  });

  it("coerces odd steps instead of rejecting them, and drops unknown fields", () => {
    const out = prepareTrace([{ kind: "planner", name: 42, durationMs: "12", extra: "x" }, "bare", null]);
    expect(out).toEqual([
      { kind: "other", name: "step" },
      { kind: "other", name: "bare" },
      { kind: "other", name: "null" },
    ]);
  });

  it("masks values under secret-looking keys in inputs, outputs and attributes", () => {
    const [s] = prepareTrace([
      { kind: "tool", name: "t", input: { authorization: "Bearer abc", q: "x" }, output: { token: "t0k" }, attributes: { api_key: "sk-1", model: "m" } },
    ])!;
    expect(s?.input).toEqual({ authorization: "[REDACTED]", q: "x" });
    expect(s?.output).toEqual({ token: "[REDACTED]" });
    expect(s?.attributes).toEqual({ api_key: "[REDACTED]", model: "m" });
  });

  it("clips long inputs and outputs, saying how much was cut", () => {
    const long = "x".repeat(TRACE_TEXT_LIMIT + 50);
    const [s] = prepareTrace([{ kind: "llm", name: "l", input: long, output: { text: long } }])!;
    expect(s?.input).toBe(`${"x".repeat(TRACE_TEXT_LIMIT)}… [truncated: 50 more characters]`);
    expect(typeof s?.output).toBe("string");
    expect(s?.output as string).toContain("more characters]");
  });

  it("stores anything a pipeline returns: cycles and BigInt become text", () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    const out = prepareTrace([{ kind: "tool", name: "t", input: cyclic, output: 10n }])!;
    expect(() => JSON.stringify(out)).not.toThrow();
    expect(out[0]?.output).toBe("10");
  });

  it(`keeps at most ${TRACE_STEP_LIMIT} steps, counting nested ones, and notes what was cut`, () => {
    const many = Array.from({ length: TRACE_STEP_LIMIT - 1 }, (_, i) => ({ kind: "tool", name: `t${i}` }));
    const nested = { kind: "agent", name: "sub", children: [{ kind: "llm", name: "a" }, { kind: "llm", name: "b" }] };
    const out = prepareTrace([...many, nested, { kind: "tool", name: "late" }])!;
    const all = flattenTrace(out);
    expect(all).toHaveLength(TRACE_STEP_LIMIT + 1); // the limit plus the note
    expect(out.at(-1)).toEqual({ kind: "other", name: `3 more steps not stored (limit ${TRACE_STEP_LIMIT} per attempt)` });
  });
});

describe("flattenTrace", () => {
  it("lists every step depth first, parents before children", () => {
    expect(flattenTrace(agentTrace).map((s) => s.name)).toEqual(["order-agent", "search", "lookup_order", "answer"]);
    expect(flattenTrace(undefined)).toEqual([]);
  });
});

describe("tracer()", () => {
  it("records steps with timing and output, nests steps started inside a step, and keeps parallel steps as siblings", async () => {
    const t = tracer();
    const answer = await t.step("agent", "run", async () => {
      const [a, b] = await Promise.all([
        t.step("retrieval", "search-a", async () => "doc-a", { input: "q" }),
        t.step("retrieval", "search-b", async () => "doc-b"),
      ]);
      return t.step("llm", "answer", () => `${a}+${b}`);
    });
    expect(answer).toBe("doc-a+doc-b");
    expect(t.steps).toHaveLength(1);
    const run = t.steps[0]!;
    expect(run.children?.map((c) => c.name)).toEqual(["search-a", "search-b", "answer"]);
    expect(run.children?.[0]).toMatchObject({ kind: "retrieval", input: "q", output: "doc-a" });
    expect(run.output).toBe("doc-a+doc-b");
    for (const s of flattenTrace(t.steps)) {
      expect(s.startOffsetMs).toBeGreaterThanOrEqual(0);
      expect(s.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("records an error on the step and rethrows it; recordOutput: false keeps the output out", async () => {
    const t = tracer();
    await expect(t.step("tool", "boom", () => Promise.reject(new Error("timeout")), { attributes: { retry: 1 } })).rejects.toThrow("timeout");
    await t.step("tool", "quiet", () => "secret stuff", { recordOutput: false });
    expect(t.steps[0]).toMatchObject({ name: "boom", attributes: { retry: 1, error: "timeout" } });
    expect(t.steps[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(t.steps[1]).not.toHaveProperty("output");
  });
});

describe("toolCalled", () => {
  const score = (config: Record<string, unknown>, trace: TraceStep[] | null = agentTrace) =>
    toolCalled.score(scoreArgs({ config, trace: trace ?? undefined }));

  it("passes when the tool was called (nested steps count), and says what was called otherwise", async () => {
    expect(await score({ tool: "lookup_order" })).toMatchObject({ pass: true, value: 1, reasoning: '"lookup_order" was called once' });
    const miss = await score({ tool: "cancel_order" });
    expect(miss).toMatchObject({ pass: false, value: 0 });
    expect(miss.reasoning).toBe('"cancel_order" was never called (tools called: lookup_order)');
    expect((await score({ tool: "x" }, [])).reasoning).toContain("no tools were called");
  });

  it("matches arguments partially and recursively", async () => {
    expect((await score({ tool: "lookup_order", argsInclude: { orderId: 123 } })).pass).toBe(true);
    expect((await score({ tool: "lookup_order", argsInclude: { fields: ["status"] } })).pass).toBe(true);
    expect((await score({ tool: "lookup_order", argsInclude: { orderId: 124 } })).pass).toBe(false);
    expect((await score({ tool: "lookup_order", argsInclude: { fields: ["status", "eta"] } })).pass).toBe(false);
    expect((await score({ tool: "search", argsInclude: { query: "order 123" } })).pass).toBe(false); // retrieval, not tool
  });

  it("checks an exact count, or that a tool was not called", async () => {
    const twice: TraceStep[] = [{ kind: "tool", name: "t" }, { kind: "tool", name: "t" }];
    expect((await score({ tool: "t", times: 2 }, twice)).pass).toBe(true);
    const one = await score({ tool: "t", times: 1 }, twice);
    expect(one).toMatchObject({ pass: false, value: 2 });
    expect(one.reasoning).toContain("expected 1");
    expect((await score({ tool: "delete_account", not: true })).pass).toBe(true);
    expect((await score({ tool: "lookup_order", not: true })).pass).toBe(false);
  });

  it("errors, never passes, when there is no trace or the config is wrong", async () => {
    expect((await score({ tool: "t", not: true }, null)).error).toContain("no trace");
    expect((await score({ tool: "t", not: true }, null)).pass).toBe(false);
    expect((await score({})).error).toContain("invalid toolCalled config");
    const cases: TestCase[] = [{ id: "c", input: "x", scorers: ["toolCalled"], scorerConfig: { toolCalled: { tool: "t", tims: 2 } } }];
    expect(() => toolCalled.preflight!({ cases, env: {} })).toThrow(ConfigError);
    expect(() => toolCalled.preflight!({ cases: [{ ...cases[0]!, scorerConfig: undefined }], env: {} })).toThrow(/case "c": invalid toolCalled config: tool/);
  });
});

describe("maxSteps", () => {
  const score = (config: Record<string, unknown>, trace: TraceStep[] | null = agentTrace) =>
    maxSteps.score(scoreArgs({ config, trace: trace ?? undefined }));

  it("counts every step, or steps of one kind, against a maximum", async () => {
    expect(await score({ max: 4 })).toMatchObject({ pass: true, value: 4, reasoning: "4 steps (max 4)" });
    expect(await score({ max: 3 })).toMatchObject({ pass: false, value: 4, reasoning: "4 steps, over the maximum of 3" });
    expect(await score({ max: 1, kind: "retrieval" })).toMatchObject({ pass: true, value: 1 });
    expect(await score({ max: 0, kind: "tool" })).toMatchObject({ pass: false, value: 1 });
  });

  it("errors without a trace, and requires max", async () => {
    expect((await score({ max: 5 }, null)).error).toContain("no trace");
    expect(() => maxSteps.preflight!({ cases: [{ id: "c", input: "x", scorers: ["maxSteps"] }], env: {} })).toThrow(/maxSteps config: max/);
  });
});

describe("traces through the runner and the store", () => {
  it("stores the steps an HTTP pipeline reports (masked), loads them only when asked, and scores them", async () => {
    mock = await startMockPipeline();
    store = new SqliteStore(":memory:");
    const suite = httpSuite(mock.url, [
      { id: "agent", input: "AGENT", scorers: ["toolCalled", "maxSteps"], scorerConfig: { toolCalled: { tool: "lookup_order", argsInclude: { orderId: 123 } }, maxSteps: { max: 6 } } },
    ]);
    const good = await runSuite({ suite, registry: registry(), store, regradeVersion: "t", env: {} });
    expect(good.exitCode).toBe(0);
    expect(store.getAttempts(good.run.runId)[0]?.trace).toBeUndefined();
    const [stored] = store.getAttempts(good.run.runId, { traces: true });
    const steps = flattenTrace(stored?.trace);
    expect(steps.map((s) => s.name)).toEqual(["order-agent", "search", "lookup_order", "answer"]);
    expect(steps[2]?.attributes).toEqual({ api_key: "[REDACTED]" });
    expect(JSON.stringify(stored?.trace)).not.toContain("sk-live");

    const badSuite = httpSuite(`${mock.url}?mode=degraded`, suite.cases);
    const bad = await runSuite({ suite: badSuite, registry: registry(), store, regradeVersion: "t", env: {} });
    const scores = bad.attempts[0]?.scores ?? [];
    expect(scores.find((s) => s.scorerName === "toolCalled")).toMatchObject({ pass: false, value: 0 });
    expect(scores.find((s) => s.scorerName === "maxSteps")).toMatchObject({ pass: false, value: 7 });
  });

  it("--no-trace stores nothing, but scorers still see the steps", async () => {
    mock = await startMockPipeline();
    store = new SqliteStore(":memory:");
    const suite = httpSuite(mock.url, [{ id: "agent", input: "AGENT", scorers: ["toolCalled"], scorerConfig: { toolCalled: { tool: "lookup_order" } } }]);
    const out = await runSuite({ suite, registry: registry(), store, regradeVersion: "t", env: {}, overrides: { storeTraces: false } });
    expect(out.exitCode).toBe(0);
    expect(store.getAttempts(out.run.runId, { traces: true })[0]?.trace).toBeUndefined();
  });

  it("stores every token category, and deleting a run deletes its traces", () => {
    store = new SqliteStore(":memory:");
    const run: RunRecord = {
      runId: "r", suiteName: "s", suiteHash: "h", startedAt: "2026-09-23T00:00:00.000Z", finishedAt: null, status: "running",
      regradeVersion: "t", gitSha: null, gitDirty: null, label: null, pipeline: {}, summary: null,
    };
    store.createRun(run);
    const usage = { inputTokens: 1, outputTokens: 2, cachedInputTokens: 3, cacheWriteTokens: 4, cacheWrite1hTokens: 1, reasoningTokens: 2 };
    store.saveAttempt("r", attempt({ usage, trace: agentTrace }));
    expect(store.getAttempts("r", { traces: true })[0]).toMatchObject({ usage, trace: agentTrace });
  });
});

describe("showing traces", () => {
  const withTrace = (trace: TraceStep[]): AttemptRecord[] => [attempt({ caseId: "agent", trace })];
  const run = (attempts: AttemptRecord[]): RunRecord => ({
    runId: "r-1", suiteName: "s", suiteHash: "h", startedAt: "2026-09-23T00:00:00.000Z", finishedAt: null, status: "completed",
    regradeVersion: "t", gitSha: null, gitDirty: null, label: null, pipeline: {}, summary: summarize(attempts),
  });

  it("show prints the step tree, and step inputs and outputs with --full", () => {
    const failing: TraceStep[] = [...agentTrace, { kind: "tool", name: "notify", durationMs: 3, attributes: { error: "HTTP 503" } }];
    const a = withTrace(failing);
    const text = renderCaseDetail(run(a), a, "agent", false, false);
    expect(text).toContain("trace  5 steps");
    expect(text).toMatch(/agent {5}order-agent\s+78 ms/);
    expect(text).toMatch(/ {8}tool {6}lookup_order\s+25 ms/); // nested one level
    expect(text).toContain("error: HTTP 503");
    expect(text).toContain("(step inputs and outputs: --full)");
    expect(text).not.toContain('"orderId": 123');
    expect(renderCaseDetail(run(a), a, "agent", true, false)).toContain('"orderId": 123');
  });

  it("the HTML report embeds each trace with step text clipped, and renders it as text", () => {
    const a = withTrace([{ kind: "llm", name: "l", durationMs: 5, output: "y".repeat(5000) }]);
    const html = renderHtmlReport({ report: buildRunReport(run(a), a), version: "1" });
    expect(html).toContain('"trace":[{"kind":"llm","name":"l"');
    expect(html).toContain("truncated 3000 characters");
    expect(JS).toContain("traceBlock");
    expect(JS).not.toMatch(/innerHTML/);
  });

  it("run files carry traces in full, and never in compact form", () => {
    const a = withTrace(agentTrace);
    const full = parseRunFile(serializeRunFile(buildRunFile(run(a), a, { regradeVersion: "t" })), "f.json");
    expect(full.attempts[0]?.trace).toEqual(agentTrace);
    const compact = serializeRunFile(buildRunFile(run(a), a, { regradeVersion: "t", compact: true }));
    expect(compact).not.toContain("lookup_order");
  });
});
