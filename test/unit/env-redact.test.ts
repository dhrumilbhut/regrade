import { describe, expect, it } from "vitest";
import { resolveEnv } from "../../src/core/env.js";
import { ConfigError } from "../../src/core/errors.js";
import { stableHash, stableStringify } from "../../src/core/hash.js";
import { redactConfig, REDACTED } from "../../src/core/redact.js";

describe("resolveEnv", () => {
  it("substitutes ${VAR} in nested strings", () => {
    const out = resolveEnv({ url: "http://${HOST}/p", headers: { a: ["x-${K}"] }, n: 3 }, { HOST: "h", K: "k" }, "cfg");
    expect(out).toEqual({ url: "http://h/p", headers: { a: ["x-k"] }, n: 3 });
  });

  it("uses ${VAR:-default} when the variable is unset or empty", () => {
    expect(resolveEnv("${A:-fallback}", {}, "cfg")).toBe("fallback");
    expect(resolveEnv("${A:-fallback}", { A: "" }, "cfg")).toBe("fallback");
    expect(resolveEnv("${A:-fallback}", { A: "set" }, "cfg")).toBe("set");
  });

  it("reports every missing variable in one error", () => {
    try {
      resolveEnv({ a: "${ONE}", b: "${TWO}", c: "${ONE}" }, {}, "pipeline.config");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as Error).message).toContain("pipeline.config");
      expect((e as Error).message).toContain("ONE, TWO");
    }
  });

  it("does not mutate its input", () => {
    const input = { a: "${X}" };
    resolveEnv(input, { X: "1" }, "cfg");
    expect(input.a).toBe("${X}");
  });
});

describe("redactConfig", () => {
  it("keeps ${ENV} placeholders and masks literal secrets", () => {
    const { value, masked } = redactConfig({
      url: "http://x",
      headers: { Authorization: "Bearer sk-live-123", "X-Api-Key": "${MY_KEY}" },
      apiKey: "abc",
    });
    expect(value.headers.Authorization).toBe(REDACTED);
    expect(value.headers["X-Api-Key"]).toBe("${MY_KEY}");
    expect(value.apiKey).toBe(REDACTED);
    expect(value.url).toBe("http://x");
    expect(masked.sort()).toEqual(["apiKey", "headers.Authorization"]);
  });

  it("does not mask the name of an env var (apiKeyEnv)", () => {
    expect(redactConfig({ apiKeyEnv: "MY_KEY_VAR" }).value.apiKeyEnv).toBe("MY_KEY_VAR");
  });

  it("leaves numbers under secret-looking keys alone (maxTokens)", () => {
    expect(redactConfig({ maxTokens: 512 }).value.maxTokens).toBe(512);
  });
});

describe("stable hashing", () => {
  it("is independent of key order", () => {
    expect(stableStringify({ b: 1, a: { d: 1, c: 2 } })).toBe(stableStringify({ a: { c: 2, d: 1 }, b: 1 }));
    expect(stableHash({ a: 1, b: 2 })).toBe(stableHash({ b: 2, a: 1 }));
  });
  it("changes when content changes", () => {
    expect(stableHash({ a: 1 })).not.toBe(stableHash({ a: 2 }));
  });
});
