import { ConfigError } from "./errors.js";

export type Env = Record<string, string | undefined>;

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;

/** True if the string contains a `${VAR}` or `${VAR:-default}` placeholder. */
export function hasPlaceholder(s: string): boolean {
  PLACEHOLDER.lastIndex = 0;
  return PLACEHOLDER.test(s);
}

/**
 * Resolve `${VAR}` / `${VAR:-default}` placeholders in every string of a JSON-like
 * value. Missing variables (with no default) are collected and reported together
 * as one `ConfigError`, so a user fixes them in one pass.
 */
export function resolveEnv<T>(value: T, env: Env, where: string): T {
  const missing = new Set<string>();
  const out = walk(value, env, missing);
  if (missing.size > 0) {
    const names = [...missing].sort();
    throw new ConfigError(
      `Missing environment variable${names.length > 1 ? "s" : ""} referenced in ${where}: ${names.join(", ")}. ` +
        `Set ${names.length > 1 ? "them" : "it"} in your shell or CI secrets (never commit secrets to the suite file).`,
    );
  }
  return out as T;
}

function walk(value: unknown, env: Env, missing: Set<string>): unknown {
  if (typeof value === "string") {
    return value.replace(PLACEHOLDER, (_m, name: string, dflt: string | undefined) => {
      const v = env[name];
      if (v !== undefined && v !== "") return v;
      if (dflt !== undefined) return dflt;
      missing.add(name);
      return "";
    });
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, env, missing));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = walk(v, env, missing);
    return out;
  }
  return value;
}
