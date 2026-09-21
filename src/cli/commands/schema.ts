import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { testSuiteSchema } from "../../core/testSuite.js";

export function buildSuiteJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(testSuiteSchema) as Record<string, unknown>;
  return { title: "Regrade test suite", ...schema };
}

export function schemaCommand(opts: { out?: string }): void {
  const text = `${JSON.stringify(buildSuiteJsonSchema(), null, 2)}\n`;
  if (opts.out) {
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, text, "utf8");
  } else {
    process.stdout.write(text);
  }
}
