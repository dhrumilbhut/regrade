export class RegradeError extends Error {
  readonly code: string;
  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Invalid suite, missing env var, bad flag: detected before any case runs. Exit code 2. */
export class ConfigError extends RegradeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "CONFIG", options);
  }
}

/** A pipeline/provider call failed. */
export class AdapterError extends RegradeError {
  readonly retryable: boolean;
  readonly status?: number;
  readonly retryAfterMs?: number;
  constructor(
    message: string,
    opts: { retryable?: boolean; status?: number; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, "ADAPTER", { cause: opts.cause });
    this.retryable = opts.retryable ?? false;
    this.status = opts.status;
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/** The LLM judge could not produce a valid verdict. Always fails closed. */
export class JudgeError extends RegradeError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, "JUDGE", options);
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
