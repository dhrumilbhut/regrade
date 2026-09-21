import { AdapterError, errorMessage } from "./errors.js";

export interface JsonRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  signal: AbortSignal;
}

export interface JsonResponse {
  status: number;
  json: unknown;
  headers: Headers;
}

function excerpt(text: string, max = 300): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(value);
  if (!Number.isNaN(when)) return Math.max(0, when - Date.now());
  return undefined;
}

export function abortMessage(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  if (reason instanceof Error && reason.name === "TimeoutError") return "request timed out";
  return "request aborted";
}

/**
 * One HTTP request that expects a JSON response. Classifies failures so callers
 * can retry only what is worth retrying: network errors, 429 and 5xx.
 */
export async function requestJson(req: JsonRequest): Promise<JsonResponse> {
  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  let body: string | undefined;
  if (req.body !== undefined) {
    body = JSON.stringify(req.body);
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
      headers["content-type"] = "application/json";
    }
  }

  let res: Response;
  let text: string;
  try {
    res = await fetch(req.url, { method: req.method ?? "POST", headers, body, signal: req.signal });
    text = await res.text();
  } catch (err) {
    if (req.signal.aborted) throw new AdapterError(abortMessage(req.signal), { cause: err });
    const cause = err instanceof Error && err.cause instanceof Error ? `: ${err.cause.message}` : "";
    throw new AdapterError(`network error calling ${safeOrigin(req.url)} (${errorMessage(err)}${cause})`, {
      retryable: true,
      cause: err,
    });
  }

  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new AdapterError(`HTTP ${res.status} from ${safeOrigin(req.url)}: ${excerpt(text) || res.statusText}`, {
      retryable,
      status: res.status,
      retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
    });
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new AdapterError(`response from ${safeOrigin(req.url)} was not valid JSON: ${excerpt(text)}`, {
      status: res.status,
    });
  }
  return { status: res.status, json, headers: res.headers };
}

/** Origin + path only: query strings can carry tokens and must not leak into messages. */
export function safeOrigin(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "(invalid url)";
  }
}
