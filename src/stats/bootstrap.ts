/** Small, fast, seedable PRNG (mulberry32) so reports are reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pass/fail outcomes (1 = passed) of one case in the base run and in the head run. */
export interface PairedCase {
  base: readonly number[];
  head: readonly number[];
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);

/** Mean over cases of (head pass rate - base pass rate). */
export function meanRateChange(cases: readonly PairedCase[]): number {
  return cases.length === 0 ? 0 : cases.reduce((s, c) => s + (mean(c.head) - mean(c.base)), 0) / cases.length;
}

/** Resamples scaled down for big suites so a comparison stays well under a second or two. */
export function resamplesFor(cases: readonly PairedCase[], requested = 10_000): number {
  const work = cases.reduce((s, c) => s + c.base.length + c.head.length, 0) || 1;
  return Math.max(2_000, Math.min(requested, Math.floor(30_000_000 / work)));
}

export interface PermutationResult {
  /** Observed mean change in pass rate per case. */
  observed: number;
  /** Two-sided Monte Carlo p-value, with the +1 correction so it is never exactly 0. */
  p: number;
  resamples: number;
}

/**
 * Paired permutation test, stratified by case.
 *
 * The question a regression gate asks is "on THIS suite, did the pass rate move by more than
 * sampling noise?" The randomness is within each case (the same input gives different
 * outputs), not across cases, so cases are held fixed and only the base/head labels of a
 * case's own attempts are shuffled. Under the null hypothesis that the pipeline did not
 * change, those labels are exchangeable. With one attempt per side this reduces to an exact
 * sign test on the cases whose outcome flipped.
 */
export function stratifiedPermutationTest(
  cases: readonly PairedCase[],
  opts: { resamples?: number; seed?: number } = {},
): PermutationResult | null {
  if (cases.length === 0) return null;
  const resamples = opts.resamples ?? resamplesFor(cases);
  const rand = mulberry32(opts.seed ?? 1);
  const observed = meanRateChange(cases);

  const pools = cases.map((c) => Uint8Array.from([...c.base, ...c.head]));
  const nb = cases.map((c) => c.base.length);
  const nh = cases.map((c) => c.head.length);
  const totals = pools.map((p) => p.reduce((s, x) => s + x, 0));

  let extreme = 0;
  const target = Math.abs(observed) - 1e-12;
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < pools.length; i++) {
      const pool = pools[i] as Uint8Array;
      const n = pool.length;
      // Partial Fisher-Yates: the first nb[i] slots become the "base" draw.
      let inBase = 0;
      for (let k = 0; k < (nb[i] as number); k++) {
        const j = k + Math.floor(rand() * (n - k));
        const tmp = pool[k] as number;
        pool[k] = pool[j] as number;
        pool[j] = tmp;
        inBase += pool[k] as number;
      }
      sum += ((totals[i] as number) - inBase) / (nh[i] as number) - inBase / (nb[i] as number);
    }
    if (Math.abs(sum / pools.length) >= target) extreme++;
  }
  return { observed, p: (extreme + 1) / (resamples + 1), resamples };
}

export interface BootstrapInterval {
  mean: number;
  lo: number;
  hi: number;
  resamples: number;
}

/**
 * Percentile bootstrap interval for the mean change in pass rate, resampling attempts
 * within each case (base and head separately, with replacement) and holding the set of
 * cases fixed. Its spread therefore reflects the same within-case sampling noise the
 * permutation test is about.
 */
export function stratifiedBootstrapInterval(
  cases: readonly PairedCase[],
  opts: { resamples?: number; level?: number; seed?: number } = {},
): BootstrapInterval | null {
  if (cases.length === 0) return null;
  const resamples = opts.resamples ?? resamplesFor(cases);
  const level = opts.level ?? 0.95;
  const rand = mulberry32(opts.seed ?? 1);

  const draw = (xs: readonly number[]): number => {
    let s = 0;
    for (let k = 0; k < xs.length; k++) s += xs[Math.floor(rand() * xs.length)] as number;
    return s / xs.length;
  };
  const means = new Float64Array(resamples);
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (const c of cases) sum += draw(c.head) - draw(c.base);
    means[r] = sum / cases.length;
  }
  means.sort();
  const alpha = (1 - level) / 2;
  const at = (q: number) => means[Math.min(resamples - 1, Math.max(0, Math.floor(q * resamples)))] as number;
  return { mean: meanRateChange(cases), lo: at(alpha), hi: at(1 - alpha), resamples };
}
