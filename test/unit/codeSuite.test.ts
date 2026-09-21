import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRegistry } from "../../src/builtins.js";
import { defineSuite, functionAdapter, toScorer, type CodeSuite } from "../../src/core/codeSuite.js";
import { AdapterError, ConfigError } from "../../src/core/errors.js";
import { stableHash } from "../../src/core/hash.js";
import { loadSuiteFile } from "../../src/core/loadSuiteFile.js";
import { runSuite } from "../../src/core/runner.js";
import type { AdapterContext } from "../../src/core/types.js";
import { defaultPrices } from "../../src/pricing/cost.js";
import { compareRuns } from "../../src/stats/compare.js";
import { SqliteStore } from "../../src/store/sqliteStore.js";
import { rejectionOf, scoreArgs, signal } from "../helpers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "regrade-code-"));
  dirs.push(d);
  return d;
};
const ctx = (over: Partial<AdapterContext> = {}): AdapterContext => ({ signal: signal(), caseId: "c", attempt: 1, env: {}, prices: defaultPrices(), ...over });

function writeSuite(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

const validModule = `
export default {
  name: "code-suite",
  pipeline: { name: "my-agent", config: { model: "x", apiKey: "hard-coded-secret" }, run: async (input) => "echo:" + input },
  scorers: {
    echoes: ({ output, input }) => output === "echo:" + input,
    detailed: ({ output }) => ({ pass: output.length > 3, value: output.length, reasoning: "len " + output.length }),
  },
  cases: [{ id: "a", input: "hi", scorers: ["echoes", "detailed"] }],
};
`;

describe("defineSuite", () => {
  it("returns its argument unchanged (it exists for type checking and completion)", () => {
    const s: CodeSuite = { name: "s", pipeline: { adapter: "http", config: {} }, cases: [] };
    expect(defineSuite(s)).toBe(s);
  });
});

describe("toScorer (inline scorers)", () => {
  it("wraps a function returning a boolean", async () => {
    const s = toScorer("isParis", ({ output }) => output === "Paris");
    expect(s.name).toBe("isParis");
    expect(await s.score(scoreArgs({ output: "Paris" }))).toEqual({ pass: true, value: 1, reasoning: undefined, costUsd: undefined, error: undefined });
    expect((await s.score(scoreArgs({ output: "Rome" }))).pass).toBe(false);
  });

  it("accepts a full result, and awaits async functions", async () => {
    const s = toScorer("x", async () => ({ pass: false, value: 0.25, reasoning: "meh" }));
    expect(await s.score(scoreArgs())).toMatchObject({ pass: false, value: 0.25, reasoning: "meh" });
  });

  it("rejects a bad return value with a helpful message (the runner records it as an errored attempt)", async () => {
    const s = toScorer("bad", (() => "yes") as never);
    await expect(s.score(scoreArgs())).rejects.toThrow(/scorer "bad" must return a boolean or \{ pass/);
  });

  it("supports the object form with requiresExpected and preflight", () => {
    const s = toScorer("needsExpected", { requiresExpected: true, score: () => true, preflight: () => {} });
    expect(s.requiresExpected).toBe(true);
    expect(typeof s.preflight).toBe("function");
  });

  it("rejects something that is neither a function nor a scorer object", () => {
    expect(() => toScorer("nope", {} as never)).toThrow(ConfigError);
  });

  it("fingerprints the source: same code, same fingerprint; different code, different fingerprint", () => {
    const a = toScorer("s", ({ output }) => output.length > 3);
    const b = toScorer("s", ({ output }) => output.length > 3);
    const c = toScorer("s", ({ output }) => output.length > 4);
    expect(a.fingerprint).toBeTruthy();
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(a.fingerprint).not.toBe(c.fingerprint);
    expect(toScorer("s", { score: () => true, fingerprint: "v7" }).fingerprint).toBe("v7");
  });
});

describe("functionAdapter (pipeline as a function)", () => {
  it("returns the output and measures latency; a string or an object both work", async () => {
    const a = functionAdapter({ run: async (input) => `got ${String(input)}` });
    const r = await a.run("hi", {}, ctx());
    expect(r).toMatchObject({ output: "got hi", costUsd: null });
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);

    const b = functionAdapter({ run: () => ({ output: "ok", costUsd: 0.5, usage: { inputTokens: 3 }, steps: [{ kind: "tool", name: "t" }], metadata: { v: 1 } }) });
    expect(await b.run("x", {}, ctx())).toMatchObject({ output: "ok", costUsd: 0.5, usage: { inputTokens: 3 }, steps: [{ kind: "tool", name: "t" }], metadata: { v: 1 } });
  });

  it("gives the function the attempt context", async () => {
    const seen: string[] = [];
    await functionAdapter({ run: (_i, c) => { seen.push(`${c.caseId}#${c.attempt}`); return "x"; } }).run("i", {}, ctx({ caseId: "case-9", attempt: 3 }));
    expect(seen).toEqual(["case-9#3"]);
  });

  it("wraps a thrown error, and rejects an invalid return value", async () => {
    const boom = await rejectionOf(functionAdapter({ run: () => { throw new Error("db down"); } }).run("x", {}, ctx()));
    expect(boom).toBeInstanceOf(AdapterError);
    expect(boom.message).toBe("pipeline function threw: db down");
    const bad = await rejectionOf(functionAdapter({ run: () => ({ nope: 1 }) as never }).run("x", {}, ctx()));
    expect(bad.message).toContain("must return a string or { output: string");
  });

  it("enforces the timeout even when the function ignores its abort signal", async () => {
    const never = functionAdapter({ run: () => new Promise<string>(() => {}) });
    const started = performance.now();
    const err = await rejectionOf(never.run("x", {}, ctx({ signal: AbortSignal.timeout(120) })));
    expect(err.message).toContain("timed out");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it("stops waiting on an interrupt, and never starts when already aborted", async () => {
    const ctrl = new AbortController();
    const pending = rejectionOf(functionAdapter({ run: () => new Promise<string>(() => {}) }).run("x", {}, ctx({ signal: ctrl.signal })));
    setTimeout(() => ctrl.abort(), 50);
    expect((await pending).message).toContain("aborted");
    const already = AbortSignal.abort();
    expect((await rejectionOf(functionAdapter({ run: () => "x" }).run("x", {}, ctx({ signal: already })))).message).toContain("aborted");
  });

  it("uses the given name (default 'function')", () => {
    expect(functionAdapter({ run: () => "x" }).name).toBe("function");
    expect(functionAdapter({ name: "my-agent", run: () => "x" }).name).toBe("my-agent");
  });
});

describe("loadSuiteFile", () => {
  it("loads a code suite: inline scorers and a function pipeline are registered next to the built-ins", async () => {
    const path = writeSuite(tmp(), "a.suite.mjs", validModule);
    const { suite, registry, kind } = await loadSuiteFile(path);
    expect(kind).toBe("code");
    expect(suite.pipeline).toEqual({ adapter: "my-agent", config: { model: "x", apiKey: "hard-coded-secret" } });
    expect(registry.hasScorer("echoes")).toBe(true);
    expect(registry.hasScorer("exactMatch")).toBe(true);
    expect(registry.hasAdapter("my-agent")).toBe(true);
    expect(suite).not.toHaveProperty("scorers"); // functions never reach the data model
  });

  it("delegates .json files to the JSON loader", async () => {
    const path = writeSuite(tmp(), "s.json", JSON.stringify({ name: "j", pipeline: { adapter: "http", config: { url: "http://x" } }, cases: [{ id: "a", input: "i", scorers: ["latencyCost"] }] }));
    expect((await loadSuiteFile(path)).kind).toBe("json");
  });

  it("accepts a default export that is a function, sync or async", async () => {
    const path = writeSuite(tmp(), "f.mjs", `export default async () => (${JSON.stringify({ name: "fn", pipeline: { adapter: "http", config: { url: "http://x" } }, cases: [{ id: "a", input: "i", scorers: ["latencyCost"] }] })});`);
    expect((await loadSuiteFile(path)).suite.name).toBe("fn");
  });

  it("does not leak state between loads: each load registers into the registry it is given", async () => {
    const path = writeSuite(tmp(), "a.mjs", validModule);
    const r1 = createRegistry();
    const r2 = createRegistry();
    await loadSuiteFile(path, r1);
    expect(r1.hasScorer("echoes")).toBe(true);
    expect(r2.hasScorer("echoes")).toBe(false);
  });

  const failing: Array<[string, string, RegExp]> = [
    ["no default export", "export const x = 1;", /must `export default` a suite/],
    ["an array as default export", "export default [];", /must `export default` a suite/],
    ["a default function that throws", "export default () => { throw new Error('nope'); };", /suite function .* threw: nope/],
    ["a syntax error", "export default {", /Failed to load suite module/],
    ["a module that throws while loading", "throw new Error('boom at import');", /Failed to load suite module .*boom at import/],
    ["an unknown scorer name", `export default { name: "s", pipeline: { run: () => "x" }, cases: [{ id: "a", input: "i", scorers: ["missing"] }] };`, /unknown scorer "missing"/],
    ["a typo'd key", `export default { name: "s", pipeline: { run: () => "x" }, cases: [{ id: "a", input: "i", scorer: ["x"], scorers: ["latencyCost"] }] };`, /Unrecognized key.*scorer/i],
    ["an inline scorer that shadows a built-in", `export default { name: "s", pipeline: { run: () => "x" }, scorers: { exactMatch: () => true }, cases: [{ id: "a", input: "i", scorers: ["exactMatch"], expected: "x" }] };`, /would replace a scorer with the same name/],
    ["an invalid inline scorer name", `export default { name: "s", pipeline: { run: () => "x" }, scorers: { "bad name": () => true }, cases: [{ id: "a", input: "i", scorers: ["latencyCost"] }] };`, /inline scorer name "bad name"/],
    ["scorers that is not an object", `export default { name: "s", pipeline: { run: () => "x" }, scorers: [() => true], cases: [{ id: "a", input: "i", scorers: ["latencyCost"] }] };`, /"scorers" must be an object/],
    ["a pipeline name that collides with an adapter", `export default { name: "s", pipeline: { name: "http", run: () => "x" }, cases: [{ id: "a", input: "i", scorers: ["latencyCost"] }] };`, /collides with a registered adapter/],
    ["a scorer that is neither function nor object", `export default { name: "s", pipeline: { run: () => "x" }, scorers: { weird: 42 }, cases: [{ id: "a", input: "i", scorers: ["weird"] }] };`, /must be a function or an object/],
  ];
  it.each(failing)("rejects %s with a clear ConfigError", async (_label, body, pattern) => {
    const path = writeSuite(tmp(), "bad.mjs", body);
    const err = await loadSuiteFile(path).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(pattern);
  });

  it("explains a missing import, including the .ts extension rule", async () => {
    const path = writeSuite(tmp(), "imp.mjs", `import "./does-not-exist.mjs"; export default {};`);
    const err = (await loadSuiteFile(path).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("Failed to load suite module");
    expect(err.message).toContain("write the extension in the import");
  });

  it("on a Node that cannot import TypeScript (an unsupported old Node), a .ts suite fails fast with an actionable message, but .mjs still loads", async () => {
    const features = process.features as { typescript?: unknown };
    const original = Object.getOwnPropertyDescriptor(features, "typescript");
    Object.defineProperty(features, "typescript", { value: false, configurable: true });
    try {
      const dir = tmp();
      const ts = writeSuite(dir, "s.ts", "export default {};");
      const err = (await loadSuiteFile(ts).catch((e: unknown) => e)) as Error;
      expect(err).toBeInstanceOf(ConfigError);
      expect(err.message).toContain("cannot import TypeScript files");
      expect(err.message).toContain("Node.js 24 or newer");
      expect(err.message).toContain("write the suite as .mjs or .json");
      expect((await loadSuiteFile(writeSuite(dir, "ok.mjs", validModule))).kind).toBe("code");
    } finally {
      if (original) Object.defineProperty(features, "typescript", original);
      else delete features.typescript;
    }
  });

  it("rejects unsupported file types and missing files", async () => {
    await expect(loadSuiteFile(join(tmp(), "suite.yaml"))).rejects.toThrow(/Unsupported suite file type ".yaml"/);
    await expect(loadSuiteFile(join(tmp(), "missing.json"))).rejects.toThrow(/Cannot read suite file/);
  });
});

describe("running code suites", () => {
  async function run(path: string) {
    const { suite, registry } = await loadSuiteFile(path);
    const store = new SqliteStore(":memory:");
    const outcome = await runSuite({ suite, registry, store, regradeVersion: "test", env: {} });
    return { outcome, store };
  }

  it("runs the function pipeline and inline scorers end to end", async () => {
    const { outcome, store } = await run(writeSuite(tmp(), "a.mjs", validModule));
    expect(outcome.exitCode).toBe(0);
    expect(outcome.attempts[0]?.output).toBe("echo:hi");
    expect(outcome.attempts[0]?.scores.map((s) => [s.scorerName, s.pass, s.value])).toEqual([["echoes", true, 1], ["detailed", true, 7]]);
    store.close();
  });

  it("stores the function pipeline's declared config, with secrets masked", async () => {
    const { outcome, store } = await run(writeSuite(tmp(), "a.mjs", validModule));
    const stored = JSON.stringify(store.getRun(outcome.run.runId)?.pipeline);
    expect(stored).toContain('"adapter":"my-agent"');
    expect(stored).toContain('"model":"x"');
    expect(stored).not.toContain("hard-coded-secret");
    store.close();
  });

  it("an inline scorer that throws makes the attempt errored (not failed), naming the scorer", async () => {
    const path = writeSuite(tmp(), "t.mjs", `export default { name: "s", pipeline: { run: () => "x" }, scorers: { kaboom: () => { throw new Error("bug in my scorer"); } }, cases: [{ id: "a", input: "i", scorers: ["kaboom"] }] };`);
    const { outcome, store } = await run(path);
    expect(outcome.cases[0]?.verdict).toBe("errored");
    expect(outcome.attempts[0]?.scores[0]).toMatchObject({ scorerName: "kaboom", error: "bug in my scorer", pass: false });
    store.close();
  });

  it("a pipeline function that throws makes the attempt errored, and the run continues", async () => {
    const path = writeSuite(
      tmp(),
      "p.mjs",
      `export default { name: "s", pipeline: { run: (i) => { if (i === "bad") throw new Error("agent crashed"); return "ok"; } }, cases: [{ id: "a", input: "bad", scorers: ["latencyCost"] }, { id: "b", input: "fine", scorers: ["latencyCost"] }] };`,
    );
    const { outcome, store } = await run(path);
    expect(outcome.cases.map((c) => [c.caseId, c.verdict])).toEqual([["a", "errored"], ["b", "passed"]]);
    expect(outcome.attempts.find((a) => a.caseId === "a")?.error).toBe("pipeline function threw: agent crashed");
    store.close();
  });

  it("an inline scorer that never resolves times out as an error instead of hanging the run", async () => {
    const path = writeSuite(tmp(), "h.mjs", `export default { name: "s", defaults: { timeoutMs: 150 }, pipeline: { run: () => "x" }, scorers: { hangs: () => new Promise(() => {}) }, cases: [{ id: "a", input: "i", scorers: ["hangs"] }, { id: "b", input: "i", scorers: ["latencyCost"] }] };`);
    const started = performance.now();
    const { outcome, store } = await run(path);
    expect(performance.now() - started).toBeLessThan(3000);
    const a = outcome.attempts.find((x) => x.caseId === "a")!;
    expect(a.status).toBe("errored");
    expect(a.scores[0]?.error).toMatch(/scorer "hangs" .*timed out \(limit 150 ms\)/);
    expect(outcome.cases.find((c) => c.caseId === "b")?.verdict).toBe("passed"); // the run carried on
    store.close();
  });

  it("a custom adapter that ignores the abort signal still cannot outlive the timeout", async () => {
    const registry = createRegistry().registerAdapter({ name: "stubborn", run: () => new Promise(() => {}) });
    const store = new SqliteStore(":memory:");
    const outcome = await runSuite({
      suite: { name: "s", defaults: { timeoutMs: 120 }, pipeline: { adapter: "stubborn", config: {} }, cases: [{ id: "a", input: "i", scorers: ["latencyCost"] }] },
      registry,
      store,
      regradeVersion: "t",
      env: {},
    });
    expect(outcome.attempts[0]?.status).toBe("errored");
    expect(outcome.attempts[0]?.error).toMatch(/timed out \(limit 120 ms\)/);
    store.close();
  });

  it("built-in-only suites keep exactly the same case hash as before code suites existed", async () => {
    const path = writeSuite(tmp(), "b.mjs", `export default { name: "s", pipeline: { run: () => "Paris" }, cases: [{ id: "a", input: "q", expected: "Paris", scorers: ["exactMatch"] }] };`);
    const { outcome, store } = await run(path);
    expect(outcome.attempts[0]?.caseHash).toBe(stableHash({ input: "q", expected: "Paris", scorers: ["exactMatch"], scorerConfig: null }));
    store.close();
  });

  it("editing an inline scorer changes its cases' hashes, so compare reports them as modified, not regressed", async () => {
    const make = (threshold: number) =>
      `export default { name: "s", pipeline: { run: () => "abcd" }, scorers: { longEnough: ({ output }) => output.length > ${threshold} }, cases: [{ id: "a", input: "q", scorers: ["longEnough"] }] };`;
    const dir = tmp();
    const store = new SqliteStore(":memory:");
    const runOnce = async (name: string, threshold: number) => {
      const { suite, registry } = await loadSuiteFile(writeSuite(dir, name, make(threshold)));
      return runSuite({ suite, registry, store, regradeVersion: "t", env: {} });
    };
    const before = await runOnce("v1.mjs", 3); // passes
    const after = await runOnce("v2.mjs", 9); // the scorer got stricter, so the case now fails
    expect(before.attempts[0]?.caseHash).not.toBe(after.attempts[0]?.caseHash);
    const cmp = compareRuns({ base: { run: before.run, attempts: before.attempts }, head: { run: after.run, attempts: after.attempts } });
    expect(cmp.cases[0]?.change).toBe("modified");
    expect(cmp.counts.regressed).toBe(0);
    store.close();
  });
});
