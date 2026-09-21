import { readFileSync } from "node:fs";
import { z } from "zod";
import { ConfigError, errorMessage } from "./errors.js";
import type { Registry } from "./registry.js";
import type { TestSuite } from "./types.js";

const idPattern = /^[A-Za-z0-9._-]+$/;

const messageSchema = z.strictObject({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string(),
});

const inputSchema = z.union(
  [
    z.string().min(1),
    z.strictObject({ messages: z.array(messageSchema).min(1) }),
    z.record(z.string(), z.unknown()),
  ],
  { error: 'input must be a non-empty string, {"messages": [...]}, or an object' },
);

const priceEntrySchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  cachedInputPerMTok: z.number().nonnegative().optional(),
  cacheWrite5mPerMTok: z.number().nonnegative().optional(),
  cacheWrite1hPerMTok: z.number().nonnegative().optional(),
  validUntil: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "validUntil must be a date like 2026-11-21")
    .optional(),
});

export const priceEntriesSchema = z.array(priceEntrySchema);

const testCaseSchema = z.strictObject({
  id: z.string().regex(idPattern, "id may only contain letters, digits, '.', '_' and '-'"),
  input: inputSchema,
  expected: z.string().optional(),
  tags: z.array(z.string().min(1)).optional(),
  scorers: z.array(z.string().min(1)).min(1, "at least one scorer is required"),
  scorerConfig: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
  repeat: z.number().int().min(1).max(50).optional(),
  timeoutMs: z.number().int().positive().optional(),
  source: z
    .strictObject({
      kind: z.enum(["manual", "production-flag", "synthetic"]),
      ref: z.string().optional(),
      note: z.string().optional(),
    })
    .optional(),
});

export const testSuiteSchema = z.strictObject({
  $schema: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  defaults: z
    .strictObject({
      repeat: z.number().int().min(1).max(50).optional(),
      timeoutMs: z.number().int().positive().optional(),
      concurrency: z.number().int().min(1).max(32).optional(),
      judge: z.string().min(1).optional(),
    })
    .optional(),
  pricing: priceEntriesSchema.optional(),
  pipeline: z.strictObject({
    adapter: z.string().min(1),
    config: z.record(z.string(), z.unknown()),
  }),
  cases: z.array(testCaseSchema).min(1, "a suite needs at least one case"),
});

export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out || "(root)";
}

const MAX_ISSUES = 12;

function fail(source: string, problems: string[]): never {
  const shown = problems.slice(0, MAX_ISSUES).map((p) => `  - ${p}`);
  if (problems.length > MAX_ISSUES) shown.push(`  - ...and ${problems.length - MAX_ISSUES} more`);
  throw new ConfigError(`Invalid suite (${source}):\n${shown.join("\n")}`);
}

/** Structural validation only. Use `checkSuite` for registry-aware validation. */
export function parseSuite(raw: unknown, source = "suite"): TestSuite {
  const result = testSuiteSchema.safeParse(raw);
  if (!result.success) {
    fail(
      source,
      result.error.issues.map((i) => `${formatPath(i.path)}: ${i.message}`),
    );
  }
  return result.data as TestSuite;
}

/** Semantic validation that needs to know which adapters and scorers exist. */
export function checkSuite(suite: TestSuite, registry: Registry, source = "suite"): void {
  const problems: string[] = [];

  if (!registry.hasAdapter(suite.pipeline.adapter)) {
    problems.push(
      `pipeline.adapter: unknown adapter "${suite.pipeline.adapter}" (registered: ${registry.adapterNames().join(", ")})`,
    );
  }

  const seen = new Map<string, number>();
  suite.cases.forEach((c, i) => {
    const prev = seen.get(c.id);
    if (prev !== undefined) problems.push(`cases[${i}].id: duplicate id "${c.id}" (also cases[${prev}])`);
    else seen.set(c.id, i);

    for (const [j, name] of c.scorers.entries()) {
      if (!registry.hasScorer(name)) {
        problems.push(
          `cases[${i}].scorers[${j}]: unknown scorer "${name}" (registered: ${registry.scorerNames().join(", ")})`,
        );
        continue;
      }
      if (registry.getScorer(name).requiresExpected && (c.expected === undefined || c.expected === "")) {
        problems.push(`cases[${i}] ("${c.id}"): scorer "${name}" requires an "expected" value`);
      }
    }
    for (const key of Object.keys(c.scorerConfig ?? {})) {
      if (!c.scorers.includes(key)) {
        problems.push(`cases[${i}].scorerConfig.${key}: no scorer named "${key}" in this case's "scorers" list`);
      }
    }
  });

  if (problems.length > 0) fail(source, problems);
}

export function parseSuiteText(text: string, source: string): TestSuite {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`Invalid JSON in ${source}: ${errorMessage(err)}`);
  }
  return parseSuite(raw, source);
}

export function loadSuite(filePath: string, registry: Registry): TestSuite {
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new ConfigError(`Cannot read suite file "${filePath}": ${errorMessage(err)}`);
  }
  const suite = parseSuiteText(text, filePath);
  checkSuite(suite, registry, filePath);
  return suite;
}
