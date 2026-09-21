/** log(n!) via a cumulative table; fine for the attempt counts Regrade deals with. */
const logFactCache: number[] = [0, 0];
function logFact(n: number): number {
  for (let i = logFactCache.length; i <= n; i++) {
    logFactCache[i] = (logFactCache[i - 1] ?? 0) + Math.log(i);
  }
  return logFactCache[n] ?? 0;
}

function logChoose(n: number, k: number): number {
  return logFact(n) - logFact(k) - logFact(n - k);
}

/**
 * Two-sided Fisher exact test for a 2x2 table of pass/fail counts:
 *
 *                pass     fail
 *   base         a        n1 - a
 *   head         c        n2 - c
 *
 * Returns the probability, under the null of equal pass rates and with the
 * margins fixed, of a table at least as unlikely as the observed one. Exact,
 * so it is valid at the tiny sample sizes (3 to 10 attempts) where normal
 * approximations are not.
 */
export function fisherExact(a: number, n1: number, c: number, n2: number): number {
  if (n1 <= 0 || n2 <= 0) return 1;
  const passes = a + c;
  const total = n1 + n2;
  const logDenom = logChoose(total, n1);
  const prob = (x: number) => Math.exp(logChoose(passes, x) + logChoose(total - passes, n1 - x) - logDenom);

  const lo = Math.max(0, n1 - (total - passes));
  const hi = Math.min(n1, passes);
  const observed = prob(a);
  let p = 0;
  for (let x = lo; x <= hi; x++) {
    const px = prob(x);
    if (px <= observed * (1 + 1e-9)) p += px;
  }
  return Math.min(1, p);
}
