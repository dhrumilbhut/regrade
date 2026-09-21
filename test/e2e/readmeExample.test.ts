import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");
const cli = join(root, "dist", "cli.js");
const hasTs = ["strip", "transform"].includes(String((process.features as { typescript?: unknown }).typescript));

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(args: string[], cwd: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, NO_COLOR: "1", CI: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", rej);
    child.on("close", (code) => res({ code, stdout, stderr }));
  });
}

/** The first fenced ts block in README.md that starts with the given first line. */
function readmeBlock(firstLine: string): string {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const m = new RegExp("```ts\\n(" + firstLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\\s\\S]*?)```").exec(readme);
  if (!m?.[1]) throw new Error(`README block starting with "${firstLine}" not found`);
  return m[1];
}

describe("README examples stay runnable", () => {
  it.skipIf(!hasTs)("the code-suite example runs as written (with a stand-in for ./agent.ts)", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "regrade-readme-"));
    dirs.push(cwd);
    writeFileSync(join(cwd, "support-bot.suite.ts"), readmeBlock("// support-bot.suite.ts"));
    writeFileSync(
      join(cwd, "agent.ts"),
      `export async function answer(q: string): Promise<{ text: string; costUsd: number; usage: { inputTokens: number; outputTokens: number } }> {
  return { text: "You have 30 days, per policy #4.", costUsd: 0.002, usage: { inputTokens: 20, outputTokens: 9 } };
}\n`,
    );
    const r = await run(["run", "support-bot.suite.ts"], cwd);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("support-bot · support-agent");
    expect(r.stdout).toContain("citesPolicy ✓");
    expect(r.stdout).toContain("underBudget ✓");
    expect(r.stdout).toContain("All 1 case passed.");
  });
});
