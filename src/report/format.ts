import type { RunMeta, CaseChange } from "../stats/compare.js";
import type { Proportion } from "../stats/wilson.js";

export { formatUsd, formatMs } from "./console.js";

export const pct = (rate: number, digits = 0): string => `${(rate * 100).toFixed(digits)}%`;

/** `92% [84–96]` */
export function pctWithInterval(p: Proportion): string {
  return `${pct(p.rate)} [${pct(p.lo)}–${pct(p.hi)}]`;
}

/** Signed percentage points: `-8.3 pts`, `+2.0 pts`. */
export function points(delta: number): string {
  const v = delta * 100;
  const s = Math.abs(v) < 0.05 ? "0.0" : Math.abs(v).toFixed(1);
  return `${v < 0 ? "-" : v > 0 ? "+" : ""}${s} pts`;
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function runLine(m: RunMeta): string {
  const parts = [m.runId.slice(0, 8), fmtDate(m.startedAt)];
  if (m.label) parts.push(m.label);
  if (m.gitSha) parts.push(`${m.gitSha.slice(0, 7)}${m.gitDirty ? "*" : ""}`);
  if (m.status !== "completed") parts.push(`(${m.status})`);
  return parts.join("  ");
}

export const CHANGE_LABEL: Record<CaseChange, string> = {
  regressed: "regressed",
  improved: "improved",
  unchanged: "unchanged",
  flaky: "flaky",
  modified: "modified",
  new: "new",
  removed: "removed",
  errored: "errored",
};

export function countsLine(counts: Record<CaseChange, number>, sep = " · "): string {
  return (["regressed", "improved", "flaky", "unchanged", "modified", "new", "removed", "errored"] as CaseChange[])
    .map((k) => `${k} ${counts[k]}`)
    .join(sep);
}
