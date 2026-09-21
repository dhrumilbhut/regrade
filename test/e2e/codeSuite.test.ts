import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");
const cli = join(root, "dist", "cli.js");
const hasTs = ["strip", "transform"].includes(String((process.features as { typescript?: unknown }).typescript));

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

function runCli(args: string[], cwd: string): Promise<CliResult> {
  const started = performance.now();
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, NO_COLOR: "1", CI: "1" } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr, ms: performance.now() - started }));
  });
}

const dirs: string[] = [];
beforeAll(() => {
  expect(existsSync(cli), "dist/cli.js is missing: run `npm run build`").toBe(true);
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const workdir = () => {
  const d = mkdtempSync(join(tmpdir(), "regrade-e2e3-"));
  dirs.push(d);
  return d;
};
const write = (dir: string, name: string, body: string) => {
  writeFileSync(join(dir, name), body);
  return name;
};

const tsSuite = (expectedForms: string) => `
import type { CodeSuite } from "regrade"; // regrade is NOT installed here: a type-only import must be erased
import { shout } from "./helper.ts";

interface Row { id: string; q: string; want: string }
const rows: Row[] = ${expectedForms};

export default {
  name: "ts-suite",
  pipeline: { name: "agent", run: async (input) => shout(String(input)) },
  scorers: {
    isUpper: ({ output }) => output === output.toUpperCase(),
    matchesWant: ({ output, expected }) => ({ pass: output === expected, value: output.length, reasoning: "want " + expected }),
  },
  cases: rows.map((r) => ({ id: r.id, input: r.q, expected: r.want, scorers: ["isUpper", "matchesWant"] })),
} satisfies CodeSuite;
`;
const helper = `export const shout = (s: string): string => s.toUpperCase();\n`;

describe("code suites (built binary)", () => {
  it.skipIf(!hasTs)("runs a TypeScript suite: type-only import erased, local .ts import, inline scorers, function pipeline", async () => {
    const cwd = workdir();
    write(cwd, "helper.ts", helper);
    write(cwd, "s.suite.ts", tsSuite(`[{ id: "a", q: "hello", want: "HELLO" }, { id: "b", q: "regrade", want: "REGRADE" }]`));
    const r = await runCli(["run", "s.suite.ts", "--json", "r.json"], cwd);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("ts-suite · agent");
    expect(r.stdout).toMatch(/✓ a\s+\d+ ms\s+isUpper ✓\s+matchesWant ✓/);
    expect(r.stdout).toContain("All 2 cases passed.");
  });

  it.skipIf(!hasTs)("a failing inline scorer fails the case (exit 1) with its reasoning", async () => {
    const cwd = workdir();
    write(cwd, "helper.ts", helper);
    write(cwd, "s.suite.ts", tsSuite(`[{ id: "a", q: "hello", want: "HELLO" }, { id: "b", q: "regrade", want: "SOMETHING ELSE" }]`));
    const r = await runCli(["run", "s.suite.ts"], cwd);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/✗ b\s+\d+ ms\s+isUpper ✓\s+matchesWant ✗ \(want SOMETHING ELSE\)/);
    const db = new Database(join(cwd, ".regrade", "results.db"), { readonly: true });
    expect(db.prepare("SELECT scorer_name FROM scores WHERE pass = 0").pluck().all()).toEqual(["matchesWant"]);
    db.close();
  });

  it("runs a plain JavaScript (.mjs) suite on any supported Node", async () => {
    const cwd = workdir();
    write(
      cwd,
      "s.suite.mjs",
      `export default { name: "mjs-suite", pipeline: { run: (i) => "echo " + i }, scorers: { hasEcho: ({ output }) => output.startsWith("echo") }, cases: [{ id: "a", input: "x", scorers: ["hasEcho"] }] };`,
    );
    const r = await runCli(["run", "s.suite.mjs"], cwd);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("mjs-suite · function");
  });

  describe("module type of the surrounding project", () => {
    const esmSuite = `export default { name: "m", pipeline: { run: () => "x" }, cases: [{ id: "a", input: "i", scorers: ["latencyCost"] }] };\n`;
    const tsSuiteBody = `import type { CodeSuite } from "regrade";\nexport default { name: "m", pipeline: { run: (i: unknown): string => "x" + String(i) }, cases: [{ id: "a", input: "i", scorers: ["latencyCost"] }] } satisfies CodeSuite;\n`;
    const pkg = (type: string) => JSON.stringify({ name: "proj", version: "1.0.0", type });

    it.skipIf(!hasTs)('in an explicitly CommonJS project ("type": "commonjs", the npm init default), .mts and .mjs work', async () => {
      const cwd = workdir();
      write(cwd, "package.json", pkg("commonjs"));
      write(cwd, "s.mts", tsSuiteBody);
      write(cwd, "s.mjs", esmSuite);
      expect((await runCli(["run", "s.mts"], cwd)).code).toBe(0);
      expect((await runCli(["run", "s.mjs"], cwd)).code).toBe(0);
    });

    it.skipIf(!hasTs)("in an explicitly CommonJS project a plain .ts suite fails with a message that says how to fix it (exit 2)", async () => {
      const cwd = workdir();
      write(cwd, "package.json", pkg("commonjs"));
      write(cwd, "s.ts", tsSuiteBody);
      const r = await runCli(["run", "s.ts"], cwd);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Failed to load suite module s.ts");
      expect(r.stderr).toContain('does not say "type": "module"');
      expect(r.stderr).toContain("Rename it to .mts / .mjs");
    });

    it.skipIf(!hasTs)('with "type": "module", a plain .ts suite works', async () => {
      const cwd = workdir();
      write(cwd, "package.json", pkg("module"));
      write(cwd, "s.ts", tsSuiteBody);
      expect((await runCli(["run", "s.ts"], cwd)).code).toBe(0);
    });

    it.skipIf(!hasTs)("regrade init --ts works inside a CommonJS project", async () => {
      const cwd = workdir();
      write(cwd, "package.json", pkg("commonjs"));
      expect((await runCli(["init", "--ts"], cwd)).code).toBe(0);
      const r = await runCli(["run", "regrade/suite.mts"], cwd);
      expect(r.stderr).toBe("");
      expect(r.code).toBe(0);
    });
  });

  it.skipIf(!hasTs)("regrade init --ts scaffolds a suite that runs immediately with no server and no key", async () => {
    const cwd = workdir();
    const init = await runCli(["init", "--ts"], cwd);
    expect(init.code).toBe(0);
    expect(existsSync(join(cwd, "regrade", "suite.mts"))).toBe(true);
    expect(existsSync(join(cwd, "regrade", "mock-pipeline.mjs"))).toBe(false);
    const r = await runCli(["run", "regrade/suite.mts"], cwd);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("my-first-code-suite · my-agent");
    expect(r.stdout).toContain("All 2 cases passed.");
  });

  it("records the run (with the function pipeline's name) and marks edited scorers as modified in compare", async () => {
    const cwd = workdir();
    const make = (n: number) => `export default { name: "s", pipeline: { name: "agent", run: () => "abcd" }, scorers: { long: ({ output }) => output.length > ${n} }, cases: [${"{ id: 'c1', input: 'q', scorers: ['long'] },".repeat(1)}] };`;
    write(cwd, "v1.mjs", make(3));
    write(cwd, "v2.mjs", make(9));
    expect((await runCli(["run", "v1.mjs"], cwd)).code).toBe(0);
    expect((await runCli(["run", "v2.mjs"], cwd)).code).toBe(1);
    const c = await runCli(["compare", "--fail-on-regression"], cwd);
    expect(c.stdout).toMatch(/modified\s+c1/);
    expect(c.stdout).toContain("regressed 0");
    expect(c.code).toBe(0); // the scorer's logic changed, so this is not a regression
  });

  it("a pipeline function that never resolves times out (exit 1) instead of hanging", async () => {
    const cwd = workdir();
    write(cwd, "hang.mjs", `export default { name: "s", pipeline: { run: () => new Promise(() => {}) }, cases: [{ id: "a", input: "x", scorers: ["latencyCost"] }] };`);
    const r = await runCli(["run", "hang.mjs", "--timeout", "200"], cwd);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain("timed out");
    expect(r.ms).toBeLessThan(8000);
  });

  it("an inline scorer that never resolves times out (exit 1) instead of hanging the CLI", async () => {
    const cwd = workdir();
    write(cwd, "hang-scorer.mjs", `export default { name: "s", pipeline: { run: () => "x" }, scorers: { hangs: () => new Promise(() => {}) }, cases: [{ id: "a", input: "x", scorers: ["hangs"] }] };`);
    const r = await runCli(["run", "hang-scorer.mjs", "--timeout", "200"], cwd);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/hangs .*timed out \(limit 200 ms\)/);
    expect(r.ms).toBeLessThan(8000);
  });

  it("user code that leaves a timer running cannot keep the CLI alive, and the exit code is preserved", async () => {
    const cwd = workdir();
    write(cwd, "leak.mjs", `setInterval(() => {}, 1000); export default { name: "s", pipeline: { run: () => "no" }, scorers: { yes: ({ output }) => output === "yes" }, cases: [{ id: "a", input: "x", scorers: ["yes"] }] };`);
    const r = await runCli(["run", "leak.mjs"], cwd);
    expect(r.code).toBe(1); // the case failed; the leaked interval did not change that
    expect(r.stdout).toContain("1 of 1 cases did not pass.");
    expect(r.ms).toBeLessThan(10_000);
  });

  describe("errors exit 2 before anything runs", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["a module with no default export", "export const nope = 1;", /must `export default` a suite/],
      ["a syntax error", "export default {", /Failed to load suite module/],
      ["an unknown scorer", `export default { name: "s", pipeline: { run: () => "x" }, cases: [{ id: "a", input: "i", scorers: ["ghost"] }] };`, /unknown scorer "ghost"/],
      ["an inline scorer shadowing a built-in", `export default { name: "s", pipeline: { run: () => "x" }, scorers: { latencyCost: () => true }, cases: [{ id: "a", input: "i", scorers: ["latencyCost"] }] };`, /would replace a scorer with the same name/],
    ];
    it.each(cases)("%s", async (_label, body, pattern) => {
      const cwd = workdir();
      write(cwd, "bad.mjs", body);
      const r = await runCli(["run", "bad.mjs"], cwd);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(pattern);
      expect(existsSync(join(cwd, ".regrade"))).toBe(false); // nothing created
    });

    it("an unsupported extension", async () => {
      const cwd = workdir();
      mkdirSync(join(cwd, "d"));
      write(cwd, "s.yaml", "name: x");
      const r = await runCli(["run", "s.yaml"], cwd);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('Unsupported suite file type ".yaml"');
    });

    it.skipIf(!hasTs)("a TypeScript suite importing a sibling without its .ts extension gets an actionable hint", async () => {
      const cwd = workdir();
      write(cwd, "helper.ts", helper);
      write(cwd, "s.ts", `import { shout } from "./helper"; export default { name: "s", pipeline: { run: (i) => shout(String(i)) }, cases: [{ id: "a", input: "i", scorers: ["latencyCost"] }] };`);
      const r = await runCli(["run", "s.ts"], cwd);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("write the extension in the import");
    });
  });
});
