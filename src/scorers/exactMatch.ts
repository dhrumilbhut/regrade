import { z } from "zod";
import type { Scorer } from "../core/types.js";

const configSchema = z.object({
  caseSensitive: z.boolean().optional(),
  trim: z.boolean().optional(),
  normalizeWhitespace: z.boolean().optional(),
});

/**
 * Deterministic string equality against `expected`. No LLM call.
 * By default: trimmed, whitespace-normalised, case-insensitive.
 */
export const exactMatch: Scorer = {
  name: "exactMatch",
  requiresExpected: true,

  async score({ expected, output, config }) {
    if (expected === undefined) {
      return { pass: false, value: null, error: 'exactMatch needs an "expected" value on the case' };
    }
    const parsed = configSchema.safeParse(config ?? {});
    if (!parsed.success) {
      return { pass: false, value: null, error: `invalid exactMatch config: ${parsed.error.issues[0]?.message ?? "?"}` };
    }
    const { caseSensitive = false, trim = true, normalizeWhitespace = true } = parsed.data;

    const norm = (s: string): string => {
      let r = s;
      if (trim) r = r.trim();
      if (normalizeWhitespace) r = r.replace(/\s+/g, " ");
      if (!caseSensitive) r = r.toLowerCase();
      return r;
    };

    const pass = norm(output) === norm(expected);
    return {
      pass,
      value: pass ? 1 : 0,
      reasoning: pass ? undefined : `expected "${clip(expected)}", got "${clip(output)}"`,
    };
  },
};

function clip(s: string, max = 60): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}
