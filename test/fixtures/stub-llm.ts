import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { Socket } from "node:net";

export type Provider = "anthropic" | "openai";

export interface StubUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface StubReply {
  /** Assistant text. */
  text?: string;
  /** Simulate a refusal. */
  refusal?: boolean;
  /** Respond with this HTTP error instead. */
  status?: number;
  /** Error message for `status` (default "stub error <status>"). */
  errorMessage?: string;
  usage?: StubUsage;
}

export interface StubRequest {
  provider: Provider;
  path: string;
  headers: IncomingHttpHeaders;
  body: Record<string, unknown>;
  /** The last user message's text. */
  prompt: string;
  system: string;
}

export interface StubLlm {
  /** Base URL for ANTHROPIC_BASE_URL (no /v1). */
  anthropicBaseUrl: string;
  /** Base URL for OPENAI_BASE_URL (with /v1). */
  openaiBaseUrl: string;
  requests: StubRequest[];
  close(): Promise<void>;
}

/** Text of the OUTPUT fence in a judge prompt (what the pipeline produced). */
export function extractOutputBlock(prompt: string): string | undefined {
  const m = /<<<OUTPUT:(\w+)\n([\s\S]*?)\nOUTPUT:\1>>>/.exec(prompt);
  return m?.[2];
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text: unknown }).text) : "")).join("");
  }
  return "";
}

/** A stand-in for the Anthropic Messages and OpenAI Chat Completions APIs. */
export async function startStubLlm(reply: (req: StubRequest) => StubReply): Promise<StubLlm> {
  const requests: StubRequest[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const path = req.url ?? "";
      const provider: Provider | undefined = path === "/v1/messages" ? "anthropic" : path === "/v1/chat/completions" ? "openai" : undefined;
      if (!provider || req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(raw) as Record<string, unknown>;
      const messages = (body.messages as Array<{ role: string; content: unknown }>) ?? [];
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const system =
        provider === "anthropic"
          ? messageText(body.system)
          : messages
              .filter((m) => m.role === "system")
              .map((m) => messageText(m.content))
              .join("\n");
      const stubReq: StubRequest = { provider, path, headers: req.headers, body, prompt: messageText(lastUser?.content), system };
      requests.push(stubReq);

      const r = reply(stubReq);
      if (r.status) {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: r.errorMessage ?? `stub error ${r.status}` } }));
        return;
      }
      const u = r.usage ?? { input: 100, output: 20 };
      res.writeHead(200, { "content-type": "application/json" });
      if (provider === "anthropic") {
        res.end(
          JSON.stringify({
            id: "msg_stub",
            type: "message",
            role: "assistant",
            model: body.model,
            content: r.refusal ? [] : [{ type: "text", text: r.text ?? "" }],
            stop_reason: r.refusal ? "refusal" : "end_turn",
            usage: {
              input_tokens: u.input,
              output_tokens: u.output,
              cache_read_input_tokens: u.cacheRead ?? 0,
              cache_creation_input_tokens: u.cacheWrite ?? 0,
            },
          }),
        );
      } else {
        res.end(
          JSON.stringify({
            id: "chatcmpl-stub",
            model: body.model,
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: r.refusal
                  ? { role: "assistant", content: null, refusal: "I can't help with that." }
                  : { role: "assistant", content: r.text ?? "" },
              },
            ],
            usage: {
              prompt_tokens: u.input + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0),
              completion_tokens: u.output,
              prompt_tokens_details: { cached_tokens: u.cacheRead ?? 0, cache_write_tokens: u.cacheWrite ?? 0 },
              completion_tokens_details: { reasoning_tokens: 0 },
            },
          }),
        );
      }
    });
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    anthropicBaseUrl: `http://127.0.0.1:${port}`,
    openaiBaseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

export type JudgeMode = "normal" | "freetext" | "refusal" | "badschema" | "http500" | "http400" | "fenced" | "notemperature";

/**
 * Judge stub: passes unless the OUTPUT block contains "WRONG". Modes simulate a
 * misbehaving judge: free text, refusal, schema-violating JSON, HTTP 500 or 400, or
 * valid JSON wrapped in a ``` fence. "notemperature" answers normally but, like newer
 * reasoning models, rejects any request that sets `temperature` with a 400.
 */
export function startStubJudge(mode: JudgeMode = "normal", verdictOf?: (output: string) => "pass" | "fail"): Promise<StubLlm> {
  const decide = verdictOf ?? ((o: string) => (o.includes("WRONG") ? "fail" : "pass"));
  return startStubLlm((req) => {
    if (mode === "http500") return { status: 500 };
    if (mode === "http400") return { status: 400, errorMessage: "Invalid value for 'max_completion_tokens'." };
    if (mode === "notemperature" && req.body.temperature !== undefined) {
      return {
        status: 400,
        errorMessage: "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.",
      };
    }
    if (mode === "refusal") return { refusal: true };
    if (mode === "freetext") return { text: "Looks good to me, PASS!" };
    if (mode === "badschema") return { text: JSON.stringify({ verdict: "maybe", reasoning: 3 }) };
    const output = extractOutputBlock(req.prompt) ?? "";
    const verdict = decide(output);
    const json = JSON.stringify({ reasoning: verdict === "pass" ? "Addresses the input." : "Does not address the input.", verdict });
    return { text: mode === "fenced" ? `\`\`\`json\n${json}\n\`\`\`` : json };
  });
}
