/**
 * Shared contracts. The adapter and scorer interfaces are the two most stable
 * surfaces in Regrade: change them only additively.
 */
import type { PriceTable } from "../pricing/cost.js";

// ---- Inputs -----------------------------------------------------------------

export type Message = { role: "system" | "user" | "assistant"; content: string };

/**
 * What a test case feeds the pipeline.
 * - LLM adapters: a string becomes one user message; `{ messages }` is passed
 *   through; any other object needs `config.inputTemplate`.
 * - HTTP adapter: sent verbatim as `{ input }`.
 */
export type CaseInput = string | { messages: Message[] } | Record<string, unknown>;

// ---- Usage and trace --------------------------------------------------------

/**
 * Token usage, normalised across providers so cost can be computed uniformly.
 * Each field is a *disjoint* billing category:
 * - `inputTokens`: regular input tokens billed at the base input rate
 *   (excludes cache reads and cache writes).
 * - `outputTokens`: all output tokens, including reasoning tokens.
 * - `reasoningTokens`: informational subset of `outputTokens`.
 */
export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number; // subset of cacheWriteTokens written with the 1-hour TTL
  reasoningTokens?: number;
}

/**
 * Intermediate step of a pipeline run. Reserved in Phase 1: adapters may return
 * it and it is validated, but it is not persisted until Phase 2.
 */
export interface TraceStep {
  kind: "llm" | "tool" | "retrieval" | "agent" | "other";
  name: string;
  startOffsetMs?: number;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  attributes?: Record<string, unknown>;
  children?: TraceStep[];
}

// ---- Adapter ----------------------------------------------------------------

export interface AdapterResult {
  output: string;
  /** Duration of the final, successful attempt only. Retries are in `metadata`. */
  latencyMs: number;
  /** `null` when unknown. Never guessed. */
  costUsd: number | null;
  usage?: Usage;
  steps?: TraceStep[];
  metadata?: Record<string, unknown>;
}

export interface AdapterContext {
  signal: AbortSignal;
  caseId: string;
  attempt: number;
  env: Record<string, string | undefined>;
  prices: PriceTable;
}

export interface PipelineAdapter {
  name: string;
  /** Throws `AdapterError` on failure. `config` has `${ENV}` placeholders resolved. */
  run(input: CaseInput, config: Record<string, unknown>, ctx: AdapterContext): Promise<AdapterResult>;
  /** Optional fail-fast validation before any case runs. Throws `ConfigError`. */
  preflight?(
    config: Record<string, unknown>,
    cases: ReadonlyArray<{ id: string; input: CaseInput }>,
    env: Record<string, string | undefined>,
  ): void;
}

// ---- Scorer -----------------------------------------------------------------

export interface ScoreRuntime {
  /** Default judge model (`provider:model`), resolved from CLI / suite / env. */
  judge?: string;
  env: Record<string, string | undefined>;
  prices: PriceTable;
  signal: AbortSignal;
}

export interface ScoreArgs {
  input: CaseInput;
  expected?: string;
  output: string;
  config?: Record<string, unknown>;
  meta: {
    caseId: string;
    attempt: number;
    latencyMs: number;
    costUsd: number | null;
    usage?: Usage;
  };
  /** Populated from Phase 2. */
  trace?: TraceStep[];
  runtime: ScoreRuntime;
}

export interface ScoreResult {
  pass: boolean;
  /** Numeric score where meaningful (judge: 1/0; latencyCost: latencyMs). */
  value: number | null;
  reasoning?: string;
  /** The scorer's own spend, e.g. an LLM judge call. */
  costUsd?: number | null;
  /** Set when the scorer could not evaluate. The attempt becomes "errored", not "failed". */
  error?: string;
}

export interface ScorerPreflightContext {
  cases: ReadonlyArray<TestCase>;
  judge?: string;
  env: Record<string, string | undefined>;
}

export interface Scorer {
  name: string;
  /** If true, suite validation requires `expected` on every case using this scorer. */
  requiresExpected?: boolean;
  /**
   * Identifies the scorer's implementation (inline scorers: a hash of their source). It is folded
   * into each case's hash, so editing a scorer marks its cases as "modified" in comparisons
   * instead of silently comparing results produced by different logic.
   */
  fingerprint?: string;
  score(args: ScoreArgs): Promise<ScoreResult>;
  /** Optional fail-fast validation before any case runs. Throws `ConfigError`. */
  preflight?(ctx: ScorerPreflightContext): void;
}

// ---- Suite ------------------------------------------------------------------

export interface TestCase {
  id: string;
  input: CaseInput;
  expected?: string;
  tags?: string[];
  scorers: string[];
  scorerConfig?: Record<string, Record<string, unknown>>;
  repeat?: number;
  timeoutMs?: number;
  source?: { kind: "manual" | "production-flag" | "synthetic"; ref?: string; note?: string };
}

export interface SuiteDefaults {
  repeat?: number;
  timeoutMs?: number;
  concurrency?: number;
  judge?: string;
}

export interface PriceEntryInput {
  provider: string;
  model: string;
  inputPerMTok: number;
  outputPerMTok: number;
  cachedInputPerMTok?: number;
  /** Cache-write rate for the default TTL (for OpenAI: its single cache-write rate). */
  cacheWrite5mPerMTok?: number;
  cacheWrite1hPerMTok?: number;
  /** ISO date (YYYY-MM-DD): the entry (a promotion) stops applying after this UTC day. */
  validUntil?: string;
}

export interface TestSuite {
  $schema?: string;
  name: string;
  description?: string;
  defaults?: SuiteDefaults;
  pricing?: PriceEntryInput[];
  pipeline: { adapter: string; config: Record<string, unknown> };
  cases: TestCase[];
}

// ---- Results ----------------------------------------------------------------

export type AttemptStatus = "passed" | "failed" | "errored";
export type CaseVerdict = "passed" | "failed" | "flaky" | "errored";
export type RunStatus = "running" | "completed" | "interrupted" | "failed";

export interface ScoreRecord {
  scorerName: string;
  pass: boolean;
  value: number | null;
  reasoning?: string;
  costUsd?: number | null;
  error?: string;
  config?: Record<string, unknown>;
}

export interface AttemptRecord {
  caseId: string;
  attempt: number;
  caseHash: string;
  input: CaseInput;
  expected?: string;
  tags?: string[];
  output: string | null;
  latencyMs: number | null;
  costUsd: number | null;
  usage?: Usage;
  status: AttemptStatus;
  error?: string;
  completedAt: string;
  scores: ScoreRecord[];
}

export interface RunSummary {
  cases: { total: number; passed: number; failed: number; flaky: number; errored: number };
  attempts: { total: number; passed: number; failed: number; errored: number };
  latency: { avgMs: number; p95Ms: number } | null;
  costUsd: { pipeline: number; judge: number; unknownAttempts: number };
}

export interface RunRecord {
  runId: string;
  suiteName: string;
  suiteHash: string;
  startedAt: string;
  finishedAt: string | null;
  status: RunStatus;
  regradeVersion: string;
  gitSha: string | null;
  gitDirty: boolean | null;
  label: string | null;
  pipeline: Record<string, unknown>;
  summary: RunSummary | null;
}

/** v1 `RunResult` shape, assembled from `results` + `scores` for reporters and the library API. */
export interface RunResult {
  runId: string;
  suiteName: string;
  timestamp: string;
  caseId: string;
  attempt: number;
  output: string | null;
  latencyMs: number | null;
  costUsd: number | null;
  scores: Array<{ scorerName: string; pass: boolean; value: number | null; reasoning?: string }>;
  passed: boolean;
  status: AttemptStatus;
}
