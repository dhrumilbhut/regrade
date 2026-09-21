import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
// Import from the public entry point, exactly as a library user would.
import { createRegistry, loadSuite, runSuite, SqliteStore, defaultRegistry } from "../../src/index.js";
import { startMockPipeline, type MockPipeline } from "../fixtures/mock-pipeline.js";

let mock: MockPipeline | undefined;
let dir: string | undefined;
afterEach(async () => {
  await mock?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  mock = dir = undefined;
});

describe("library usage (mirrors the README example)", () => {
  it("runs a suite with a custom scorer registered on a fresh registry", async () => {
    mock = await startMockPipeline();
    dir = mkdtempSync(join(tmpdir(), "regrade-lib-"));
    const suitePath = join(dir, "suite.json");
    writeFileSync(
      suitePath,
      JSON.stringify({
        name: "lib-suite",
        pipeline: { adapter: "http", config: { url: mock.url } },
        cases: [
          { id: "france", input: "What is the capital of France?", scorers: ["mentionsParis"] },
          { id: "math", input: "What is 2 + 2?", scorers: ["mentionsParis"] },
        ],
      }),
    );

    // ---- the README snippet ----
    const registry = createRegistry().registerScorer({
      name: "mentionsParis",
      async score({ output }) {
        const pass = /paris/i.test(output);
        return { pass, value: pass ? 1 : 0, reasoning: pass ? undefined : "never mentions Paris" };
      },
    });
    const suite = loadSuite(suitePath, registry);
    const store = new SqliteStore(join(dir, "results.db"));
    const outcome = await runSuite({ suite, registry, store, regradeVersion: "custom" });
    // ----------------------------

    expect(outcome.cases.map((c) => [c.caseId, c.verdict])).toEqual([
      ["france", "passed"],
      ["math", "failed"],
    ]);
    expect(outcome.exitCode).toBe(1);
    expect(outcome.attempts.find((a) => a.caseId === "math")?.scores[0]?.reasoning).toBe("never mentions Paris");
    store.close();
  });

  it("exposes the built-ins on defaultRegistry so registerScorer/registerAdapter work without setup", () => {
    expect(defaultRegistry.adapterNames()).toEqual(["anthropic", "http", "openai"]);
    expect(defaultRegistry.scorerNames()).toEqual(["exactMatch", "latencyCost", "llmJudge"]);
  });

  it("createRegistry returns isolated registries", () => {
    const a = createRegistry().registerScorer({ name: "only-in-a", score: async () => ({ pass: true, value: 1 }) });
    expect(a.hasScorer("only-in-a")).toBe(true);
    expect(createRegistry().hasScorer("only-in-a")).toBe(false);
  });
});
