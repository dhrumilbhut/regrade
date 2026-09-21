import { describe, expect, it } from "vitest";
import { ConfigError } from "../../src/core/errors.js";
import { checkSuite, loadSuite, parseSuite, parseSuiteText } from "../../src/core/testSuite.js";
import { registry } from "../helpers.js";

const valid = {
  name: "s",
  pipeline: { adapter: "http", config: { url: "http://x" } },
  cases: [{ id: "a", input: "hi", expected: "yo", scorers: ["exactMatch"] }],
};

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ConfigError);
    return (e as Error).message;
  }
  throw new Error("expected a ConfigError");
}

describe("suite validation", () => {
  it("accepts a valid suite, including $schema and defaults", () => {
    const suite = parseSuite({ ...valid, $schema: "x", defaults: { repeat: 3, judge: "anthropic:m" } });
    expect(suite.cases).toHaveLength(1);
    checkSuite(suite, registry());
  });

  it("accepts string, {messages} and object inputs", () => {
    const suite = parseSuite({
      ...valid,
      cases: [
        { id: "a", input: "hi", scorers: ["latencyCost"] },
        { id: "b", input: { messages: [{ role: "user", content: "hi" }] }, scorers: ["latencyCost"] },
        { id: "c", input: { question: "hi", n: 2 }, scorers: ["latencyCost"] },
      ],
    });
    expect(suite.cases).toHaveLength(3);
  });

  it("rejects malformed JSON with the parser's message", () => {
    const msg = messageOf(() => parseSuiteText('{ "name": "x", ', "my.json"));
    expect(msg).toContain("Invalid JSON in my.json");
  });

  it("names the JSON path of each problem", () => {
    const msg = messageOf(() =>
      parseSuite({ ...valid, cases: [{ id: "bad id!", input: "", scorers: "exactMatch" }] }, "suite.json"),
    );
    expect(msg).toContain("Invalid suite (suite.json)");
    expect(msg).toContain("cases[0].id");
    expect(msg).toContain("cases[0].scorers");
  });

  it("rejects unknown keys so typos are caught (scorer vs scorers)", () => {
    const msg = messageOf(() => parseSuite({ ...valid, cases: [{ id: "a", input: "hi", scorer: ["x"], scorers: ["exactMatch"] }] }));
    expect(msg).toMatch(/Unrecognized key.*scorer/i);
  });

  it("rejects a missing name, empty cases, and out-of-range repeat", () => {
    expect(messageOf(() => parseSuite({ ...valid, name: undefined }))).toContain("name");
    expect(messageOf(() => parseSuite({ ...valid, cases: [] }))).toContain("at least one case");
    expect(messageOf(() => parseSuite({ ...valid, defaults: { repeat: 500 } }))).toContain("defaults.repeat");
  });

  it("rejects duplicate case ids", () => {
    const suite = parseSuite({
      ...valid,
      cases: [
        { id: "a", input: "1", scorers: ["latencyCost"] },
        { id: "a", input: "2", scorers: ["latencyCost"] },
      ],
    });
    expect(messageOf(() => checkSuite(suite, registry()))).toContain('duplicate id "a"');
  });

  it("rejects unknown scorers and adapters and lists what is registered", () => {
    const s1 = parseSuite({ ...valid, cases: [{ id: "a", input: "hi", scorers: ["nope"] }] });
    expect(messageOf(() => checkSuite(s1, registry()))).toMatch(/unknown scorer "nope".*exactMatch/);
    const s2 = parseSuite({ ...valid, pipeline: { adapter: "grpc", config: {} } });
    expect(messageOf(() => checkSuite(s2, registry()))).toMatch(/unknown adapter "grpc".*http/);
  });

  it("requires expected for exactMatch but not for llmJudge", () => {
    const s1 = parseSuite({ ...valid, cases: [{ id: "a", input: "hi", scorers: ["exactMatch"] }] });
    expect(messageOf(() => checkSuite(s1, registry()))).toContain('requires an "expected"');
    const s2 = parseSuite({ ...valid, cases: [{ id: "a", input: "hi", scorers: ["llmJudge"] }] });
    expect(() => checkSuite(s2, registry())).not.toThrow();
  });

  it("rejects scorerConfig for a scorer the case does not use", () => {
    const suite = parseSuite({
      ...valid,
      cases: [{ id: "a", input: "hi", expected: "x", scorers: ["exactMatch"], scorerConfig: { llmJudge: { rubric: "r" } } }],
    });
    expect(messageOf(() => checkSuite(suite, registry()))).toContain("scorerConfig.llmJudge");
  });

  it("reports several problems at once, capped", () => {
    const cases = Array.from({ length: 20 }, (_, i) => ({ id: `c${i}`, input: "x", scorers: ["nope"] }));
    const suite = parseSuite({ ...valid, cases });
    const msg = messageOf(() => checkSuite(suite, registry()));
    expect(msg).toContain("...and 8 more");
  });

  it("gives a clear error for a missing file", () => {
    expect(messageOf(() => loadSuite("does/not/exist.json", registry()))).toContain("Cannot read suite file");
  });
});
