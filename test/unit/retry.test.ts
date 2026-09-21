import { describe, expect, it } from "vitest";
import { AdapterError } from "../../src/core/errors.js";
import { withRetry } from "../../src/core/retry.js";
import { signal } from "../helpers.js";

const retryable = (extra: { retryAfterMs?: number } = {}) => new AdapterError("boom", { retryable: true, ...extra });

describe("withRetry", () => {
  it("returns immediately on success with zero retries", async () => {
    const r = await withRetry(async () => "ok", { signal: signal(), baseDelayMs: 1 });
    expect(r).toMatchObject({ value: "ok", retries: 0 });
  });

  it("retries retryable errors and reports the retry count", async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        calls++;
        if (calls < 3) throw retryable();
        return "ok";
      },
      { signal: signal(), maxRetries: 2, baseDelayMs: 1 },
    );
    expect(r).toMatchObject({ value: "ok", retries: 2 });
    expect(calls).toBe(3);
  });

  it("gives up after maxRetries and rethrows the last error", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw retryable();
        },
        { signal: signal(), maxRetries: 2, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("boom");
    expect(calls).toBe(3);
  });

  it("never retries non-retryable errors or unknown errors", async () => {
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          throw new AdapterError("HTTP 400", { retryable: false, status: 400 });
        },
        { signal: signal(), baseDelayMs: 1 },
      ),
    ).rejects.toThrow("HTTP 400");
    await expect(withRetry(async () => { throw new Error("bug"); }, { signal: signal(), baseDelayMs: 1 })).rejects.toThrow("bug");
    expect(calls).toBe(1);
  });

  it("honours Retry-After over the computed backoff", async () => {
    let calls = 0;
    const started = performance.now();
    await withRetry(
      async () => {
        if (calls++ === 0) throw retryable({ retryAfterMs: 60 });
        return "ok";
      },
      { signal: signal(), baseDelayMs: 1 },
    );
    expect(performance.now() - started).toBeGreaterThanOrEqual(55);
  });

  it("measures only the final successful attempt's duration", async () => {
    let calls = 0;
    const r = await withRetry(
      async () => {
        if (calls++ === 0) {
          await new Promise((res) => setTimeout(res, 80));
          throw retryable();
        }
        await new Promise((res) => setTimeout(res, 10));
        return "ok";
      },
      { signal: signal(), baseDelayMs: 1 },
    );
    expect(r.durationMs).toBeLessThan(60);
  });

  it("stops retrying once the signal aborts", async () => {
    const ctrl = new AbortController();
    let calls = 0;
    await expect(
      withRetry(
        async () => {
          calls++;
          ctrl.abort();
          throw retryable();
        },
        { signal: ctrl.signal, baseDelayMs: 1 },
      ),
    ).rejects.toThrow("boom");
    expect(calls).toBe(1);
  });
});
