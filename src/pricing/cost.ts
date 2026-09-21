import type { PriceEntryInput, Usage } from "../core/types.js";
import bundled from "./prices.json" with { type: "json" };

export interface PriceEntry extends PriceEntryInput {
  sourceUrl?: string;
  note?: string;
}

export interface PriceTable {
  asOf: string;
  entries: PriceEntry[];
}

/** Bundled seed prices. Never mutated. */
export function defaultPrices(): PriceTable {
  return { asOf: bundled.asOf, entries: bundled.entries as PriceEntry[] };
}

/** Overrides win over the base table; unmatched base entries are kept. */
export function mergePrices(base: PriceTable, overrides: PriceEntryInput[] | undefined): PriceTable {
  if (!overrides || overrides.length === 0) return base;
  const key = (e: PriceEntryInput) => `${e.provider.toLowerCase()}::${normalizeModel(e.model)}`;
  const overridden = new Set(overrides.map(key));
  return {
    asOf: base.asOf,
    entries: [...base.entries.filter((e) => !overridden.has(key(e))), ...overrides],
  };
}

/** Strip a trailing snapshot date (`-20251001`) so dated ids match the table. */
export function normalizeModel(model: string): string {
  return model.toLowerCase().replace(/-\d{8}$/, "");
}

/**
 * The price that applies to a model at a point in time. An entry with
 * `validUntil` (a promotion) applies through that UTC date, inclusive, and wins
 * over an open-ended entry for the same model; afterwards the open-ended entry
 * applies.
 */
export function findPrice(table: PriceTable, provider: string, model: string, at: Date = new Date()): PriceEntry | undefined {
  const p = provider.toLowerCase();
  const m = normalizeModel(model);
  const day = at.toISOString().slice(0, 10);
  const matches = table.entries.filter((e) => e.provider.toLowerCase() === p && normalizeModel(e.model) === m);
  return matches.find((e) => e.validUntil !== undefined && day <= e.validUntil) ?? matches.find((e) => e.validUntil === undefined);
}

/**
 * Cost of one call in USD, or `null` if it cannot be determined exactly:
 * unknown model, no usage, or tokens in a category that has no price.
 * Cache tokens are priced separately; treating them as base-rate input would
 * silently misreport cost.
 */
export function computeCost(
  table: PriceTable,
  provider: string,
  model: string,
  usage: Usage | undefined,
  at: Date = new Date(),
): number | null {
  if (!usage) return null;
  const price = findPrice(table, provider, model, at);
  if (!price) return null;

  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  const cached = usage.cachedInputTokens ?? 0;
  const write = usage.cacheWriteTokens ?? 0;
  const write1h = Math.min(usage.cacheWrite1hTokens ?? 0, write);
  const write5m = write - write1h;

  if (cached > 0 && price.cachedInputPerMTok === undefined) return null;
  if (write5m > 0 && price.cacheWrite5mPerMTok === undefined) return null;
  if (write1h > 0 && price.cacheWrite1hPerMTok === undefined) return null;

  const usd =
    (input * price.inputPerMTok +
      output * price.outputPerMTok +
      cached * (price.cachedInputPerMTok ?? 0) +
      write5m * (price.cacheWrite5mPerMTok ?? 0) +
      write1h * (price.cacheWrite1hPerMTok ?? 0)) /
    1_000_000;
  return usd;
}
