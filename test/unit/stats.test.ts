import { describe, expect, it } from "vitest";
import type { AttemptRecord, AttemptStatus, RunRecord } from "../../src/core/types.js";
import {
  meanRateChange,
  mulberry32,
  resamplesFor,
  stratifiedBootstrapInterval,
  stratifiedPermutationTest,
  type PairedCase,
} from "../../src/stats/bootstrap.js";
import { compareRuns, regressionGate, type Comparison } from "../../src/stats/compare.js";
import { fisherExact } from "../../src/stats/fisher.js";
import { wilsonInterval } from "../../src/stats/wilson.js";
import { attempt } from "../helpers.js";

describe("wilsonInterval (reference values)", () => {
  it("3/3 passed: [0.4385, 1]", () => {
    const w = wilsonInterval(3, 3);
    expect(w.rate).toBe(1);
    expect(w.lo).toBeCloseTo(0.4385, 3);
    expect(w.hi).toBeCloseTo(1, 6);
  });

  it("0/10 passed: [0, 0.2775]", () => {
    const w = wilsonInterval(0, 10);
    expect(w.lo).toBeCloseTo(0, 6);
    expect(w.hi).toBeCloseTo(0.2775, 3);
  });

  it("5/10 passed: [0.2366, 0.7634]", () => {
    const w = wilsonInterval(5, 10);
    expect(w.lo).toBeCloseTo(0.2366, 3);
    expect(w.hi).toBeCloseTo(0.7634, 3);
  });

  it("stays within [0, 1], narrows with more data, and handles n = 0", () => {
    for (const [k, n] of [[0, 1], [1, 1], [0, 50], [50, 50]] as const) {
      const w = wilsonInterval(k, n);
      expect(w.lo).toBeGreaterThanOrEqual(0);
      expect(w.hi).toBeLessThanOrEqual(1);
    }
    expect(wilsonInterval(50, 100).hi - wilsonInterval(50, 100).lo).toBeLessThan(wilsonInterval(5, 10).hi - wilsonInterval(5, 10).lo);
    expect(wilsonInterval(0, 0)).toMatchObject({ attempts: 0, lo: 0, hi: 1 });
  });
});

describe("fisherExact (reference values)", () => {
  it("3/3 vs 0/3 is p = 0.1: three attempts per side can never reach 0.05", () => {
    expect(fisherExact(3, 3, 0, 3)).toBeCloseTo(0.1, 10);
  });

  it("5/5 vs 0/5 is p = 2/252", () => {
    expect(fisherExact(5, 5, 0, 5)).toBeCloseTo(2 / 252, 10);
  });

  it("the tea-tasting table [[3,1],[1,3]] is p = 0.4857", () => {
    expect(fisherExact(3, 4, 1, 4)).toBeCloseTo(0.4857, 3);
  });

  it("identical rates give p = 1; one attempt each can never be significant", () => {
    expect(fisherExact(1, 2, 1, 2)).toBeCloseTo(1, 10);
    expect(fisherExact(1, 1, 0, 1)).toBeCloseTo(1, 10);
    expect(fisherExact(0, 1, 1, 1)).toBeCloseTo(1, 10);
  });

  it("is symmetric and returns 1 for empty groups", () => {
    expect(fisherExact(7, 10, 2, 10)).toBeCloseTo(fisherExact(2, 10, 7, 10), 12);
    expect(fisherExact(0, 0, 3, 5)).toBe(1);
  });
});

const flips = (k: number, unchanged = 0): PairedCase[] => [
  ...Array.from({ length: k }, () => ({ base: [1], head: [0] })), // pass -> fail, one attempt each
  ...Array.from({ length: unchanged }, () => ({ base: [1], head: [1] })),
];

describe("stratifiedPermutationTest", () => {
  it("with one attempt per side it is an exact sign test on the flipped cases: k one-way flips give p = 2 / 2^k", () => {
    expect(stratifiedPermutationTest(flips(3), { seed: 1 })!.p).toBeCloseTo(0.25, 1);
    expect(stratifiedPermutationTest(flips(5), { seed: 1 })!.p).toBeCloseTo(0.0625, 1);
    expect(stratifiedPermutationTest(flips(6), { seed: 1 })!.p).toBeCloseTo(0.03125, 1);
    expect(stratifiedPermutationTest(flips(6), { seed: 1 })!.p).toBeLessThan(0.05);
    expect(stratifiedPermutationTest(flips(5), { seed: 1 })!.p).toBeGreaterThan(0.05);
  });

  it("unchanged cases add nothing: they neither help nor hurt the evidence", () => {
    const withNoise = stratifiedPermutationTest(flips(6, 20), { seed: 1 })!;
    expect(withNoise.observed).toBeCloseTo(-6 / 26, 10);
    expect(withNoise.p).toBeCloseTo(0.03125, 1);
  });

  it("mixed directions: 3 regressions and 3 improvements are consistent with noise", () => {
    const cases: PairedCase[] = [...flips(3), ...Array.from({ length: 3 }, () => ({ base: [0], head: [1] }))];
    const r = stratifiedPermutationTest(cases, { seed: 1 })!;
    expect(r.observed).toBe(0);
    expect(r.p).toBe(1);
  });

  it("identical runs give p = 1", () => {
    expect(stratifiedPermutationTest(flips(0, 8), { seed: 1 })!.p).toBe(1);
  });

  it("a total collapse with several attempts per case is overwhelming evidence", () => {
    const cases: PairedCase[] = Array.from({ length: 4 }, () => ({ base: [1, 1, 1, 1, 1], head: [0, 0, 0, 0, 0] }));
    expect(stratifiedPermutationTest(cases, { seed: 1 })!.p).toBeLessThan(0.001);
  });

  it("is deterministic for a seed, never returns exactly 0, and returns null for no cases", () => {
    const cases = flips(6);
    expect(stratifiedPermutationTest(cases, { seed: 5 })).toEqual(stratifiedPermutationTest(cases, { seed: 5 }));
    expect(stratifiedPermutationTest(cases, { seed: 5, resamples: 200 })!.p).toBeGreaterThan(0);
    expect(stratifiedPermutationTest([])).toBeNull();
  });

  const simulate = (seed: number, casesN: number, attempts: number, pBase: number, pHead: number): PairedCase[] => {
    const rand = mulberry32(seed);
    const draw = (p: number) => Array.from({ length: attempts }, () => (rand() < p ? 1 : 0));
    return Array.from({ length: casesN }, () => ({ base: draw(pBase), head: draw(pHead) }));
  };

  it("is calibrated: when the pipeline did not change it rejects about 5% of the time (not much more)", () => {
    let rejected = 0;
    const trials = 300;
    for (let t = 0; t < trials; t++) {
      const r = stratifiedPermutationTest(simulate(1000 + t, 10, 5, 0.6, 0.6), { seed: t, resamples: 1000 })!;
      if (r.p < 0.05) rejected++;
    }
    expect(rejected / trials).toBeLessThan(0.09);
  });

  it("has power: a real drop from 90% to 40% is detected almost every time", () => {
    let rejected = 0;
    const trials = 100;
    for (let t = 0; t < trials; t++) {
      const r = stratifiedPermutationTest(simulate(5000 + t, 10, 5, 0.9, 0.4), { seed: t, resamples: 1000 })!;
      if (r.p < 0.05 && r.observed < 0) rejected++;
    }
    expect(rejected / trials).toBeGreaterThan(0.95);
  });
});

describe("stratifiedBootstrapInterval", () => {
  it("is deterministic for a seed and differs across seeds", () => {
    const cases: PairedCase[] = [
      { base: [1, 1, 0, 1, 1], head: [1, 0, 0, 1, 0] },
      { base: [1, 0, 1, 1, 1], head: [1, 1, 1, 0, 1] },
      { base: [0, 0, 1, 0, 1], head: [1, 0, 1, 1, 1] },
    ];
    expect(stratifiedBootstrapInterval(cases, { seed: 7 })).toEqual(stratifiedBootstrapInterval(cases, { seed: 7 }));
    expect(stratifiedBootstrapInterval(cases, { seed: 7, resamples: 300 })?.lo).not.toBe(
      stratifiedBootstrapInterval(cases, { seed: 8, resamples: 300 })?.lo,
    );
  });

  it("collapses to a point when there is no within-case variation", () => {
    expect(stratifiedBootstrapInterval(flips(5), { seed: 2 })).toMatchObject({ mean: -1, lo: -1, hi: -1 });
    expect(stratifiedBootstrapInterval(flips(0, 5), { seed: 2 })).toMatchObject({ mean: 0, lo: 0, hi: 0 });
  });

  it("brackets the observed change and widens with fewer attempts", () => {
    const noisy = (n: number): PairedCase[] =>
      Array.from({ length: 6 }, () => ({
        base: Array.from({ length: n }, (_, i) => (i % 3 === 0 ? 0 : 1)),
        head: Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 0 : 1)),
      }));
    const few = stratifiedBootstrapInterval(noisy(6), { seed: 3 })!;
    const many = stratifiedBootstrapInterval(noisy(60), { seed: 3 })!;
    expect(few.lo).toBeLessThanOrEqual(few.mean);
    expect(few.hi).toBeGreaterThanOrEqual(few.mean);
    expect(few.hi - few.lo).toBeGreaterThan(many.hi - many.lo);
  });

  it("returns null for no cases", () => {
    expect(stratifiedBootstrapInterval([])).toBeNull();
  });
});

describe("resampling helpers", () => {
  it("meanRateChange averages the per-case change in pass rate", () => {
    expect(meanRateChange([{ base: [1, 1], head: [1, 0] }, { base: [0], head: [1] }])).toBeCloseTo((-0.5 + 1) / 2, 10);
    expect(meanRateChange([])).toBe(0);
  });

  it("scales resamples down for very large suites but never below a floor", () => {
    expect(resamplesFor(flips(5))).toBe(10_000);
    const big: PairedCase[] = Array.from({ length: 2000 }, () => ({ base: Array(10).fill(1), head: Array(10).fill(1) }));
    expect(resamplesFor(big)).toBeLessThan(10_000);
    expect(resamplesFor(big)).toBeGreaterThanOrEqual(2_000);
  });

  it("the PRNG is reproducible and uniform-ish in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 2000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 2000 }, () => b()));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    expect(xs.reduce((s, x) => s + x, 0) / xs.length).toBeGreaterThan(0.45);
    expect(xs.reduce((s, x) => s + x, 0) / xs.length).toBeLessThan(0.55);
  });
});

// ---------------------------------------------------------------------------

const run = (runId: string, over: Partial<RunRecord> = {}): RunRecord => ({
  runId,
  suiteName: "s",
  suiteHash: "suite-h",
  startedAt: "2026-09-21T10:00:00.000Z",
  finishedAt: "2026-09-21T10:01:00.000Z",
  status: "completed",
  regradeVersion: "0.2.0",
  gitSha: null,
  gitDirty: null,
  label: null,
  pipeline: {},
  summary: null,
  ...over,
});

/** Attempts for one case: a status per attempt. */
function caseAttempts(caseId: string, statuses: AttemptStatus[], hash = "h"): AttemptRecord[] {
  return statuses.map((status, i) =>
    attempt({
      caseId,
      attempt: i + 1,
      caseHash: hash,
      status,
      output: status === "errored" ? null : "x",
      latencyMs: status === "errored" ? null : 100,
      scores: status === "errored" ? [] : [{ scorerName: "exactMatch", pass: status === "passed", value: status === "passed" ? 1 : 0 }],
    }),
  );
}

const many = (n: number, statuses: AttemptStatus[], prefix = "c") => Array.from({ length: n }, (_, i) => caseAttempts(`${prefix}${i}`, statuses)).flat();

function cmp(baseAttempts: AttemptRecord[], headAttempts: AttemptRecord[], baseOver: Partial<RunRecord> = {}, headOver: Partial<RunRecord> = {}): Comparison {
  return compareRuns({
    base: { run: run("base-run", baseOver), attempts: baseAttempts },
    head: { run: run("head-run", headOver), attempts: headAttempts },
  });
}

describe("compareRuns: two runs of an unchanged, deterministic pipeline", () => {
  it("reports no regressions, no improvements, and no significant change", () => {
    const a = many(8, ["passed"]);
    const c = cmp(a, many(8, ["passed"]));
    expect(c.counts).toMatchObject({ unchanged: 8, regressed: 0, improved: 0, flaky: 0, errored: 0 });
    expect(c.overall).toMatchObject({ comparableCases: 8, meanDelta: 0, verdict: "not-significant", pValue: 1 });
    expect(c.overall.ci).toEqual({ lo: 0, hi: 0 });
    expect(regressionGate(c).failed).toBe(false);
    expect(c.warnings).toEqual([]);
  });
});

describe("compareRuns: a degraded pipeline", () => {
  const base = [...many(3, ["passed"], "steady"), ...many(3, ["passed"], "broke")];
  const headSingle = [...many(3, ["passed"], "steady"), ...many(3, ["failed"], "broke")];

  it("with one attempt per case: regressions are found but flagged as unconfirmed", () => {
    const c = cmp(base, headSingle);
    expect(c.counts.regressed).toBe(3);
    const r = c.cases.find((x) => x.caseId === "broke0")!;
    expect(r).toMatchObject({ change: "regressed", significant: false });
    expect(r.note).toContain("single attempt");
    expect(r.pValue).toBeCloseTo(1, 10);
    // The drop is large (-50 points on average), but three one-way flips are what chance produces
    // one time in four (exact sign test, p = 0.25): reported, not declared significant.
    expect(c.overall.meanDelta).toBeCloseTo(-0.5, 10);
    expect(c.overall.pValue).toBeCloseTo(0.25, 1);
    expect(c.overall.verdict).toBe("not-significant");
    // ...so the strict gate passes while the default gate, which trusts single-attempt flips, fails.
    expect(regressionGate(c, { significantOnly: true }).failed).toBe(false);
    expect(regressionGate(c).failed).toBe(true);
  });

  it("six one-way flips ARE significant overall (p = 2/64) even though no single case can be", () => {
    const c = cmp(
      many(8, ["passed"], "steady").concat(many(6, ["passed"], "broke")),
      many(8, ["passed"], "steady").concat(many(6, ["failed"], "broke")),
    );
    expect(c.cases.filter((x) => x.change === "regressed").every((x) => x.significant === false)).toBe(true);
    expect(c.overall.pValue).toBeLessThan(0.05);
    expect(c.overall.verdict).toBe("significant-regression");
    expect(regressionGate(c, { significantOnly: true }).reasons.join(" ")).toContain("dropped significantly");
  });

  it("with five attempts per side, a total collapse is significant per case", () => {
    const c = cmp(many(6, ["passed", "passed", "passed", "passed", "passed"]), many(6, ["failed", "failed", "failed", "failed", "failed"]));
    const r = c.cases[0]!;
    expect(r).toMatchObject({ change: "regressed", significant: true });
    expect(r.pValue).toBeCloseTo(2 / 252, 8);
    expect(r.base).toMatchObject({ passed: 5, attempts: 5 });
    expect(r.head).toMatchObject({ passed: 0, attempts: 5 });
    expect(c.overall.verdict).toBe("significant-regression");
  });

  it("with three attempts per side, even 3/3 -> 0/3 is not significant (p = 0.1)", () => {
    const c = cmp(many(6, ["passed", "passed", "passed"]), many(6, ["failed", "failed", "failed"]));
    expect(c.cases[0]).toMatchObject({ change: "regressed", significant: false });
    expect(c.cases[0]?.note).toContain("not statistically significant");
  });

  it("lists regressed cases first", () => {
    const c = cmp(base, headSingle);
    expect(c.cases.slice(0, 3).every((x) => x.change === "regressed")).toBe(true);
    expect(c.cases.slice(3).every((x) => x.change === "unchanged")).toBe(true);
  });

  it("a small drop among many unchanged cases is not a significant overall regression", () => {
    const c = cmp([...many(9, ["passed"], "ok"), ...caseAttempts("one", ["passed"])], [...many(9, ["passed"], "ok"), ...caseAttempts("one", ["failed"])]);
    expect(c.counts.regressed).toBe(1);
    expect(c.overall.meanDelta).toBeCloseTo(-0.1, 10);
    expect(c.overall.verdict).toBe("not-significant");
    expect(regressionGate(c).failed).toBe(true); // ...but the case-level regression still gates by default
    expect(regressionGate(c, { significantOnly: true }).failed).toBe(false);
  });
});

describe("compareRuns: improvements and flakiness", () => {
  it("detects an improvement and a flaky case", () => {
    const c = cmp(
      [...caseAttempts("fixed", ["failed", "failed", "failed"]), ...caseAttempts("wobbly", ["passed", "passed", "failed"]), ...caseAttempts("same", ["passed", "passed", "passed"])],
      [...caseAttempts("fixed", ["passed", "passed", "passed"]), ...caseAttempts("wobbly", ["passed", "passed", "failed"]), ...caseAttempts("same", ["passed", "passed", "passed"])],
    );
    expect(c.cases.find((x) => x.caseId === "fixed")).toMatchObject({ change: "improved" });
    expect(c.cases.find((x) => x.caseId === "wobbly")).toMatchObject({ change: "flaky" });
    expect(c.cases.find((x) => x.caseId === "same")).toMatchObject({ change: "unchanged" });
  });

  it("a pass -> flaky move counts as a regression", () => {
    const c = cmp(caseAttempts("x", ["passed", "passed", "passed", "passed"]), caseAttempts("x", ["passed", "failed", "passed", "failed"]));
    expect(c.cases[0]).toMatchObject({ change: "regressed" });
    expect(c.cases[0]?.head).toMatchObject({ passed: 2, attempts: 4 });
  });
});

describe("compareRuns: cases that cannot be compared", () => {
  it("separates new, removed, modified and errored cases from the statistics", () => {
    const c = cmp(
      [...caseAttempts("same", ["passed"]), ...caseAttempts("gone", ["passed"]), ...caseAttempts("edited", ["passed"], "old-hash"), ...caseAttempts("broken", ["passed"])],
      [...caseAttempts("same", ["passed"]), ...caseAttempts("fresh", ["failed"]), ...caseAttempts("edited", ["failed"], "new-hash"), ...caseAttempts("broken", ["errored"])],
    );
    expect(c.counts).toMatchObject({ unchanged: 1, removed: 1, new: 1, modified: 1, errored: 1, regressed: 0 });
    expect(c.cases.find((x) => x.caseId === "broken")).toMatchObject({ change: "errored", erroredIn: "head" });
    expect(c.overall.comparableCases).toBe(1);
    expect(c.overall.verdict).toBe("not-significant");
    expect(c.warnings.some((w) => w.includes("suite definition changed") || w.includes("modified"))).toBe(false); // same suiteHash in both runs
  });

  it("warns when the suite hash differs and cases were modified", () => {
    const c = cmp(caseAttempts("e", ["passed"], "a"), caseAttempts("e", ["passed"], "b"), {}, { suiteHash: "other" });
    expect(c.warnings.join(" ")).toContain("suite definition changed");
  });

  it("with few cases even a total collapse cannot be significant on single attempts (p = 2/2^4 = 0.125)", () => {
    const c = cmp(many(4, ["passed"]), many(4, ["failed"]));
    expect(c.overall).toMatchObject({ comparableCases: 4, meanDelta: -1, verdict: "not-significant" });
    expect(c.overall.pValue).toBeCloseTo(0.125, 1);
    expect(c.counts.regressed).toBe(4); // the regressions are still listed, and the default gate still fails
  });

  it("no comparable cases at all", () => {
    const c = cmp(caseAttempts("a", ["passed"]), caseAttempts("b", ["passed"]));
    expect(c.overall).toMatchObject({ comparableCases: 0, meanDelta: null, pValue: null, verdict: "no-comparable-cases", base: null, head: null });
  });

  it("warns about interrupted runs, different suites, and different attempt counts", () => {
    const c = cmp(
      caseAttempts("a", ["passed", "passed"]),
      caseAttempts("a", ["passed"]),
      {},
      { status: "interrupted", suiteName: "other" },
    );
    const w = c.warnings.join(" | ");
    expect(w).toContain("head run is interrupted");
    expect(w).toContain("different suites");
    expect(w).toContain("different number of times");
  });
});

describe("regressionGate", () => {
  it("fails on a case that errored in the head run, but not one that only errored in the base run", () => {
    const headErr = cmp(caseAttempts("a", ["passed"]), caseAttempts("a", ["errored"]));
    expect(regressionGate(headErr)).toMatchObject({ failed: true });
    expect(regressionGate(headErr).reasons[0]).toContain("errored in the head run");
    const baseErr = cmp(caseAttempts("a", ["errored"]), caseAttempts("a", ["passed"]));
    expect(regressionGate(baseErr).failed).toBe(false);
  });

  it("names the regressed cases", () => {
    const g = regressionGate(cmp(caseAttempts("checkout", ["passed"]), caseAttempts("checkout", ["failed"])));
    expect(g.failed).toBe(true);
    expect(g.reasons[0]).toContain("checkout");
  });

  it("passes when nothing got worse (improvements do not fail the gate)", () => {
    expect(regressionGate(cmp(caseAttempts("a", ["failed"]), caseAttempts("a", ["passed"]))).failed).toBe(false);
  });
});

describe("compareRuns: determinism and metrics", () => {
  it("gives identical results for identical inputs (seeded bootstrap)", () => {
    const a = many(7, ["passed", "failed"]);
    const b = many(7, ["failed", "failed"]);
    expect(cmp(a, b)).toEqual(cmp(a, b));
  });

  it("includes run summaries for latency and cost deltas", () => {
    const c = cmp(many(2, ["passed"]), many(2, ["failed"]));
    expect(c.metrics.base.attempts.total).toBe(2);
    expect(c.metrics.head.cases.failed).toBe(2);
  });
});
