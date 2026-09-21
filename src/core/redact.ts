import { hasPlaceholder } from "./env.js";

const SENSITIVE_KEY = /authorization|api[-_]?key|token|secret|password|passwd|credential/i;
// `apiKeyEnv: "MY_KEY_VAR"` names an env var; it is not itself a secret.
const ENV_NAME_KEY = /env(var)?$/i;

export const REDACTED = "[REDACTED]";

export interface RedactionResult<T> {
  value: T;
  /** Paths of values that looked like hard-coded secrets and were masked. */
  masked: string[];
}

/**
 * Prepare configuration for storage. `${ENV}` placeholders are kept (they are
 * not secrets); literal values under secret-looking keys are masked, so a
 * hard-coded key never reaches the database.
 */
export function redactConfig<T>(value: T): RedactionResult<T> {
  const masked: string[] = [];
  const out = walk(value, "", false, masked);
  return { value: out as T, masked };
}

function walk(value: unknown, path: string, sensitive: boolean, masked: string[]): unknown {
  if (typeof value === "string") {
    if (sensitive && value.length > 0 && !hasPlaceholder(value)) {
      masked.push(path);
      return REDACTED;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v, i) => walk(v, `${path}[${i}]`, sensitive, masked));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const keySensitive = SENSITIVE_KEY.test(k) && !ENV_NAME_KEY.test(k);
      out[k] = walk(v, path ? `${path}.${k}` : k, sensitive || keySensitive, masked);
    }
    return out;
  }
  return value;
}
