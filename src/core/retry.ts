import { AdapterError } from "./errors.js";

export interface RetryOptions {
  /** Retries after the first attempt. Default 2. */
  maxRetries?: number;
  /** First backoff in ms, doubled each retry with jitter. Default 500. */
  baseDelayMs?: number;
  signal: AbortSignal;
}

export interface RetryResult<T> {
  value: T;
  retries: number;
  /** Duration of the final, successful attempt only. */
  durationMs: number;
}

const MAX_BACKOFF_MS = 30_000;

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Run `op`, retrying only errors that declare themselves retryable (network
 * failures, 429, 5xx). Honours `Retry-After`. Stops as soon as the signal aborts.
 */
export async function withRetry<T>(op: () => Promise<T>, opts: RetryOptions): Promise<RetryResult<T>> {
  const maxRetries = opts.maxRetries ?? 2;
  const base = opts.baseDelayMs ?? 500;
  for (let attempt = 0; ; attempt++) {
    const started = performance.now();
    try {
      const value = await op();
      return { value, retries: attempt, durationMs: performance.now() - started };
    } catch (err) {
      const retryable = err instanceof AdapterError && err.retryable;
      if (!retryable || attempt >= maxRetries || opts.signal.aborted) throw err;
      const backoff = base * 2 ** attempt * (0.5 + Math.random() / 2);
      const delay = Math.min(err.retryAfterMs ?? backoff, MAX_BACKOFF_MS);
      await sleep(delay, opts.signal);
      if (opts.signal.aborted) throw err;
    }
  }
}
