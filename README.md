# Regrade

[![CI](https://github.com/dhrumilbhut/regrade/actions/workflows/ci.yml/badge.svg)](https://github.com/dhrumilbhut/regrade/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Regression tests for AI agents and RAG pipelines. Git diff for AI behavior.**

**[See a live sample report →](https://dhrumilbhut.github.io/regrade/)** (a healthy pipeline vs a degraded one: which cases regressed, and is it real or noise?)

Regrade runs a suite of test cases through your real pipeline, scores every output, saves the run, and exits non-zero when something broke, so a prompt or model change can't quietly make your app worse.

- **Vendor-neutral.** MIT, no telemetry, no default provider. Test any HTTP endpoint, OpenAI-compatible API, or Anthropic model on equal footing.
- **Built for non-determinism.** Repeat each case (`--repeat`) and Regrade labels flaky cases instead of giving you a coin-flip pass/fail.
- **Honest scoring.** Exact match, an LLM judge hardened against prompt injection, and latency/cost thresholds. Cost accounting prices cache tokens and says "unknown" rather than guessing.
- **Zero infrastructure.** One CLI, results in one SQLite file, suites are plain JSON you can commit.

> **Status: v0.4.0.** Run, score, persist and repeat; `compare`, `runs`, `show` and single-file HTML/Markdown reports; **code suites** (TypeScript or JavaScript, with inline scorers and in-process pipelines); **baselines for CI** (run files); and **traces** (stored, shown and scored). Next: RAG scorers, judge calibration and a local dashboard.

## Install

Requires **Node.js 24 or newer** (the current LTS).

```bash
npx regrade --help
npm install --global regrade

# or from source
git clone https://github.com/dhrumilbhut/regrade.git && cd regrade
npm ci && npm run build && npm link
```

## Quickstart (no API key needed)

```bash
regrade init                       # writes regrade/suite.json and a mock pipeline
node regrade/mock-pipeline.mjs &   # start the mock pipeline (or use a second terminal)
regrade run regrade/suite.json
```

Prefer code? `regrade init --ts && regrade run regrade/suite.mts` scaffolds a [TypeScript suite](#code-suites-typescript-or-javascript) that needs no server at all.

```
regrade 0.4.0 · my-first-suite · http → localhost:4000/pipeline
  2 cases · concurrency 4

  ✓ capital-of-france     177 ms  exactMatch ✓  latencyCost ✓
  ✓ simple-math           175 ms  exactMatch ✓

  cases 2 · passed 2 · failed 0 · flaky 0 · errored 0
  latency avg 176 ms · p95 177 ms
  cost pipeline unknown

  All 2 cases passed.
  run 1219f529 saved → .regrade/results.db
```

Now point `pipeline.config.url` at your own endpoint and write your own cases.

## Suite format

A suite is a JSON file. Add `"$schema"` for editor autocomplete and validation (`regrade schema` prints the schema).

```json
{
  "$schema": "https://unpkg.com/regrade/schema/suite.schema.json",
  "name": "support-bot",
  "description": "Regression suite for the support assistant",
  "defaults": { "judge": "anthropic:claude-sonnet-5", "repeat": 1, "timeoutMs": 30000, "concurrency": 4 },
  "pipeline": {
    "adapter": "http",
    "config": {
      "url": "${PIPELINE_URL:-http://localhost:4000/pipeline}",
      "headers": { "Authorization": "Bearer ${PIPELINE_TOKEN}" }
    }
  },
  "cases": [
    {
      "id": "refund-policy",
      "input": "Can I return an item after 40 days?",
      "expected": "No: returns are accepted within 30 days.",
      "tags": ["policy"],
      "scorers": ["llmJudge", "latencyCost"],
      "scorerConfig": {
        "llmJudge": { "rubric": "Does the answer state the 30-day limit and avoid promising an exception?" },
        "latencyCost": { "maxLatencyMs": 3000 }
      }
    },
    {
      "id": "order-status",
      "input": { "messages": [{ "role": "user", "content": "Where is order 123?" }] },
      "expected": "Your order shipped on Monday.",
      "scorers": ["exactMatch"],
      "repeat": 5
    }
  ]
}
```

| Field | Meaning |
|---|---|
| `cases[].id` | Unique and **stable across runs**: it is how future comparisons match cases. Letters, digits, `.`, `_`, `-`. |
| `cases[].input` | A string, `{ "messages": [...] }` (chat history), or any object (sent as-is to HTTP pipelines; LLM adapters need `inputTemplate`). |
| `cases[].expected` | Reference answer. Required by `exactMatch`; optional context for `llmJudge`. |
| `cases[].scorers` | Names of scorers to run. `scorerConfig.<name>` holds that scorer's options. |
| `cases[].repeat` / `timeoutMs` | Per-case overrides. CLI flags beat case values, which beat `defaults`. |
| `${VAR}` / `${VAR:-default}` | Environment placeholders, allowed in any string of `pipeline.config`. **Secrets belong here, never in the file.** A missing variable stops the run before anything is sent. |
| `pricing` | Optional extra/override model prices (see [Cost](#cost)). |

Unknown keys are rejected, so typos like `scorer` (instead of `scorers`) fail loudly, with the JSON path.

## Adapters: what to test

### HTTP (any language, any framework)

Regrade POSTs `{ "input": <case input> }` and expects `{ "output": "<string>" }`:

```json
{ "adapter": "http", "config": { "url": "http://localhost:8000/answer", "headers": { "X-Team": "search" } } }
```

Options: `url`, `method` (POST/PUT/PATCH), `headers`, `outputField` (default `output`), `retries`, `retryBaseDelayMs`.

The pipeline can also report `costUsd`, `usage`, `steps` (a trace) and `metadata` in its response. Cost and usage are used, and `steps` are stored and can be scored (see [Traces](#traces-check-what-the-agent-did-not-just-what-it-said)). A Python (FastAPI/Flask), Node, or Go service needs only this one endpoint.

### OpenAI (and anything OpenAI-compatible)

```json
{ "adapter": "openai", "config": { "model": "gpt-4o", "system": "Be concise.", "temperature": 0, "maxTokens": 300 } }
```

Reads `OPENAI_API_KEY`. Set `baseUrl` (or `OPENAI_BASE_URL`) to use Ollama, vLLM, OpenRouter, Azure, or a local stub.

### Anthropic

```json
{ "adapter": "anthropic", "config": { "model": "claude-haiku-4-5", "system": "Be concise.", "maxTokens": 300 } }
```

Reads `ANTHROPIC_API_KEY` (and `ANTHROPIC_BASE_URL`). `maxTokens` defaults to 1024 because the API requires it.

Both LLM adapters accept `apiKeyEnv` (to name a different env var), `inputTemplate` (e.g. `"{{question}}"`, to turn an object input into a prompt), and `retries`. Retries happen only for network errors, HTTP 429 and 5xx (honouring `Retry-After`); latency is that of the final successful attempt.

## Scorers

| Scorer | What it does |
|---|---|
| `exactMatch` | Deterministic equality with `expected`. By default trimmed, whitespace-normalised and case-insensitive. Options: `caseSensitive`, `trim`, `normalizeWhitespace`. |
| `llmJudge` | Asks an LLM to judge the output against a rubric (`scorerConfig.llmJudge.rubric`, default: "does the output correctly and completely address the input, matching the intent of the expected answer?"). Model: `provider:model` from `scorerConfig.llmJudge.judge`, `--judge`, `defaults.judge`, or `REGRADE_JUDGE`. |
| `latencyCost` | Records latency and **fails** if `maxLatencyMs` or `maxCostUsd` is exceeded. With no thresholds it always passes. If `maxCostUsd` is set but the cost is unknown it reports an error, not a silent pass. |
| `toolCalled` | Checks the pipeline's [trace](#traces-check-what-the-agent-did-not-just-what-it-said): was a tool called (with these arguments, this many times), or not called. |
| `maxSteps` | Checks the trace: did the attempt finish within a step budget (optionally of one kind)? |

### About the LLM judge

Judge scores are useful, but **they are not ground truth**. Studies find raw judge agreement overstates real accuracy, and judges can be talked into passing bad answers. Regrade takes these precautions:

- The pipeline output is untrusted text. It is fenced inside a per-call random delimiter, and the judge is told everything inside is data, never instructions.
- The judge must return schema-validated JSON (`{reasoning, verdict}`, reasoning first) using the provider's native structured output, at temperature 0. Models that accept only their default temperature (such as current OpenAI reasoning models) reject that; Regrade then asks again without it, so those judges run at their default temperature, and it warns you, because their verdicts can vary more between runs.
- **Checked before the run.** Before any case runs, Regrade asks each judge one trivial question. If the judge cannot answer with a valid verdict (unknown model, bad key, no structured output), the run stops with exit 2 and says why, instead of erroring every attempt. It costs one tiny call per judge; `--no-judge-check` skips it.
- **Fail closed.** A malformed, refused or failed judge response makes the attempt **errored**, never an implicit pass.
- Judge spend is recorded separately from pipeline cost, and every verdict records which judge model produced it and at what temperature (`regrade show` and the HTML report display it).
- Regrade warns when the judge model is the same as the pipeline model (judges favour their own output).
- **Changing the judge is a change, not a regression.** The judge model is part of each judged case's identity, so `regrade compare` reports those cases as `modified` when two runs used different judges.

Choose a judge by measured cost, not list price: reasoning models can spend hundreds of hidden tokens on one verdict. In a small test (2026-09-23), `gpt-5-nano` (the lowest list price) used 400 to 900 output tokens per verdict and cost about ten times more than `gpt-4.1-nano` or `gpt-6-luna`, which used about 40.

It is still a single LLM making a judgment. Use an exact or programmatic check where you can, and treat judge results as one signal. Judge calibration against human labels is planned for Phase 2.

## Code suites: TypeScript or JavaScript

JSON is great for data. When you want to call your agent directly, or score with your own logic, write the suite in code:

```bash
regrade init --ts          # writes regrade/suite.mts: no server, no API key
regrade run regrade/suite.mts
```

```ts
// support-bot.suite.ts
import type { CodeSuite } from "regrade";
import { answer } from "./agent.ts";        // your real agent; write the .ts extension in local imports

export default {
  name: "support-bot",
  defaults: { repeat: 3 },
  // Test a function in your own process. (Or keep { adapter: "http", config: { url } }.)
  pipeline: {
    name: "support-agent",
    config: { model: "claude-sonnet-5", promptVersion: "v7" },   // recorded with each run (secrets are masked)
    run: async (input) => {
      const r = await answer(String(input));
      return { output: r.text, costUsd: r.costUsd, usage: r.usage };  // or just return a string
    },
  },
  scorers: {
    // A custom scorer is just a function. Return a boolean, or { pass, value, reasoning }.
    citesPolicy: ({ output }) => /policy #\d+/i.test(output),
    underBudget: ({ meta }) => ({ pass: (meta.costUsd ?? 0) < 0.01, value: meta.costUsd, reasoning: `$${meta.costUsd}` }),
  },
  cases: [
    { id: "refund-window", input: "How long do I have to return an item?", scorers: ["citesPolicy", "underBudget"] },
  ],
} satisfies CodeSuite;
```

- **What is allowed:** everything a JSON suite has, plus `scorers` (name → function) and a `pipeline` with a `run` function. Built-in scorers (`exactMatch`, `llmJudge`, `latencyCost`) sit alongside yours. A scorer may also be an object `{ score, requiresExpected?, preflight?, fingerprint? }`. `export default` may be an (async) function that returns the suite.
- **TypeScript without tooling:** Node imports `.ts` / `.mts` files natively by stripping types: no loader, no build step, no extra dependency. That means type syntax only (no `enum`, `namespace` or parameter properties), and local imports must include the `.ts` extension. `import type { CodeSuite } from "regrade"` is erased, so `npx regrade` works without installing anything in your project (a *value* import such as `defineSuite` needs `npm i -D regrade`). Prefer plain JavaScript? A `.mjs` suite has the same shape.
- **File extension and module type:** suites are ES modules. A plain `.ts` (or `.js`) file is treated as an ES module only if your `package.json` says `"type": "module"`; `npm init` writes `"type": "commonjs"`, in which case use **`.mts`** / **`.mjs`** (what `regrade init --ts` does, so it works in any project), and give local helper files the same treatment. Regrade tells you when this is the problem.
- **Timeouts are enforced for you.** Every attempt and every scorer is bounded by `--timeout` (default 30 s), even if your code ignores the `AbortSignal` it is given; a hung function becomes an *errored* attempt, not a hung run.
- **Editing a scorer is a change, not a regression.** Each inline scorer is fingerprinted from its source, and the fingerprint is part of its cases' identity, so after you edit one, `regrade compare` reports those cases as `modified` instead of comparing results produced by different logic. (Changes in code the scorer *imports* are not detected: bump `fingerprint` if you keep logic in a helper.)
- **Suite files run code.** Loading a code suite executes it, exactly like a test file: only run suites you trust. JSON suites are pure data.

## Traces: check what the agent did, not just what it said

An agent can give the right answer for the wrong reason, or the same answer after twice as many steps. If your pipeline reports its **steps** (LLM calls, tool calls, retrievals), Regrade stores them with each attempt, shows them, and can score them.

**From an HTTP pipeline**, add `steps` to the response:

```json
{
  "output": "Your order shipped on Monday.",
  "steps": [
    { "kind": "agent", "name": "order-agent", "startOffsetMs": 0, "durationMs": 78, "children": [
      { "kind": "retrieval", "name": "search", "durationMs": 9, "input": { "query": "order 123" } },
      { "kind": "tool", "name": "lookup_order", "durationMs": 25, "input": { "orderId": 123 }, "output": { "status": "shipped" } },
      { "kind": "llm", "name": "answer", "durationMs": 40 }
    ] }
  ]
}
```

`kind` is one of `llm`, `tool`, `retrieval`, `agent`, `other`; everything except `kind` and `name` is optional.

**From a function pipeline**, record steps with `tracer()`. Steps started inside another step become its children, and errors are recorded on the step:

```ts
import { tracer } from "regrade";   // a value import: npm i -D regrade

async function run(question: string) {
  const t = tracer();
  const docs = await t.step("retrieval", "search", () => search(question), { input: { query: question } });
  const order = await t.step("tool", "lookup_order", () => lookupOrder(123), { input: { orderId: 123 } });
  const text = await t.step("llm", "answer", () => answer(question, docs, order));
  return { output: text, steps: t.steps };
}
```

**Score the trace** with two built-in scorers (a case using them errors, never passes, when the pipeline reported no trace):

| Scorer | Config | Passes when |
|---|---|---|
| `toolCalled` | `tool`; optional `argsInclude` (the call's `input` contains these values; objects match partially), `times` (exact count), `not` | the tool was called (with those arguments, that many times), or with `not: true`, was not |
| `maxSteps` | `max`; optional `kind` | the attempt took at most `max` steps (of that kind): catches loops and runaway retries |

```json
"scorers": ["llmJudge", "toolCalled", "maxSteps"],
"scorerConfig": {
  "toolCalled": { "tool": "lookup_order", "argsInclude": { "orderId": 123 } },
  "maxSteps": { "max": 5, "kind": "retrieval" }
}
```

Your own scorers receive the full trace as `trace` in their arguments.

**See it:** `regrade show <run> <case>` prints the step tree with durations (`--full` adds each step's input and output), and the HTML report has a collapsible trace with timing bars under each attempt. Run files include traces, except compact ones.

**What is stored.** Values under secret-looking keys (`authorization`, `api_key`, `token`, `password`...) are masked, step inputs and outputs longer than 20,000 characters are clipped, and at most 1,000 steps are kept per attempt; anything cut is marked. Traces live in their own table, so reads that don't need them (such as `compare`) stay fast. `regrade run --no-trace` stores none; scorers still see them.

## Non-determinism: repeat your cases

```bash
regrade run suite.json --repeat 5
```

Each case runs 5 times as separate attempts. A case where every attempt passes is **passed**, none **failed**, and a mix is **flaky**, which exits non-zero. One green run of a stochastic pipeline proves little; repeated attempts show you the real pass rate. Every attempt is stored, and [`regrade compare`](#compare-runs-what-regressed-and-is-it-real) uses them to tell a real regression from noise.

## Compare runs: what regressed, and is it real?

```bash
regrade run suite.json --repeat 5 --label prompt-v6     # before your change
# ...edit the prompt / swap the model...
regrade run suite.json --repeat 5 --label prompt-v7     # after
regrade compare                                         # latest run vs the one before it
```

```
regrade compare · support-bot
  base  f033e1c8  2026-09-21 14:53  prompt-v6
  head  22ec5145  2026-09-21 14:53  prompt-v7

  ✗ regressed author-of-hamlet    5/5 → 0/5   100% → 0%  p=0.008 significant
  ✗ regressed symbol-for-gold     5/5 → 2/5   100% → 40%  p=0.167
      not statistically significant at this sample size
  ✓ improved  is-pluto-a-planet   0/5 → 5/5   0% → 100%  p=0.008 significant
  ~ flaky     largest-ocean       3/5 → 3/5   60% → 60%
  6 unchanged cases hidden (use --all to list them)

  attempt pass rate  88% [78%–94%] → 67% [54%–77%]  (12 comparable cases; descriptive)
  overall change     mean per case -21.7 pts, 95% CI [-28.3 pts, -15.0 pts], p=0.0015 → significant regression
```

`regrade compare` takes `[base] [head]`: run ids (unique prefixes work) or [run files](#baselines-and-ci-fail-the-pull-request-that-made-things-worse). With one run id it compares that run with the run before it; with one run file, that file (as the baseline) with the latest run of its suite; with none, the latest two. Add `--fail-on-regression` to make it a CI gate (exit 1), `--json` / `--md` to write the result, and `--all` to list unchanged cases. `regrade report <run> --against <base> --out report.html` writes the same comparison as a [single-file HTML report](#reports).

**How it decides.** Model outputs are random, so one run each is rarely enough to call a regression. Regrade is explicit about what it knows:

- **Per case** it compares pass rates with Wilson 95% intervals, and runs Fisher's exact test. A change is *significant* only when p < 0.05. That takes several attempts per case: with 3 attempts per side even 3/3 → 0/3 is p = 0.1. Changes on a single attempt are still listed, flagged "could be noise, re-run with `--repeat`".
- **Overall** it runs a paired permutation test, stratified by case, on the mean change in pass rate, with a within-case bootstrap for the interval. The question a gate asks is "on *this* suite, did the pass rate move by more than the pipeline's sampling noise?", so the randomness that matters is *within* each case, not which cases happen to exist. With one attempt per case this reduces to an exact sign test on the cases that flipped: six one-way flips are significant (p = 0.031), five are not (p = 0.063).
- **Never compared:** a case whose definition changed between the runs (`modified`, which includes a different judge model for judged cases), a case in only one run (`new` / `removed`), and a case with an errored attempt (`errored`: no verdict). They are listed, never counted as regressions.

`--fail-on-regression` fails on any regressed case (significant or not, because single-attempt suites can't do better), on any case that errored in the head run, and on a significant overall drop. `--significant-only` ignores regressions that aren't statistically significant. The tests check the statistics against textbook reference values and, by simulation, that the overall test rejects under 9% of the time when nothing changed and over 95% of the time for a real drop.

## Baselines and CI: fail the pull request that made things worse

`compare` needs a run to compare against, and a CI job starts with an empty `.regrade/` directory. **Run files** fill that gap: a portable JSON copy of a run, with every attempt's case hash, so `compare` still tells a changed case from a regression.

```bash
regrade run suite.json --repeat 3 --export run.json    # write a run file as part of a run
regrade export <run> --out run.json                    # or export a saved run (no --out: print it)
regrade compare base.json head.json                    # compare two files: no database needed
regrade compare regrade.baseline.json                  # a file alone is the base, vs the latest run of its suite
regrade report <run> --against regrade.baseline.json --out report.html
regrade import run.json                                # load a full run file into the database
```

**Compact run files** (`--compact`) keep only what a comparison needs: case ids and hashes, attempt statuses, latency, cost and each scorer's pass/fail. They leave out inputs, expected answers, outputs, error messages and judge reasoning, so they are small and safe to commit. They can be compared against, but not imported or turned into a report of their own.

(A `--json` report is not a run file: it has no case hashes, so it can't be used as a baseline.)

### Recipe 1: a committed baseline (recommended)

Keep `regrade.baseline.json` in the repository. Every pull request compares against it, and moving the baseline is an ordinary, reviewed commit, so the git history doubles as the history of your pipeline's quality.

Create or update the baseline when the pipeline is in a state you accept:

```bash
regrade run regrade/suite.json --repeat 3 --export regrade.baseline.json --compact
git add regrade.baseline.json && git commit -m "Update Regrade baseline"
```

Then gate pull requests (`.github/workflows/regrade.yml`):

```yaml
name: Regrade
on: pull_request

jobs:
  regrade:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      # Start your pipeline here if the suite calls it over HTTP.
      - name: Run the suite
        # Exit 1 (some cases failed) is fine here: the comparison decides. Exit 2 (bad config) still fails.
        run: npx regrade@0.4 run regrade/suite.json --repeat 3 || test $? -eq 1
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      - name: Compare with the baseline
        run: npx regrade@0.4 compare regrade.baseline.json --fail-on-regression --md regrade.md
      - name: Job summary
        if: always()
        run: cat regrade.md >> "$GITHUB_STEP_SUMMARY"
```

Use the same `--repeat` for the baseline and the pull request runs: more attempts per case give the comparison more power (see [how it decides](#compare-runs-what-regressed-and-is-it-real)). If the pull request deliberately changes cases, they show as `modified` and don't fail the gate; update the baseline in the same pull request.

### Recipe 2: the latest run on main as the baseline

No committed file: every push to `main` uploads its run, and pull requests compare against the newest one. Less ceremony, but the baseline moves without review.

```yaml
name: Regrade
on:
  push:
    branches: [main]
  pull_request:

jobs:
  regrade:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      actions: read   # to download main's run
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 24
      - name: Run the suite
        run: npx regrade@0.4 run regrade/suite.json --repeat 3 --export run.json --compact || test $? -eq 1
        env:
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
      - name: Keep main's run as the baseline
        if: github.event_name == 'push'
        uses: actions/upload-artifact@v7
        with:
          name: regrade-baseline
          path: run.json
      - name: Compare with main
        if: github.event_name == 'pull_request'
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          id=$(gh run list --workflow regrade.yml --branch main --event push --status success --limit 1 --json databaseId --jq '.[0].databaseId')
          gh run download "$id" --name regrade-baseline --dir baseline
          npx regrade@0.4 compare baseline/run.json run.json --fail-on-regression --md regrade.md
          cat regrade.md >> "$GITHUB_STEP_SUMMARY"
```

## Reports

A [live example](https://dhrumilbhut.github.io/regrade/) is published from the deterministic sample (`npm run sample-report`).

- **HTML:** `regrade report <run> [--against <base>] --out report.html` writes one self-contained file: no network access, no external assets, opens from `file://`, light and dark themes, filter and search, and per-case drill-down with inputs, outputs, scores and judge reasoning. Pipeline outputs are untrusted text and are only ever inserted as text, never HTML. Try the deterministic sample with `npm run sample-report`, which writes `site/index.html`.
- **Markdown:** `regrade run --md summary.md` and `regrade compare --md compare.md` write GitHub-flavoured summaries, ready for a CI job summary (`cat summary.md >> "$GITHUB_STEP_SUMMARY"`) or a PR comment.
- **JSON:** `--json` on `run` and `compare`.

## Results, exit codes, storage

| Exit code | Meaning |
|---|---|
| `0` | every case passed (or `--min-pass-rate` was met) |
| `1` | at least one case failed, was flaky, or **errored** (a broken pipeline is never green); for `compare --fail-on-regression`, the gate failed |
| `2` | usage or configuration error; nothing was run (invalid suite, missing env var, bad flag) |
| `130` | interrupted (Ctrl+C); attempts finished so far are saved and the run is marked `interrupted` |

- **Errored vs failed:** *failed* means the pipeline answered and a scorer said no. *Errored* means Regrade couldn't get a verdict (pipeline down, timeout, judge unavailable). The console and the JSON report keep them apart.
- **SQLite** (`.regrade/results.db`, or `--db`): tables `runs`, `results` (one row per case per attempt, with snapshots of the input and expected values), and `scores`. Runs are written incrementally, so a crash keeps what completed.
- `--json report.json` writes a versioned JSON report for CI or scripts.

```bash
regrade run suite.json --json report.json --repeat 3 --tag smoke --label prompt-v7
```

`--min-pass-rate 0.9` replaces "every case must pass" with "at least 90% of attempts must pass" (errored attempts count as not passed), for suites where some flakiness is acceptable. Then use `compare` to catch it getting worse.

## Cost

Cost is computed from the provider's reported token usage, priced **per category**: regular input, cache reads, cache writes (5-minute and 1-hour), and output. If a model has no known price, or usage is missing, the cost is **unknown** (shown as such), never guessed.

Prices ship in `src/pricing/prices.json` (dated 2026-09-23): current Anthropic models, and OpenAI's GPT-6, GPT-5.x, GPT-4.1, GPT-4o and o4-mini families. Where OpenAI shows no cache-read or cache-write price for a model, a call that uses one has unknown cost. Things to know:

- **Short-context prices only.** OpenAI also charges higher per-token prices above a context-size threshold; that tier is *not* modelled, so requests in it are under-priced. Supply an override if you use it.
- **Promotions expire.** `gpt-5.6-sol` is priced at its promotional rate through 2026-11-21 and at the standard rate afterwards (`validUntil` on the entry). If a promotion is extended, Regrade will over-report cost until you override it.
- **OpenAI cache writes** (`prompt_tokens_details.cache_write_tokens`, GPT-5.6+) are priced at the cache-write rate and treated as a subset of `prompt_tokens`, per OpenAI's usage format. OpenAI publishes no official cost formula from those fields, so treat OpenAI cost as an estimate.

Add or override prices in the suite:

```json
"pricing": [{ "provider": "openai", "model": "my-model", "inputPerMTok": 2.5, "outputPerMTok": 10, "cachedInputPerMTok": 1.25, "validUntil": "2027-01-31" }]
```

or with `--prices prices.json` (an array or `{entries: [...]}`; `validUntil` is optional). Check the provider's pricing page: Regrade's table is a convenience, not a bill.

## CLI reference

```
regrade run <suite> [options]     Run a suite (.json, or a code suite: .ts .mts .js .mjs), score outputs, save the run
  --db <path>                     SQLite file (default .regrade/results.db)
  --json <file>                   also write a JSON report
  --md <file>                     also write a Markdown summary
  --export <file> [--compact]     also write a run file (--compact: only what a comparison needs)
  --min-pass-rate <0-1>           pass if at least this fraction of attempts pass
  --concurrency <n>               attempts in flight (default 4)
  --repeat <n>                    attempts per case (overrides the suite)
  --timeout <ms>                  per-attempt timeout (default 30000)
  --tag <tag>                     only cases with this tag (repeatable)
  --case <id>                     only this case (repeatable)
  --label <text>                  label the run (e.g. a prompt version)
  --judge <provider:model>        LLM judge model
  --no-judge-check                skip the one tiny call that checks the judge before any case runs
  --no-trace                      do not store the steps pipelines report
  --prices <file>                 extra/override model prices
  --no-color                      plain output (also honours NO_COLOR; set REGRADE_ASCII=1 for ASCII symbols)
regrade runs [--suite <name>] [--limit <n>]        List saved runs, newest first
regrade show <run> [case] [--full]                 A run's summary, or one case's input, outputs and scores
regrade compare [base] [head] [options]            What regressed, improved, or is just flaky; runs are ids or run files
  --fail-on-regression | --significant-only        exit 1 when the gate fails
  --all  --json <file>  --md <file>  --suite <name>
regrade report <run> [--against <base>] [--out <file>]   Single-file HTML report (runs are ids or run files)
regrade export <run> [--out <file>] [--compact]    Write a run file (a baseline to commit, or to compare or import elsewhere)
regrade import <file>                              Load a full run file into the database
regrade init [--dir <dir>] [--force] [--ts]   Scaffold an example suite (--ts: a code suite, no server needed)
regrade schema [--out <file>]          Print the suite JSON Schema
```

## Adding a custom scorer

The easy way is an inline scorer in a [code suite](#code-suites-typescript-or-javascript). To reuse scorers across projects, or to run Regrade from your own program, register them on a registry and call the library:

```ts
import { createRegistry, loadSuite, runSuite, SqliteStore } from "regrade";

const registry = createRegistry().registerScorer({
  name: "mentionsParis",
  async score({ output }) {
    const pass = /paris/i.test(output);
    return { pass, value: pass ? 1 : 0, reasoning: pass ? undefined : "never mentions Paris" };
  },
});

const suite = loadSuite("suite.json", registry); // suites can now list "mentionsParis"
const store = new SqliteStore(".regrade/results.db");
const outcome = await runSuite({ suite, registry, store, regradeVersion: "custom" });
process.exitCode = outcome.exitCode;
```

`score` receives `{ input, expected, output, config, meta: { latencyMs, costUsd, usage, ... }, runtime }` and returns `{ pass, value, reasoning?, costUsd?, error? }`. Return `error` (rather than `pass: false`) when you *couldn't* evaluate, so the attempt is recorded as errored. Custom adapters work the same way through `registerAdapter`. The adapter and scorer interfaces are the library's stable contracts.

## Security & privacy

- Suite files are safe to commit: secrets are referenced as `${ENV_VAR}`. Resolved values are never written to the database; hard-coded secrets are masked before storing (with a warning).
- The database contains your raw inputs and outputs (and pipeline traces), which may be sensitive. `regrade init` git-ignores `.regrade/`. Values under secret-looking keys in traces are masked before storing; `--no-trace` stores none. Compact run files contain no inputs, outputs or traces.
- Regrade contacts only the URLs and providers you configure. There is no telemetry and no update check.
- See [SECURITY.md](SECURITY.md) for reporting vulnerabilities.

## Prior art

Regrade stands on ideas from [Promptfoo](https://www.promptfoo.dev), [DeepEval](https://deepeval.com), [Inspect AI](https://inspect.aisi.org.uk), and Ragas, and on the pass@k / pass^k reliability framing from τ-bench. If you need a hosted platform, deep RAG metrics today, or production observability, those tools are excellent. Regrade's bet is a small, vendor-neutral, statistically honest regression tool you can run anywhere.

## Development

```bash
npm ci
npm run check     # lint + typecheck + tests (builds first; e2e tests spawn the built CLI)
npm run build     # dist/ and schema/suite.schema.json
```

Useful scripts: `npm run test:watch`, `npm run lint`, `npm run typecheck`, `npm run sample-report` (a deterministic sample comparison report in `site/`). Node.js 24 or newer.

## Contributing

Contributions are welcome. Regrade is small on purpose, so please open an issue before a large change.

- **Tests** are real, not mocked: `test/fixtures/mock-pipeline.ts` is a local HTTP server that returns 429s, 500s, malformed JSON, hangs and non-deterministic answers on demand (prefer extending it over mocking `fetch`); `test/fixtures/stub-llm.ts` speaks the Anthropic and OpenAI response shapes so judge and adapter tests need no API keys; `test/e2e/` spawns the *built* CLI and asserts stdout, SQLite rows and exit codes. Tests must be deterministic and touch nothing beyond localhost.
- **Stable contracts:** the adapter and scorer interfaces (`src/core/types.ts`) change only additively.
- **Honesty:** don't claim other tools lack a feature unless you've checked, and only quote numbers that came from real runs.
- **Pull requests:** keep them focused, include tests, run `npm run check`, and add a line under *Unreleased* in `CHANGELOG.md` for user-visible changes. Never commit secrets, API keys or a results database.
- **Security issues:** see [SECURITY.md](SECURITY.md), not a public issue.

## License

[MIT](LICENSE)
