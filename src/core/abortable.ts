import { abortMessage } from "./http.js";

/**
 * Resolve with `work`, or reject as soon as `signal` aborts, whichever is first. This makes timeouts and
 * interrupts binding for user code (inline scorers, custom adapters) that ignores the signal it is given;
 * the abandoned work keeps running in the background but can no longer hold up the run.
 */
export function raceAbort<T>(value: T | Promise<T>, signal: AbortSignal, describe: (why: string) => Error): Promise<T> {
  // plain JavaScript scorers and adapters sometimes return a value instead of a Promise: accept both
  const work = Promise.resolve(value);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(describe(abortMessage(signal)));
    if (signal.aborted) {
      // Still observe `work` so a later rejection is not reported as unhandled.
      work.catch(() => {});
      return onAbort();
    }
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
