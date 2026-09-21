import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { Socket } from "node:net";

export interface MockRequest {
  input: unknown;
  headers: IncomingHttpHeaders;
  method: string;
  url: string;
}

export interface MockPipeline {
  url: string;
  port: number;
  requests: MockRequest[];
  /** Highest number of requests observed in flight at the same time. */
  maxInFlight(): number;
  close(): Promise<void>;
}

const ANSWERS: Record<string, string> = {
  "what is the capital of france?": "Paris",
  "what is 2 + 2?": "4",
};

/**
 * A pipeline that misbehaves on purpose. The input string selects the behaviour:
 *   FAIL:500        always HTTP 500
 *   FAIL:429-once   HTTP 429 (Retry-After: 0) on the first call for that input, then OK
 *   FAIL:hang       never responds
 *   FAIL:badjson    200 with a body that is not JSON
 *   FAIL:nooutput   200 with JSON that has no "output"
 *   FLAKY           alternates "Paris" / "London" per call (deterministic non-determinism)
 *   SLOW:<ms>       answers "Paris" after <ms>
 *   COST            answers "ok" and self-reports usage, costUsd and steps
 *   ECHO:<text>     answers <text>
 * Any URL with ?mode=degraded answers every ordinary question with "I don't know." (a pipeline that got worse).
 * Anything else: a small Q&A table, else "I don't know."
 */
export async function startMockPipeline(): Promise<MockPipeline> {
  const requests: MockRequest[] = [];
  const perInput = new Map<string, number>();
  const sockets = new Set<Socket>();
  let inFlight = 0;
  let maxInFlight = 0;

  const server: Server = createServer((req, res) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const done = () => {
      inFlight--;
    };
    res.on("close", done);

    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const reqUrl = new URL(req.url ?? "/", "http://localhost");
      if (reqUrl.pathname !== "/pipeline") {
        requests.push({ input: undefined, headers: req.headers, method: req.method ?? "", url: req.url ?? "" });
        res.writeHead(404, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ error: "not found" }));
      }
      let input: unknown;
      try {
        input = (JSON.parse(body) as { input?: unknown }).input;
      } catch {
        input = undefined;
      }
      requests.push({ input, headers: req.headers, method: req.method ?? "", url: req.url ?? "" });
      const text = typeof input === "string" ? input : "";
      const n = (perInput.get(text) ?? 0) + 1;
      perInput.set(text, n);

      const json = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { "content-type": "application/json", ...headers });
        res.end(JSON.stringify(payload));
      };

      if (text === "FAIL:500") return json(500, { error: "boom" });
      if (text === "FAIL:429-once" && n === 1) return json(429, { error: "slow down" }, { "retry-after": "0" });
      if (text === "FAIL:hang") return; // never respond
      if (text === "FAIL:badjson") {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end("not json {");
      }
      if (text === "FAIL:nooutput") return json(200, { result: "x" });
      if (text === "FLAKY") return json(200, { output: n % 2 === 1 ? "Paris" : "London" });
      if (text.startsWith("SLOW:")) {
        const ms = Number(text.slice(5));
        return void setTimeout(() => json(200, { output: "Paris" }), ms);
      }
      if (text === "COST") {
        return json(200, {
          output: "ok",
          costUsd: 0.002,
          usage: { inputTokens: 10, outputTokens: 5 },
          steps: [{ kind: "retrieval", name: "search", durationMs: 12 }],
          metadata: { model: "mock-1" },
        });
      }
      if (text.startsWith("ECHO:")) return json(200, { output: text.slice(5) });

      if (reqUrl.searchParams.get("mode") === "degraded") return json(200, { output: "I don't know." });

      const key = text.trim().toLowerCase();
      const output = key.startsWith("summarize:") ? "A quick fox jumps over a lazy dog." : (ANSWERS[key] ?? "I don't know.");
      return json(200, { output });
    });
  });

  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;

  return {
    url: `http://127.0.0.1:${port}/pipeline`,
    port,
    requests,
    maxInFlight: () => maxInFlight,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}
