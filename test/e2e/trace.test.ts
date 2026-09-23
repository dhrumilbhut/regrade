import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startMockPipeline, type MockPipeline } from "../fixtures/mock-pipeline.js";

const root = resolve(import.meta.dirname, "..", "..");
const cli = join(root, "dist", "cli.js");
const lib = pathToFileURL(join(root, "dist", "index.js")).href;
const hasTs = ["strip", "transform"].includes(String((process.features as { typescript?: unknown }).typescript));

interface CliResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd: string, env: Record<string, string> = {}): Promise<CliResult> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env: { ...process.env, NO_COLOR: "1", CI: "1", ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolvePromise({ code, stdout, stderr }));
  });
}

let mock: MockPipeline;
const dirs: string[] = [];
beforeAll(async () => {
  expect(existsSync(cli), "dist/cli.js is missing: run `npm run build`").toBe(true);
  mock = await startMockPipeline();
});
afterAll(async () => {
  await mock.close();
});
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const workdir = () => {
  const d = mkdtempSync(join(tmpdir(), "regrade-e2e4-"));
  dirs.push(d);
  return d;
};
const runId = (out: string): string => /run ([0-9a-f]{8}) saved/.exec(out)?.[1] ?? "";

function agentSuite(dir: string): string {
  const path = join(dir, "agent.json");
  writeFileSync(
    path,
    JSON.stringify({
      name: "agent-suite",
      pipeline: { adapter: "http", config: { url: "${PIPELINE_URL}" } },
      cases: [
        {
          id: "order-status",
          input: "AGENT",
          scorers: ["toolCalled", "maxSteps"],
          scorerConfig: { toolCalled: { tool: "lookup_order", argsInclude: { orderId: 123 } }, maxSteps: { max: 5, kind: "retrieval" } },
        },
      ],
    }),
  );
  return path;
}

describe("traces (built binary)", () => {
  it("an agent that stops calling its tool and loops fails its trace checks; show, report and export carry the trace", async () => {
    const cwd = workdir();
    const suite = agentSuite(cwd);
    const good = await runCli(["run", suite], cwd, { PIPELINE_URL: mock.url });
    expect(good.code).toBe(0);
    expect(good.stdout).toContain("toolCalled ✓");

    const bad = await runCli(["run", suite], cwd, { PIPELINE_URL: `${mock.url}?mode=degraded` });
    expect(bad.code).toBe(1);
    const show = await runCli(["show", runId(bad.stdout), "order-status"], cwd);
    expect(show.stdout).toContain('"lookup_order" with {"orderId":123} was never called (no tools were called)');
    expect(show.stdout).toContain("6 retrieval steps, over the maximum of 5");
    expect(show.stdout).toContain("trace  7 steps");

    const detail = await runCli(["show", runId(good.stdout), "order-status", "--full"], cwd);
    expect(detail.stdout).toContain("lookup_order");
    expect(detail.stdout).toContain('"orderId": 123');
    expect(detail.stdout).not.toContain("sk-live"); // masked before storing

    const html = await runCli(["report", runId(good.stdout), "--out", "r.html"], cwd);
    expect(html.code).toBe(0);
    expect(readFileSync(join(cwd, "r.html"), "utf8")).toContain('"name":"lookup_order"');

    await runCli(["export", runId(good.stdout), "--out", "run.json"], cwd);
    expect(readFileSync(join(cwd, "run.json"), "utf8")).toContain('"name": "lookup_order"');

    const cmp = await runCli(["compare", "--fail-on-regression"], cwd);
    expect(cmp.code).toBe(1);
    expect(cmp.stdout).toContain("regressed order-status");
  });

  it("--no-trace keeps traces out of the database; the trace checks still run", async () => {
    const cwd = workdir();
    const r = await runCli(["run", agentSuite(cwd), "--no-trace"], cwd, { PIPELINE_URL: mock.url });
    expect(r.code).toBe(0);
    const db = new Database(join(cwd, ".regrade", "results.db"), { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS n FROM traces").get()).toEqual({ n: 0 });
    db.close();
  });

  it.skipIf(!hasTs)("a TypeScript code suite records steps with tracer() and checks them", async () => {
    const cwd = workdir();
    writeFileSync(
      join(cwd, "agent.suite.mts"),
      `import { tracer } from ${JSON.stringify(lib)};

async function agent(question: string) {
  const t = tracer();
  const answer = await t.step("agent", "support-agent", async () => {
    const docs = await t.step("retrieval", "search", async () => ["policy #12"], { input: { query: question } });
    await t.step("tool", "lookup_order", async () => ({ status: "shipped" }), { input: { orderId: 123 } });
    return t.step("llm", "answer", async () => "Shipped, see " + docs[0]);
  });
  return { output: answer, steps: t.steps };
}

export default {
  name: "tracer-suite",
  pipeline: { run: (input: unknown) => agent(String(input)) },
  cases: [
    { id: "calls-lookup", input: "Where is order 123?", scorers: ["toolCalled", "maxSteps"],
      scorerConfig: { toolCalled: { tool: "lookup_order", argsInclude: { orderId: 123 } }, maxSteps: { max: 4 } } },
    { id: "never-cancels", input: "Where is order 123?", scorers: ["toolCalled"], scorerConfig: { toolCalled: { tool: "cancel_order", not: true } } },
  ],
};
`,
    );
    const r = await runCli(["run", "agent.suite.mts"], cwd);
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("All 2 cases passed.");
    const show = await runCli(["show", runId(r.stdout), "calls-lookup"], cwd);
    expect(show.stdout).toMatch(/agent {5}support-agent/);
    expect(show.stdout).toMatch(/ {8}tool {6}lookup_order/);
  });
});
