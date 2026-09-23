#!/usr/bin/env node
// Generates the public sample report: runs the same suite twice against an in-process mock
// pipeline ("v1", then a deliberately degraded "v2") and writes a comparison report.
//
//   npm run build && node scripts/sample-report.mjs [--out site]
//
// Everything is deterministic and needs no API keys, so CI can publish the result.
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildRunReport, compareRuns, createRegistry, regressionGate, renderCompareMarkdown, renderComparison,
  renderHtmlReport, renderRunMarkdown, runSuite, SqliteStore,
} from "../dist/index.js";
import pkg from "../package.json" with { type: "json" };

const outDir = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1] : "site";
mkdirSync(outDir, { recursive: true });

// question -> [correct answer, v2 behaviour]
const QA = {
  "What is the capital of France?": ["Paris", "same"],
  "What is 2 + 2?": ["4", "same"],
  "Who wrote Hamlet?": ["William Shakespeare", "Christopher Marlowe"],
  "What is the boiling point of water in Celsius?": ["100", "same"],
  "What is the largest planet?": ["Jupiter", "same"],
  "What is the chemical symbol for gold?": ["Au", "flaky-wrong"],
  "How many days are in a leap year?": ["366", "slow"],
  "What language is spoken in Brazil?": ["Portuguese", "same"],
  "How many days do customers have to request a refund?": ["30 days", "60 days"],
  "What is the largest ocean?": ["Pacific", "flaky"],
  "Is Pluto classified as a planet?": ["No", "same"],
  "What is the speed of light in km/s?": ["299,792 km/s", "same"],
};
let version = "v1";
const calls = new Map();
const server = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const input = JSON.parse(body).input;
    const n = (calls.get(`${version}:${input}`) ?? 0) + 1;
    calls.set(`${version}:${input}`, n);
    const [correct, v2] = QA[input] ?? ["I don't know.", "same"];
    let output = correct;
    let delay = 15 + (n % 5) * 8;
    if (version === "v1" && input.startsWith("Is Pluto")) output = "Yes";        // v1 is wrong here: v2 improves
    if (version === "v1" && v2 === "flaky") output = n % 2 ? correct : "Arctic";   // flaky in both versions
    if (version === "v2") {
      if (v2 === "flaky") output = n % 2 ? correct : "Arctic";
      else if (v2 === "flaky-wrong") output = n % 2 ? "Ag" : correct;             // right only on even attempts
      else if (v2 === "slow") delay = 650;
      else if (v2 !== "same") output = v2;
    }
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output }));
    }, delay);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/pipeline`;

const IDS = ["capital-of-france", "simple-math", "author-of-hamlet", "boiling-point", "largest-planet", "symbol-for-gold", "leap-year-days", "brazil-language", "refund-window", "largest-ocean", "is-pluto-a-planet", "speed-of-light"];
const tags = { "Who wrote Hamlet?": ["trivia"], "How many days do customers have to request a refund?": ["policy"] };
const suite = {
  name: "support-bot",
  description: "Sample suite: the same 12 questions run against two versions of a pipeline.",
  defaults: { repeat: 5, concurrency: 8 },
  pipeline: { adapter: "http", config: { url } },
  cases: Object.entries(QA).map(([question, [expected]], i) => ({
    id: IDS[i],
    input: question,
    expected,
    tags: tags[question] ?? ["smoke"],
    scorers: ["exactMatch", "latencyCost"],
    scorerConfig: { latencyCost: { maxLatencyMs: 500 } },
  })),
};

const registry = createRegistry();
const store = new SqliteStore(":memory:");
const run = async (v, label) => {
  version = v;
  return runSuite({ suite, registry, store, regradeVersion: pkg.version, overrides: { label } });
};
const base = await run("v1", "prompt-v1");
const head = await run("v2", "prompt-v2");
server.close();

const cmp = compareRuns({ base: { run: base.run, attempts: base.attempts }, head: { run: head.run, attempts: head.attempts } });
const gate = regressionGate(cmp);
const headReport = buildRunReport(head.run, head.attempts);

// On the website, a thin bar leads back to the docs; `regrade report` itself never adds it.
const siteBar = outDir.replace(/\\/g, "/").endsWith("/sample")
  ? `<div style="border-bottom:1px solid var(--border);background:var(--surface);font-size:13.5px;color:var(--ink2)"><div style="max-width:1120px;margin:0 auto;padding:10px 20px;display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center"><a href="../" style="color:var(--accent);text-decoration:none;font-weight:600">← Regrade docs</a><span>A sample of the single-file report that <code>regrade report</code> writes: a healthy pipeline compared with a degraded one.</span></div></div>`
  : "";
writeFileSync(join(outDir, "index.html"), renderHtmlReport({ report: headReport, comparison: cmp, version: pkg.version }).replace("<body>", `<body>${siteBar}`));
writeFileSync(join(outDir, "compare.md"), renderCompareMarkdown(cmp, gate, pkg.version));
writeFileSync(join(outDir, "run.md"), renderRunMarkdown(headReport, pkg.version));
writeFileSync(join(outDir, "report.json"), JSON.stringify({ report: headReport, comparison: cmp }, null, 2));
process.stdout.write(renderComparison(cmp, { color: false, gate }));
process.stdout.write(`\nwritten to ${outDir}/ (index.html, compare.md, run.md, report.json)\n`);
store.close();
