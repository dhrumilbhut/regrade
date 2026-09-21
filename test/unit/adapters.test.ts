import { afterEach, describe, expect, it } from "vitest";
import { anthropicAdapter } from "../../src/adapters/anthropicAdapter.js";
import { httpAdapter } from "../../src/adapters/httpAdapter.js";
import { openaiAdapter } from "../../src/adapters/openaiAdapter.js";
import { renderTemplate, toMessages } from "../../src/adapters/common.js";
import { AdapterError, ConfigError } from "../../src/core/errors.js";
import type { AdapterContext } from "../../src/core/types.js";
import { defaultPrices } from "../../src/pricing/cost.js";
import { startMockPipeline, type MockPipeline } from "../fixtures/mock-pipeline.js";
import { startStubLlm, type StubLlm } from "../fixtures/stub-llm.js";
import { rejectionOf, signal } from "../helpers.js";

let mock: MockPipeline | undefined;
let stub: StubLlm | undefined;
afterEach(async () => {
  await mock?.close();
  await stub?.close();
  mock = stub = undefined;
});

const ctx = (over: Partial<AdapterContext> = {}): AdapterContext => ({
  signal: signal(),
  caseId: "c",
  attempt: 1,
  env: {},
  prices: defaultPrices(),
  ...over,
});

const cfg = (extra: Record<string, unknown> = {}) => ({ url: mock!.url, retries: 2, retryBaseDelayMs: 1, ...extra });

describe("httpAdapter", () => {
  it("POSTs { input } and returns the output with a measured latency", async () => {
    mock = await startMockPipeline();
    const r = await httpAdapter.run("What is the capital of France?", cfg(), ctx());
    expect(r.output).toBe("Paris");
    expect(r.latencyMs).toBeGreaterThanOrEqual(0);
    expect(r.costUsd).toBeNull();
    expect(mock.requests[0]).toMatchObject({ method: "POST", input: "What is the capital of France?" });
    expect(mock.requests[0]?.headers["content-type"]).toContain("application/json");
  });

  it("sends structured inputs verbatim", async () => {
    mock = await startMockPipeline();
    const input = { messages: [{ role: "user" as const, content: "hi" }] };
    await httpAdapter.run(input, cfg(), ctx());
    expect(mock.requests[0]?.input).toEqual(input);
  });

  it("sends configured headers", async () => {
    mock = await startMockPipeline();
    await httpAdapter.run("x", cfg({ headers: { authorization: "Bearer t", "x-team": "a" } }), ctx());
    expect(mock.requests[0]?.headers.authorization).toBe("Bearer t");
    expect(mock.requests[0]?.headers["x-team"]).toBe("a");
  });

  it("accepts self-reported cost, usage, steps and metadata", async () => {
    mock = await startMockPipeline();
    const r = await httpAdapter.run("COST", cfg(), ctx());
    expect(r).toMatchObject({
      output: "ok",
      costUsd: 0.002,
      usage: { inputTokens: 10, outputTokens: 5 },
      steps: [{ kind: "retrieval", name: "search", durationMs: 12 }],
    });
    expect(r.metadata).toMatchObject({ model: "mock-1", retries: 0, httpStatus: 200 });
  });

  it("retries a 429 (honouring Retry-After) and reports the retry", async () => {
    mock = await startMockPipeline();
    const r = await httpAdapter.run("FAIL:429-once", cfg(), ctx());
    expect(r.output).toBe("I don't know.");
    expect(r.metadata?.retries).toBe(1);
    expect(mock.requests).toHaveLength(2);
  });

  it("retries a 500 the configured number of times, then fails with the status", async () => {
    mock = await startMockPipeline();
    const err = await rejectionOf(httpAdapter.run("FAIL:500", cfg(), ctx()));
    expect(err).toBeInstanceOf(AdapterError);
    expect(err.message).toContain("HTTP 500");
    expect(mock.requests).toHaveLength(3); // 1 + 2 retries
  });

  it("does not retry when retries is 0", async () => {
    mock = await startMockPipeline();
    await expect(httpAdapter.run("FAIL:500", cfg({ retries: 0 }), ctx())).rejects.toThrow("HTTP 500");
    expect(mock.requests).toHaveLength(1);
  });

  it("does not retry a 4xx", async () => {
    mock = await startMockPipeline();
    await expect(httpAdapter.run("x", cfg({ url: `${mock.url}-missing` }), ctx())).rejects.toThrow("HTTP 404");
    expect(mock.requests).toHaveLength(1);
  });

  it("fails clearly on invalid JSON and on a missing output field", async () => {
    mock = await startMockPipeline();
    await expect(httpAdapter.run("FAIL:badjson", cfg(), ctx())).rejects.toThrow("not valid JSON");
    await expect(httpAdapter.run("FAIL:nooutput", cfg(), ctx())).rejects.toThrow('missing a string "output" field');
  });

  it("supports a custom output field", async () => {
    mock = await startMockPipeline();
    await expect(httpAdapter.run("FAIL:nooutput", cfg({ outputField: "result" }), ctx())).resolves.toMatchObject({ output: "x" });
  });

  it("times out on a hanging pipeline via the abort signal", async () => {
    mock = await startMockPipeline();
    const err = await rejectionOf(httpAdapter.run("FAIL:hang", cfg(), ctx({ signal: AbortSignal.timeout(150) })));
    expect(err).toBeInstanceOf(AdapterError);
    expect(err.message).toContain("timed out");
  });

  it("reports a connection failure as a retryable network error", async () => {
    mock = await startMockPipeline();
    const url = mock.url;
    await mock.close();
    mock = undefined;
    const err = await rejectionOf(httpAdapter.run("x", { url, retries: 0 }, ctx()));
    expect(err.message).toContain("network error");
    expect(err.retryable).toBe(true);
  });

  it("never puts a URL query string into an error message", async () => {
    mock = await startMockPipeline();
    const err = await rejectionOf(httpAdapter.run("FAIL:500", cfg({ url: `${mock.url}?token=SECRET`, retries: 0 }), ctx()));
    expect(err.message).not.toContain("SECRET");
  });

  it("preflight validates the config", () => {
    expect(() => httpAdapter.preflight!({}, [], {})).toThrow(ConfigError);
    expect(() => httpAdapter.preflight!({ url: "not a url" }, [], {})).toThrow(/pipeline\.config\.url/);
    expect(() => httpAdapter.preflight!({ url: "http://x", typo: 1 }, [], {})).toThrow(/typo/i);
    expect(() => httpAdapter.preflight!({ url: "http://x" }, [], {})).not.toThrow();
  });
});

describe("input mapping", () => {
  it("maps a string to one user message, and prepends a system prompt", () => {
    expect(toMessages("hi", { system: "be brief" })).toEqual([
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });

  it("passes {messages} through", () => {
    const messages = [{ role: "user" as const, content: "a" }, { role: "assistant" as const, content: "b" }, { role: "user" as const, content: "c" }];
    expect(toMessages({ messages }, {})).toEqual(messages);
  });

  it("needs a template for other objects, and renders {{key}} paths", () => {
    expect(() => toMessages({ q: "x" }, {})).toThrow(/inputTemplate/);
    expect(toMessages({ q: "why?", ctx: { doc: "D" } }, { inputTemplate: "Q: {{q}}\nDoc: {{ctx.doc}}" })).toEqual([
      { role: "user", content: "Q: why?\nDoc: D" },
    ]);
    expect(renderTemplate("{{input}}", "plain")).toBe("plain");
    expect(renderTemplate("{{missing}}", { a: 1 })).toBe("");
  });
});

describe("anthropicAdapter", () => {
  const reply = { text: "Paris", usage: { input: 1000, output: 500, cacheRead: 2000, cacheWrite: 300 } };

  it("calls the Messages API, maps usage, and prices cache tokens", async () => {
    stub = await startStubLlm(() => reply);
    const env = { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: stub.anthropicBaseUrl };
    const r = await anthropicAdapter.run("hi", { model: "claude-opus-5", system: "be brief", maxTokens: 64 }, ctx({ env }));

    expect(r.output).toBe("Paris");
    expect(r.usage).toMatchObject({ inputTokens: 1000, outputTokens: 500, cachedInputTokens: 2000, cacheWriteTokens: 300 });
    // Opus 5: in $5, out $25, cache read $0.50, 5m cache write $6.25 per million
    expect(r.costUsd).toBeCloseTo((1000 * 5 + 500 * 25 + 2000 * 0.5 + 300 * 6.25) / 1e6, 10);

    const req = stub.requests[0]!;
    expect(req.headers["x-api-key"]).toBe("k");
    expect(req.headers["anthropic-version"]).toBeTruthy();
    expect(req.body).toMatchObject({ model: "claude-opus-5", max_tokens: 64, system: "be brief", messages: [{ role: "user", content: "hi" }] });
  });

  it("always sends max_tokens (required by the API), defaulting to 1024", async () => {
    stub = await startStubLlm(() => reply);
    const env = { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: stub.anthropicBaseUrl };
    await anthropicAdapter.run("hi", { model: "claude-opus-5" }, ctx({ env }));
    expect(stub.requests[0]?.body.max_tokens).toBe(1024);
  });

  it("lifts system messages out of a {messages} input", async () => {
    stub = await startStubLlm(() => reply);
    const env = { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: stub.anthropicBaseUrl };
    await anthropicAdapter.run(
      { messages: [{ role: "system", content: "sys" }, { role: "user", content: "u" }] },
      { model: "claude-opus-5" },
      ctx({ env }),
    );
    expect(stub.requests[0]?.body).toMatchObject({ system: "sys", messages: [{ role: "user", content: "u" }] });
  });

  it("reports unknown cost as null for an unpriced model", async () => {
    stub = await startStubLlm(() => reply);
    const env = { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: stub.anthropicBaseUrl };
    expect((await anthropicAdapter.run("hi", { model: "claude-brand-new" }, ctx({ env }))).costUsd).toBeNull();
  });

  it("treats a refusal as an error", async () => {
    stub = await startStubLlm(() => ({ refusal: true }));
    const env = { ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: stub.anthropicBaseUrl };
    await expect(anthropicAdapter.run("hi", { model: "m" }, ctx({ env }))).rejects.toThrow("refused");
  });

  it("preflight requires the API key (or the env var named by apiKeyEnv)", () => {
    expect(() => anthropicAdapter.preflight!({ model: "m" }, [], {})).toThrow(/ANTHROPIC_API_KEY is not set/);
    expect(() => anthropicAdapter.preflight!({ model: "m", apiKeyEnv: "MY_KEY" }, [], {})).toThrow(/MY_KEY is not set/);
    expect(() => anthropicAdapter.preflight!({ model: "m", apiKeyEnv: "MY_KEY" }, [], { MY_KEY: "x" })).not.toThrow();
  });

  it("preflight rejects object inputs that cannot become a prompt", () => {
    const env = { ANTHROPIC_API_KEY: "k" };
    expect(() => anthropicAdapter.preflight!({ model: "m" }, [{ id: "obj", input: { q: 1 } }], env)).toThrow(/inputTemplate.*obj/s);
    expect(() => anthropicAdapter.preflight!({ model: "m", inputTemplate: "{{q}}" }, [{ id: "obj", input: { q: 1 } }], env)).not.toThrow();
  });
});

describe("openaiAdapter", () => {
  it("calls Chat Completions and keeps usage categories disjoint (cached tokens are part of prompt_tokens)", async () => {
    stub = await startStubLlm(() => ({ text: "Paris", usage: { input: 800, output: 100, cacheRead: 200 } }));
    const env = { OPENAI_API_KEY: "k", OPENAI_BASE_URL: stub.openaiBaseUrl };
    const r = await openaiAdapter.run("hi", { model: "gpt-x", system: "s", maxTokens: 50, temperature: 0 }, ctx({ env }));

    expect(r.output).toBe("Paris");
    expect(r.usage).toMatchObject({ inputTokens: 800, cachedInputTokens: 200, outputTokens: 100 });
    expect(r.costUsd).toBeNull(); // no bundled OpenAI prices
    const req = stub.requests[0]!;
    expect(req.headers.authorization).toBe("Bearer k");
    expect(req.body).toMatchObject({ model: "gpt-x", temperature: 0, max_completion_tokens: 50 });
    expect(req.body.messages).toEqual([{ role: "system", content: "s" }, { role: "user", content: "hi" }]);
  });

  it("maps GPT-5.6 cache writes as a subset of prompt_tokens and prices them with the bundled table", async () => {
    stub = await startStubLlm(() => ({ text: "ok", usage: { input: 1000, output: 500, cacheRead: 4000, cacheWrite: 2000 } }));
    const env = { OPENAI_API_KEY: "k", OPENAI_BASE_URL: stub.openaiBaseUrl };
    const r = await openaiAdapter.run("hi", { model: "gpt-5.6-terra" }, ctx({ env }));
    expect(r.usage).toMatchObject({ inputTokens: 1000, cachedInputTokens: 4000, cacheWriteTokens: 2000, outputTokens: 500 });
    expect(r.costUsd).toBeCloseTo((1000 * 2 + 4000 * 0.2 + 2000 * 2.5 + 500 * 12) / 1e6, 10);
  });

  it("never reports negative input tokens if a provider's counters overlap", async () => {
    // prompt_tokens = 100 but cached 80 + written 60 (an accounting quirk seen in the wild)
    stub = await startStubLlm(() => ({ text: "ok", usage: { input: -40, output: 1, cacheRead: 80, cacheWrite: 60 } }));
    const env = { OPENAI_API_KEY: "k", OPENAI_BASE_URL: stub.openaiBaseUrl };
    const r = await openaiAdapter.run("hi", { model: "gpt-5.6-terra" }, ctx({ env }));
    expect(r.usage?.inputTokens).toBe(0);
  });

  it("prices calls when the user supplies prices", async () => {
    stub = await startStubLlm(() => ({ text: "x", usage: { input: 1000, output: 1000 } }));
    const env = { OPENAI_API_KEY: "k", OPENAI_BASE_URL: stub.openaiBaseUrl };
    const prices = { asOf: "t", entries: [{ provider: "openai", model: "gpt-x", inputPerMTok: 1, outputPerMTok: 2 }] };
    const r = await openaiAdapter.run("hi", { model: "gpt-x" }, ctx({ env, prices }));
    expect(r.costUsd).toBeCloseTo(0.003, 10);
  });

  it("can send the legacy max_tokens parameter for older compatible servers", async () => {
    stub = await startStubLlm(() => ({ text: "x" }));
    const env = { OPENAI_API_KEY: "k", OPENAI_BASE_URL: stub.openaiBaseUrl };
    await openaiAdapter.run("hi", { model: "m", maxTokens: 9, maxTokensParam: "max_tokens" }, ctx({ env }));
    expect(stub.requests[0]?.body).toMatchObject({ max_tokens: 9 });
    expect(stub.requests[0]?.body).not.toHaveProperty("max_completion_tokens");
  });

  it("retries a 5xx from the provider", async () => {
    let calls = 0;
    stub = await startStubLlm(() => (calls++ === 0 ? { status: 503 } : { text: "ok" }));
    const env = { OPENAI_API_KEY: "k", OPENAI_BASE_URL: stub.openaiBaseUrl };
    const r = await openaiAdapter.run("hi", { model: "m", retryBaseDelayMs: 1 }, ctx({ env }));
    expect(r.output).toBe("ok");
    expect(r.metadata?.retries).toBe(1);
  });
});
