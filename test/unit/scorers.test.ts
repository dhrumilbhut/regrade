import { describe, expect, it } from "vitest";
import { exactMatch } from "../../src/scorers/exactMatch.js";
import { latencyCost } from "../../src/scorers/latencyCost.js";
import { scoreArgs } from "../helpers.js";

describe("exactMatch", () => {
  it("is case-insensitive, trimmed and whitespace-normalised by default", async () => {
    const r = await exactMatch.score(scoreArgs({ output: "  the   CAPITAL is  Paris \n", expected: "The capital is paris" }));
    expect(r).toMatchObject({ pass: true, value: 1 });
  });

  it("fails with a helpful reason on a mismatch", async () => {
    const r = await exactMatch.score(scoreArgs({ output: "London", expected: "Paris" }));
    expect(r.pass).toBe(false);
    expect(r.value).toBe(0);
    expect(r.reasoning).toContain("expected");
    expect(r.reasoning).toContain("London");
  });

  it("supports caseSensitive and turning off normalisation", async () => {
    expect((await exactMatch.score(scoreArgs({ output: "paris", expected: "Paris", config: { caseSensitive: true } }))).pass).toBe(false);
    expect((await exactMatch.score(scoreArgs({ output: "a  b", expected: "a b", config: { normalizeWhitespace: false } }))).pass).toBe(false);
  });

  it("errors, rather than failing, when expected is missing or config is invalid", async () => {
    expect((await exactMatch.score(scoreArgs({ expected: undefined }))).error).toContain("expected");
    expect((await exactMatch.score(scoreArgs({ expected: "x", config: { caseSensitive: "yes" } }))).error).toContain("invalid exactMatch config");
  });

  it("declares that it requires expected", () => {
    expect(exactMatch.requiresExpected).toBe(true);
  });
});

describe("latencyCost", () => {
  const meta = (latencyMs: number, costUsd: number | null) => ({ caseId: "c", attempt: 1, latencyMs, costUsd });

  it("always passes and records latency when no thresholds are set", async () => {
    const r = await latencyCost.score(scoreArgs({ meta: meta(5000, null) }));
    expect(r).toMatchObject({ pass: true, value: 5000 });
  });

  it("fails when maxLatencyMs is breached and says by how much", async () => {
    const r = await latencyCost.score(scoreArgs({ meta: meta(3204, null), config: { maxLatencyMs: 3000 } }));
    expect(r.pass).toBe(false);
    expect(r.value).toBe(3204);
    expect(r.reasoning).toContain("exceeds maxLatencyMs 3000 by 204 ms");
  });

  it("passes at or under the threshold", async () => {
    expect((await latencyCost.score(scoreArgs({ meta: meta(3000, null), config: { maxLatencyMs: 3000 } }))).pass).toBe(true);
  });

  it("fails when maxCostUsd is breached", async () => {
    const r = await latencyCost.score(scoreArgs({ meta: meta(10, 0.05), config: { maxCostUsd: 0.01 } }));
    expect(r.pass).toBe(false);
    expect(r.reasoning).toContain("maxCostUsd");
  });

  it("errors when a cost limit is set but cost is unknown (never a silent pass)", async () => {
    const r = await latencyCost.score(scoreArgs({ meta: meta(10, null), config: { maxCostUsd: 0.01 } }));
    expect(r.error).toContain("cost is unknown");
    expect(r.pass).toBe(false);
  });

  it("reports every breach", async () => {
    const r = await latencyCost.score(scoreArgs({ meta: meta(9000, 1), config: { maxLatencyMs: 1000, maxCostUsd: 0.1 } }));
    expect(r.reasoning).toContain("maxLatencyMs");
    expect(r.reasoning).toContain("maxCostUsd");
  });
});
