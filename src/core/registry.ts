import { ConfigError } from "./errors.js";
import type { PipelineAdapter, Scorer } from "./types.js";

/**
 * Adapters and scorers are looked up by name. Built-ins register through the
 * same public functions users will use, so there is no privileged path.
 */
export class Registry {
  private readonly adapters = new Map<string, PipelineAdapter>();
  private readonly scorers = new Map<string, Scorer>();

  registerAdapter(adapter: PipelineAdapter): this {
    this.adapters.set(adapter.name, adapter);
    return this;
  }

  registerScorer(scorer: Scorer): this {
    this.scorers.set(scorer.name, scorer);
    return this;
  }

  hasAdapter(name: string): boolean {
    return this.adapters.has(name);
  }

  hasScorer(name: string): boolean {
    return this.scorers.has(name);
  }

  getAdapter(name: string): PipelineAdapter {
    const a = this.adapters.get(name);
    if (!a) {
      throw new ConfigError(`Unknown adapter "${name}". Registered adapters: ${this.adapterNames().join(", ") || "(none)"}.`);
    }
    return a;
  }

  getScorer(name: string): Scorer {
    const s = this.scorers.get(name);
    if (!s) {
      throw new ConfigError(`Unknown scorer "${name}". Registered scorers: ${this.scorerNames().join(", ") || "(none)"}.`);
    }
    return s;
  }

  adapterNames(): string[] {
    return [...this.adapters.keys()].sort();
  }

  scorerNames(): string[] {
    return [...this.scorers.keys()].sort();
  }
}

/** Process-wide registry used by the CLI and by `registerAdapter` / `registerScorer`. */
export const defaultRegistry = new Registry();

export function registerAdapter(adapter: PipelineAdapter): void {
  defaultRegistry.registerAdapter(adapter);
}

export function registerScorer(scorer: Scorer): void {
  defaultRegistry.registerScorer(scorer);
}
