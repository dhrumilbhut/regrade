import { z } from "zod";
import type { Scorer } from "../core/types.js";

const configSchema = z.object({
  maxLatencyMs: z.number().positive().optional(),
  maxCostUsd: z.number().nonnegative().optional(),
});

/**
 * Not a correctness scorer: records latency (as `value`) and enforces optional
 * thresholds. With no thresholds it always passes. A configured threshold that
 * is breached fails the case, because a latency check that can never fail is
 * not a check.
 */
export const latencyCost: Scorer = {
  name: "latencyCost",

  async score({ meta, config }) {
    const parsed = configSchema.safeParse(config ?? {});
    if (!parsed.success) {
      return { pass: false, value: null, error: `invalid latencyCost config: ${parsed.error.issues[0]?.message ?? "?"}` };
    }
    const { maxLatencyMs, maxCostUsd } = parsed.data;
    const breaches: string[] = [];
    const notes: string[] = [`latency ${Math.round(meta.latencyMs)} ms`];

    if (maxLatencyMs !== undefined && meta.latencyMs > maxLatencyMs) {
      breaches.push(
        `latency ${Math.round(meta.latencyMs)} ms exceeds maxLatencyMs ${maxLatencyMs} by ${Math.round(meta.latencyMs - maxLatencyMs)} ms`,
      );
    }

    if (maxCostUsd !== undefined) {
      if (meta.costUsd === null) {
        return {
          pass: false,
          value: meta.latencyMs,
          error: "maxCostUsd is set but this attempt's cost is unknown (the adapter reported no usage, or the model has no price)",
        };
      }
      if (meta.costUsd > maxCostUsd) {
        breaches.push(`cost $${meta.costUsd.toFixed(6)} exceeds maxCostUsd $${maxCostUsd}`);
      }
    }
    if (meta.costUsd !== null) notes.push(`cost $${meta.costUsd.toFixed(6)}`);

    return {
      pass: breaches.length === 0,
      value: meta.latencyMs,
      reasoning: breaches.length > 0 ? breaches.join("; ") : notes.join(", "),
    };
  },
};
