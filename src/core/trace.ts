import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";
import { errorMessage } from "./errors.js";
import { redactConfig } from "./redact.js";
import type { TraceStep } from "./types.js";

/** Longest step input or output kept in storage, in characters. */
export const TRACE_TEXT_LIMIT = 20_000;
/** Most steps kept per attempt (counting nested steps). */
export const TRACE_STEP_LIMIT = 1_000;

const KINDS = new Set<TraceStep["kind"]>(["llm", "tool", "retrieval", "agent", "other"]);

/** JSON-safe copy of an arbitrary value (a pipeline may return anything): cycles, BigInt, functions become text. */
function jsonSafe(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : (JSON.parse(text) as unknown);
  } catch {
    return String(value);
  }
}

function clip(value: unknown): unknown {
  if (value === undefined) return undefined;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined || text.length <= TRACE_TEXT_LIMIT) return value;
  return `${text.slice(0, TRACE_TEXT_LIMIT)}… [truncated: ${text.length - TRACE_TEXT_LIMIT} more characters]`;
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/**
 * Make a pipeline's trace safe to store: keep only known fields, coerce odd values rather than
 * reject them (a trace is diagnostic, never a reason to fail an attempt), mask values under
 * secret-looking keys, clip long inputs/outputs to `TRACE_TEXT_LIMIT` characters and keep at most
 * `TRACE_STEP_LIMIT` steps, noting what was cut.
 */
export function prepareTrace(steps: readonly unknown[] | undefined): TraceStep[] | undefined {
  if (!Array.isArray(steps)) return undefined;
  let kept = 0;
  let omitted = 0;
  const countAll = (s: unknown): number => {
    const children = (s as { children?: unknown } | null)?.children;
    return 1 + (Array.isArray(children) ? children.reduce((n: number, c) => n + countAll(c), 0) : 0);
  };

  const convert = (list: readonly unknown[]): TraceStep[] => {
    const out: TraceStep[] = [];
    for (const raw of list) {
      if (kept >= TRACE_STEP_LIMIT) {
        omitted += countAll(raw);
        continue;
      }
      kept++;
      const s = (raw && typeof raw === "object" ? raw : { name: String(raw) }) as Record<string, unknown>;
      const step: TraceStep = {
        kind: KINDS.has(s.kind as TraceStep["kind"]) ? (s.kind as TraceStep["kind"]) : "other",
        name: typeof s.name === "string" && s.name ? s.name : "step",
      };
      const start = num(s.startOffsetMs);
      const duration = num(s.durationMs);
      if (start !== undefined) step.startOffsetMs = start;
      if (duration !== undefined) step.durationMs = duration;
      const masked = redactConfig({ input: jsonSafe(s.input), output: jsonSafe(s.output), attributes: jsonSafe(s.attributes) }).value;
      if (masked.input !== undefined) step.input = clip(masked.input);
      if (masked.output !== undefined) step.output = clip(masked.output);
      if (masked.attributes && typeof masked.attributes === "object" && !Array.isArray(masked.attributes)) {
        step.attributes = masked.attributes as Record<string, unknown>;
      }
      if (Array.isArray(s.children) && s.children.length > 0) step.children = convert(s.children);
      out.push(step);
    }
    return out;
  };

  const trace = convert(steps);
  if (omitted > 0) trace.push({ kind: "other", name: `${omitted} more steps not stored (limit ${TRACE_STEP_LIMIT} per attempt)` });
  return trace;
}

/** Every step, depth first (parents before their children). */
export function flattenTrace(steps: readonly TraceStep[] | undefined): TraceStep[] {
  const out: TraceStep[] = [];
  const visit = (list: readonly TraceStep[]) => {
    for (const s of list) {
      out.push(s);
      if (s.children) visit(s.children);
    }
  };
  visit(steps ?? []);
  return out;
}

export interface Tracer {
  /** The recorded steps; return them from your pipeline as `steps`. */
  steps: TraceStep[];
  /**
   * Run `fn` as a step, recording its start, duration and return value (as `output`). A step started
   * inside another step's `fn` becomes its child. If `fn` throws, the error is recorded and rethrown.
   */
  step<T>(
    kind: TraceStep["kind"],
    name: string,
    fn: () => T | Promise<T>,
    opts?: { input?: unknown; attributes?: Record<string, unknown>; recordOutput?: boolean },
  ): Promise<T>;
}

/**
 * Record a trace from code, for function pipelines:
 *
 * ```ts
 * const t = tracer();
 * const docs = await t.step("retrieval", "search", () => search(q), { input: q });
 * const text = await t.step("llm", "answer", () => answer(q, docs));
 * return { output: text, steps: t.steps };
 * ```
 */
export function tracer(): Tracer {
  const t0 = performance.now();
  const steps: TraceStep[] = [];
  const current = new AsyncLocalStorage<TraceStep>();
  const ms = (n: number) => Math.round(n * 100) / 100;
  return {
    steps,
    async step(kind, name, fn, opts = {}) {
      const s: TraceStep = { kind, name, startOffsetMs: ms(performance.now() - t0) };
      if (opts.input !== undefined) s.input = opts.input;
      if (opts.attributes) s.attributes = { ...opts.attributes };
      const parent = current.getStore();
      (parent ? (parent.children ??= []) : steps).push(s);
      const start = performance.now();
      try {
        const result = await current.run(s, fn);
        if (opts.recordOutput !== false && result !== undefined) s.output = result;
        return result;
      } catch (err) {
        s.attributes = { ...s.attributes, error: errorMessage(err) };
        throw err;
      } finally {
        s.durationMs = ms(performance.now() - start);
      }
    },
  };
}
