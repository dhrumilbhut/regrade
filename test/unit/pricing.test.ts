import { describe, expect, it } from "vitest";
import { computeCost, defaultPrices, findPrice, mergePrices, normalizeModel } from "../../src/pricing/cost.js";

const table = defaultPrices();

describe("computeCost", () => {
  it("prices input and output per million tokens (Sonnet 5: $2 / $10)", () => {
    expect(computeCost(table, "anthropic", "claude-sonnet-5", { inputTokens: 1000, outputTokens: 500 })).toBeCloseTo(0.007, 10);
  });

  it("prices cache reads at the cached rate, not the input rate (Opus 5: $0.50)", () => {
    const usd = computeCost(table, "anthropic", "claude-opus-5", { inputTokens: 100, cachedInputTokens: 1000 });
    expect(usd).toBeCloseTo((100 * 5 + 1000 * 0.5) / 1e6, 10);
    // Ignoring the cache category would have billed 1000 tokens at $5.
    expect(usd).toBeLessThan((1100 * 5) / 1e6);
  });

  it("splits cache writes into 5-minute and 1-hour rates", () => {
    const usd = computeCost(table, "anthropic", "claude-opus-5", { cacheWriteTokens: 1000, cacheWrite1hTokens: 400 });
    expect(usd).toBeCloseTo((600 * 6.25 + 400 * 10) / 1e6, 10);
  });

  it("matches dated snapshot ids to the base model", () => {
    expect(normalizeModel("claude-haiku-4-5-20251001")).toBe("claude-haiku-4-5");
    expect(computeCost(table, "anthropic", "claude-haiku-4-5-20251001", { inputTokens: 1_000_000 })).toBeCloseTo(1, 10);
  });

  it("returns null, never a guess, for an unknown model or missing usage", () => {
    expect(computeCost(table, "openai", "gpt-unknown", { inputTokens: 10 })).toBeNull();
    expect(computeCost(table, "anthropic", "claude-sonnet-5", undefined)).toBeNull();
  });

  it("returns null when tokens fall in a category with no price", () => {
    const t = mergePrices(table, [{ provider: "openai", model: "m", inputPerMTok: 1, outputPerMTok: 2 }]);
    expect(computeCost(t, "openai", "m", { inputTokens: 1000, outputTokens: 1000 })).toBeCloseTo(0.003, 10);
    expect(computeCost(t, "openai", "m", { inputTokens: 10, cachedInputTokens: 5 })).toBeNull();
  });
});

describe("mergePrices", () => {
  it("lets overrides replace bundled entries and adds new ones", () => {
    const merged = mergePrices(table, [
      { provider: "anthropic", model: "claude-sonnet-5", inputPerMTok: 99, outputPerMTok: 99 },
      { provider: "openai", model: "custom", inputPerMTok: 1, outputPerMTok: 1 },
    ]);
    expect(findPrice(merged, "anthropic", "claude-sonnet-5")?.inputPerMTok).toBe(99);
    expect(findPrice(merged, "openai", "custom")).toBeDefined();
    expect(findPrice(table, "anthropic", "claude-sonnet-5")?.inputPerMTok).toBe(2); // base untouched
  });

  it("replaces every variant of a model (promo and standard) when overridden", () => {
    const merged = mergePrices(table, [{ provider: "openai", model: "gpt-5.6-sol", inputPerMTok: 1, outputPerMTok: 1 }]);
    expect(merged.entries.filter((e) => e.model === "gpt-5.6-sol")).toHaveLength(1);
  });
});

describe("OpenAI prices (from the owner's pricing-page screenshot, short-context tier)", () => {
  it.each([
    ["gpt-6-astra", 10, 1, 12.5, 50],
    ["gpt-5.6-terra", 2, 0.2, 2.5, 12],
    ["gpt-5.6-luna", 0.2, 0.02, 0.25, 1.2],
    ["gpt-6-sol", 2, 0.2, 2.5, 10],
    ["gpt-6-luna", 0.1, 0.01, 0.125, 0.5],
    // models whose page shows no cache-write price ("-")
    ["gpt-5.4-nano", 0.2, 0.02, undefined, 1.25],
    ["gpt-5-nano", 0.05, 0.005, undefined, 0.4],
    ["gpt-4.1-nano", 0.1, 0.025, undefined, 0.4],
    ["gpt-4o-mini", 0.15, 0.075, undefined, 0.6],
    ["gpt-5.5-pro", 30, undefined, undefined, 180],
  ])("%s: input %d, cached %d, cache write %d, output %d per million", (model, input, cached, write, output) => {
    const p = findPrice(table, "openai", model)!;
    expect([p.inputPerMTok, p.cachedInputPerMTok, p.cacheWrite5mPerMTok, p.outputPerMTok]).toEqual([input, cached, write, output]);
  });

  it("prices a GPT-5.6 call including cache reads and cache writes", () => {
    const usd = computeCost(table, "openai", "gpt-5.6-terra", { inputTokens: 1000, cachedInputTokens: 4000, cacheWriteTokens: 2000, outputTokens: 500 });
    expect(usd).toBeCloseTo((1000 * 2 + 4000 * 0.2 + 2000 * 2.5 + 500 * 12) / 1e6, 10);
  });

  it("GPT-5.6 Sol uses the promotional price through 2026-11-21 (inclusive) and the standard price afterwards", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    expect(computeCost(table, "openai", "gpt-5.6-sol", usage, new Date("2026-09-21T12:00:00Z"))).toBeCloseTo(4 + 20, 10);
    expect(computeCost(table, "openai", "gpt-5.6-sol", usage, new Date("2026-11-21T23:59:59Z"))).toBeCloseTo(4 + 20, 10);
    expect(computeCost(table, "openai", "gpt-5.6-sol", usage, new Date("2026-11-22T00:00:00Z"))).toBeCloseTo(5 + 30, 10);
  });

  it("after the promotion, Sol cost is unknown for calls that write to the cache (standard cache-write rate was not shown)", () => {
    const usage = { inputTokens: 10, cacheWriteTokens: 5 };
    expect(computeCost(table, "openai", "gpt-5.6-sol", usage, new Date("2026-09-21"))).not.toBeNull();
    expect(computeCost(table, "openai", "gpt-5.6-sol", usage, new Date("2027-01-01"))).toBeNull();
  });

  it("an unknown OpenAI model still has unknown cost", () => {
    expect(computeCost(table, "openai", "gpt-9-imaginary", { inputTokens: 1 })).toBeNull();
  });
});
