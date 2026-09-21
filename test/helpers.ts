import type { AdapterError } from "../src/core/errors.js";
import { createRegistry } from "../src/builtins.js";
import type { Registry } from "../src/core/registry.js";
import type { AttemptRecord, ScoreArgs, TestCase, TestSuite } from "../src/core/types.js";
import { defaultPrices } from "../src/pricing/cost.js";

export function signal(): AbortSignal {
  return new AbortController().signal;
}

export function registry(): Registry {
  return createRegistry();
}

export function scoreArgs(over: Partial<ScoreArgs> = {}): ScoreArgs {
  return {
    input: "What is the capital of France?",
    output: "Paris",
    meta: { caseId: "c1", attempt: 1, latencyMs: 100, costUsd: null },
    runtime: { env: {}, prices: defaultPrices(), signal: signal() },
    ...over,
  };
}

/** A suite that targets the mock pipeline over HTTP, with fast retries. */
export function httpSuite(url: string, cases: TestCase[], extra: Partial<TestSuite> = {}): TestSuite {
  return {
    name: "test-suite",
    pipeline: { adapter: "http", config: { url, retries: 2, retryBaseDelayMs: 1 } },
    cases,
    ...extra,
  };
}

export function attempt(over: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    caseId: "c1",
    attempt: 1,
    caseHash: "h1",
    input: "hi",
    output: "hello",
    latencyMs: 10,
    costUsd: null,
    status: "passed",
    completedAt: "2026-09-21T00:00:00.000Z",
    scores: [{ scorerName: "exactMatch", pass: true, value: 1 }],
    ...over,
  };
}

/** Await a promise that must reject; returns the rejection (fails the test if it resolves). */
export async function rejectionOf(p: Promise<unknown>): Promise<AdapterError> {
  try {
    await p;
  } catch (e) {
    return e as AdapterError;
  }
  throw new Error("expected the promise to reject, but it resolved");
}
