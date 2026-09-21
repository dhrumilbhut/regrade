export interface Proportion {
  passed: number;
  attempts: number;
  /** passed / attempts (0 when there are no attempts). */
  rate: number;
  /** Wilson score interval bounds. */
  lo: number;
  hi: number;
}

/** 97.5th percentile of the standard normal: a two-sided 95% interval. */
export const Z95 = 1.959963984540054;

/**
 * Wilson score interval for a binomial proportion. Unlike the textbook normal
 * approximation it stays inside [0, 1] and behaves at small n and extreme rates,
 * which is exactly where per-case eval results live (e.g. 3/3 passed).
 */
export function wilsonInterval(successes: number, n: number, z: number = Z95): Proportion {
  if (n <= 0) return { passed: 0, attempts: 0, rate: 0, lo: 0, hi: 1 };
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    passed: successes,
    attempts: n,
    rate: p,
    lo: Math.max(0, center - half),
    hi: Math.min(1, center + half),
  };
}
