/**
 * Files written by `regrade init`. `examples/qa-http/mock-pipeline.mjs` must stay
 * identical to MOCK_PIPELINE (a test enforces it).
 */

export const INIT_SUITE = `{
  "$schema": "https://unpkg.com/regrade/schema/suite.schema.json",
  "name": "my-first-suite",
  "description": "Runs against the bundled mock pipeline. Point pipeline.config.url at your own endpoint.",
  "pipeline": {
    "adapter": "http",
    "config": { "url": "\${PIPELINE_URL:-http://localhost:4000/pipeline}" }
  },
  "cases": [
    {
      "id": "capital-of-france",
      "input": "What is the capital of France?",
      "expected": "Paris",
      "scorers": ["exactMatch", "latencyCost"],
      "scorerConfig": { "latencyCost": { "maxLatencyMs": 2000 } }
    },
    {
      "id": "simple-math",
      "input": "What is 2 + 2?",
      "expected": "4",
      "scorers": ["exactMatch"]
    }
  ]
}
`;

export const MOCK_PIPELINE = `// A tiny stand-in for your AI pipeline: POST { "input": "..." } -> { "output": "..." }.
// Run it with:  node regrade/mock-pipeline.mjs
import { createServer } from "node:http";

const answers = {
  "what is the capital of france?": "Paris",
  "what is 2 + 2?": "4",
};
const port = Number(process.env.PORT ?? 4000);

createServer((req, res) => {
  if (req.method !== "POST" || req.url !== "/pipeline") {
    res.writeHead(404).end();
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    let input = "";
    try {
      input = String(JSON.parse(body).input ?? "");
    } catch {}
    const key = input.trim().toLowerCase();
    const output = key.startsWith("summarize:")
      ? "A quick fox jumps over a lazy dog."
      : (answers[key] ?? "I don't know.");
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ output }));
    }, 50 + Math.random() * 150);
  });
}).listen(port, () => console.log(\`mock pipeline listening on http://localhost:\${port}/pipeline\`));
`;

export const INIT_TS_SUITE = `// A code-first suite. Run it with:  regrade run regrade/suite.mts
// TypeScript suites need Node 22.18+ (native type stripping). The .mts extension makes this an ES module whatever
// your package.json says; with "type": "module" you may rename it to suite.ts. Prefer JSON? Run \`regrade init\`.
import type { CodeSuite } from "regrade"; // type-only: erased at runtime, so no local install is needed to run it

// Replace this with a call into your real agent / RAG pipeline.
async function answer(question: string): Promise<string> {
  const known: Record<string, string> = {
    "what is the capital of france?": "Paris",
    "what is 2 + 2?": "4",
  };
  return known[question.trim().toLowerCase()] ?? "I don't know.";
}

export default {
  name: "my-first-code-suite",
  // Test a function in-process: no HTTP server, no API key. (Or use { adapter: "http", config: { url } }.)
  pipeline: { name: "my-agent", run: async (input) => answer(String(input)) },
  scorers: {
    // A custom scorer is just a function. Return true/false, or { pass, value, reasoning }.
    concise: ({ output }) => ({ pass: output.length <= 40, value: output.length, reasoning: \`\${output.length} characters\` }),
  },
  cases: [
    { id: "capital-of-france", input: "What is the capital of France?", expected: "Paris", scorers: ["exactMatch", "concise"] },
    { id: "simple-math", input: "What is 2 + 2?", expected: "4", scorers: ["exactMatch", "concise"] },
  ],
} satisfies CodeSuite;
`;
