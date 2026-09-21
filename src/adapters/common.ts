import { z } from "zod";
import { AdapterError, ConfigError } from "../core/errors.js";
import type { CaseInput, Message } from "../core/types.js";

export const retryFields = {
  retries: z.number().int().min(0).max(10).optional(),
  retryBaseDelayMs: z.number().int().min(0).optional(),
};

export function parseConfig<S extends z.ZodType>(schema: S, config: Record<string, unknown>, adapter: string): z.output<S> {
  const r = schema.safeParse(config);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `  - pipeline.config.${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new ConfigError(`Invalid config for the "${adapter}" adapter:\n${issues.join("\n")}`);
  }
  return r.data;
}

function lookup(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split(".")) {
    if (cur && typeof cur === "object" && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else return undefined;
  }
  return cur;
}

function asText(v: unknown): string {
  if (typeof v === "string") return v;
  return JSON.stringify(v, null, 2);
}

/** `{{input}}` is the whole input; `{{a.b}}` looks up a key path in an object input. */
export function renderTemplate(template: string, input: CaseInput): string {
  return template.replace(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g, (_m, path: string) => {
    if (path === "input") return asText(input);
    const v = lookup(input, path);
    return v === undefined ? "" : asText(v);
  });
}

function isMessagesInput(input: CaseInput): input is { messages: Message[] } {
  return typeof input === "object" && input !== null && Array.isArray((input as { messages?: unknown }).messages);
}

/**
 * Map a case input to chat messages for an LLM adapter.
 * string -> one user message; {messages} -> as-is; other object -> needs `inputTemplate`.
 */
export function toMessages(input: CaseInput, opts: { system?: string; inputTemplate?: string }): Message[] {
  const out: Message[] = [];
  if (opts.system) out.push({ role: "system", content: opts.system });
  if (opts.inputTemplate !== undefined) {
    out.push({ role: "user", content: renderTemplate(opts.inputTemplate, input) });
  } else if (typeof input === "string") {
    out.push({ role: "user", content: input });
  } else if (isMessagesInput(input)) {
    out.push(...input.messages);
  } else {
    throw new AdapterError(
      'this input is an object without "messages"; set pipeline.config.inputTemplate (e.g. "{{question}}") to map it to a prompt',
    );
  }
  return out;
}

/** Fail fast at preflight when object inputs would have no way to become a prompt. */
export function assertInputsMappable(
  cases: ReadonlyArray<{ id: string; input: CaseInput }>,
  inputTemplate: string | undefined,
  adapter: string,
): void {
  if (inputTemplate !== undefined) return;
  const bad = cases.filter((c) => typeof c.input === "object" && !isMessagesInput(c.input)).map((c) => c.id);
  if (bad.length > 0) {
    throw new ConfigError(
      `The "${adapter}" adapter needs pipeline.config.inputTemplate for object inputs without "messages" ` +
        `(cases: ${bad.slice(0, 5).join(", ")}${bad.length > 5 ? ", ..." : ""}).`,
    );
  }
}
