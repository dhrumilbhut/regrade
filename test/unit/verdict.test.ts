import { describe, expect, it } from "vitest";
import { caseVerdict, groupCases, percentile, summarize } from "../../src/core/verdict.js";
import { attempt } from "../helpers.js";

describe("caseVerdict", () => {
  it.each([
    [["passed"], "passed"],
    [["passed", "passed", "passed"], "passed"],
    [["failed"], "failed"],
    [["failed", "failed"], "failed"],
    [["passed", "failed"], "flaky"],
    [["passed", "failed", "passed"], "flaky"],
    [["errored"], "errored"],
    [["passed", "errored"], "errored"],
    [["failed", "errored"], "errored"],
    [[], "errored"],
  ] as const)("%j -> %s", (statuses, expected) => {
    expect(caseVerdict(statuses)).toBe(expected);
  });
});

describe("groupCases", () => {
  it("groups attempts by case in first-seen order and sorts attempts", () => {
    const groups = groupCases([
      attempt({ caseId: "b", attempt: 2, status: "failed" }),
      attempt({ caseId: "a", attempt: 1 }),
      attempt({ caseId: "b", attempt: 1 }),
    ]);
    expect(groups.map((g) => g.caseId)).toEqual(["b", "a"]);
    expect(groups[0]?.attempts.map((x) => x.attempt)).toEqual([1, 2]);
    expect(groups[0]?.verdict).toBe("flaky");
  });
});

describe("percentile", () => {
  it("uses nearest-rank", () => {
    const xs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    expect(percentile(xs, 50)).toBe(50);
    expect(percentile(xs, 95)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBe(0);
  });
});

describe("summarize", () => {
  it("counts cases and attempts, latency and costs", () => {
    const s = summarize([
      attempt({ caseId: "a", latencyMs: 100, costUsd: 0.01, scores: [{ scorerName: "llmJudge", pass: true, value: 1, costUsd: 0.002 }] }),
      attempt({ caseId: "b", latencyMs: 300, costUsd: null, status: "failed" }),
      attempt({ caseId: "c", latencyMs: null, status: "errored", output: null, scores: [] }),
    ]);
    expect(s.cases).toEqual({ total: 3, passed: 1, failed: 1, flaky: 0, errored: 1 });
    expect(s.attempts).toEqual({ total: 3, passed: 1, failed: 1, errored: 1 });
    expect(s.latency).toEqual({ avgMs: 200, p95Ms: 300 });
    expect(s.costUsd.pipeline).toBeCloseTo(0.01);
    expect(s.costUsd.judge).toBeCloseTo(0.002);
    expect(s.costUsd.unknownAttempts).toBe(2);
  });

  it("returns null latency when nothing has one", () => {
    expect(summarize([attempt({ latencyMs: null, status: "errored" })]).latency).toBeNull();
  });
});
