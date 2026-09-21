// A tiny stand-in for your AI pipeline: POST { "input": "..." } -> { "output": "..." }.
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
}).listen(port, () => console.log(`mock pipeline listening on http://localhost:${port}/pipeline`));
