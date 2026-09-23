# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/) (pre-1.0: minor versions may include breaking changes).

## [Unreleased]

### Added
- **Baselines for CI: run files.** `regrade export <run>` and `regrade run --export <file>` write a portable, versioned run file that keeps every attempt's case hash. `--compact` keeps only what a comparison needs (no inputs, outputs, error text or judge reasoning), so a baseline is small and safe to commit. `compare` and `report --against` accept run files wherever they take a run id (`regrade compare base.json head.json` needs no database; a file alone is the baseline for the latest run of its suite), and `regrade import` loads a full run file into a database. The README has two GitHub Actions recipes: a committed baseline, and the latest run on main.
- **Traces.** The `steps` a pipeline reports (HTTP response, or a function pipeline's return value) are now stored with each attempt: values under secret-looking keys masked, step inputs/outputs over 20,000 characters clipped, at most 1,000 steps per attempt (anything cut is marked). `regrade show <run> <case>` prints the step tree (`--full` adds step inputs and outputs), the HTML report has a collapsible trace with timing bars, and full run files and the JSON report include traces. `--no-trace` stores none.
- **Trace scorers:** `toolCalled` (was a tool called, with `argsInclude` arguments, `times`, or `not`) and `maxSteps` (a step budget, optionally per `kind`). Without a trace they error, never pass.
- `tracer()` records steps with timings from code, nesting steps started inside a step.
- **The judge is checked before the run.** One trivial call per judge model before any case runs; a judge that cannot give a valid verdict stops the run with exit 2 and the reason, instead of erroring every attempt. `--no-judge-check` (or `judgeCheck: false` in the library) skips it.
- **Every judge verdict records which model produced it and at what temperature** (`0`, or `default` for models that reject 0), shown by `regrade show` and the HTML report. A judge that runs at its default temperature triggers a warning, since its verdicts can vary more between runs.
- Library: `buildRunFile`, `parseRunFile`, `readRunFile`, `writeRunFile`, `serializeRunFile`, `SqliteStore.importRun`; `tracer`, `prepareTrace`, `flattenTrace`, `toolCalled`, `maxSteps`; `Store.getAttempts(runId, { traces })` (additive).
- Library: a scorer's `preflight` may be async, and receives `signal`, `warn` and `liveChecks`; `ScoreResult.metadata` is stored with the score (all additive). The database schema moves to version 3 (`scores.metadata_json`; a `traces` table; cache-write and reasoning token columns); existing databases upgrade automatically.

### Changed
- `toolCalled` and `maxSteps` are now built-in names: an inline scorer in a code suite with one of those names must be renamed.

## [0.3.1]: first npm release

Fixes found by the first test against the real OpenAI API.

### Fixed
- **The LLM judge failed with many current OpenAI models** (for example `gpt-6-luna`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5-nano`): it always sent `temperature: 0`, which those models reject with HTTP 400. The judge still asks for temperature 0, and when a model rejects the parameter it asks again without it (for either provider) and skips the rejected attempt for the rest of the run. Other errors still fail closed.

### Changed
- **The judge model is now part of a judged case's identity**, so `regrade compare` reports cases judged by different models as `modified` instead of comparing verdicts from different judges. As a one-time effect, cases that use `llmJudge` will show as `modified` when compared with runs made by 0.3.0.
- OpenAI prices added for the GPT-6 (Sol, Luna), GPT-5.5, 5.4, 5.2, 5.1 and 5, GPT-4.1, GPT-4o and o4-mini families. Where the pricing page shows no cache-read or cache-write price, a call that uses one has unknown cost.
- **Node.js 24 is now the supported (and CI-tested) version**, down from a "22.14 or newer" claim that was never tested in CI. Support for Node 22 may return later; simple and honest for now.

## [0.3.0]: code suites

Write suites in code: score with your own functions and call your agent in-process.

### Added
- **Code suites:** `regrade run` accepts `.ts`, `.mts`, `.js` and `.mjs` files whose default export is a suite (or an async function returning one). Everything a JSON suite has, plus `scorers` (name → function returning a boolean or `{ pass, value, reasoning }`, or an object with `requiresExpected` / `preflight` / `fingerprint`) and a **function pipeline** (`pipeline: { name?, run, config? }`) that tests your agent in your own process with no HTTP server. `defineSuite()` and the `CodeSuite` type give editor completion.
- TypeScript is imported natively by Node's type stripping (**Node 22.18+**): no loader, no build step, no new dependency. Older Node versions get a clear error pointing at `.mjs` or JSON.
- `regrade init --ts` scaffolds a runnable code suite that needs no server and no API key.
- Inline scorers are fingerprinted from their source and the fingerprint is part of a case's identity, so editing a scorer makes `regrade compare` report the case as `modified` rather than as a regression. Case hashes of suites that use only built-in scorers are unchanged.
- Library: `loadSuiteFile`, `defineSuite`, `functionAdapter`, `toScorer`; `Scorer.fingerprint` (additive).
- SECURITY.md documents that code suites are programs, not data.

### Fixed
- **Timeouts and interrupts now bind for every adapter and scorer,** even user code that ignores its `AbortSignal` (a hung function or scorer becomes an errored attempt). Previously only cooperating code (HTTP calls, the judge) was cancelled.
- **A run can no longer exit silently with code 0 mid-run** when the only pending work is a promise that never settles (Node does not keep the event loop alive for `AbortSignal.timeout()` timers or pending promises); the runner now holds the loop open until it finishes.
- After a command finishes, a process kept alive by user code (a leaked interval or socket) is exited after a 2-second grace period, preserving the exit code.

## [0.2.0]: compare and report

Turns saved runs into a regression workflow: see what got worse, whether it is real, and share it.

### Added
- `regrade compare [base] [head]`: per-case pass rates with Wilson intervals, Fisher exact tests, and a case-stratified paired permutation test (with a within-case bootstrap interval) for the overall change. Cases that were modified, new, removed or errored are listed but never counted as regressions. `--fail-on-regression` / `--significant-only` gate CI (exit 1); `--json`, `--md`, `--all`, `--suite`.- `regrade runs` (list runs) and `regrade show <run> [case]` (run summary, or a case's input, outputs, scores and errors).
- `regrade report <run> [--against <base>]`: a single self-contained HTML report (no network, light/dark, filters, drill-down, comparison view). Untrusted pipeline output is only ever rendered as text.
- Markdown reports for job summaries and PR comments: `regrade run --md`, `regrade compare --md`.
- `--min-pass-rate <0-1>` on `run`: gate on the attempt-level pass rate instead of requiring every case to pass.
- OpenAI prices (`gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, short-context tier) and support for GPT-5.6 `cache_write_tokens`; price entries can carry `validUntil` so promotional prices expire (GPT-5.6 Sol's promotion ends 2026-11-21).
- JSON report cases now include the input snapshot, expected value and tags.
- `npm run sample-report` generates a deterministic sample comparison report (`site/`), and a workflow publishes it to GitHub Pages.
- Library exports: `compareRuns`, `regressionGate`, `renderHtmlReport`, `renderRunMarkdown`, `renderCompareMarkdown`, `renderComparison`, `wilsonInterval`, `fisherExact`, `stratifiedPermutationTest`, `stratifiedBootstrapInterval`.

### Fixed
- `runs` and `show` emitted ANSI colour codes when piped (commander defaults a negatable `--no-color` option to `true`).

### Known limitations
- OpenAI long-context pricing tiers are not modelled (short-context prices only).
- The HTML report's client script is checked for syntax and visually reviewed, but has no automated DOM tests.

## [0.1.0]: engine core

First release: run a suite against a pipeline, score the outputs, and save the run.

### Added
- `regrade run`: executes a JSON suite with bounded concurrency, per-attempt timeouts, retries (network/429/5xx), `--repeat`, `--tag`/`--case` filters, `--label`, incremental persistence, and Ctrl+C-safe partial results. Exit codes `0` / `1` / `2` / `130`.
- Adapters: `http` (any endpoint; optional self-reported cost/usage/steps), `openai` (Chat Completions-compatible, `baseUrl` override), `anthropic` (Messages API).
- Scorers: `exactMatch`, `llmJudge` (nonce-fenced untrusted input, native structured output, fail-closed, judge cost tracked), `latencyCost` (enforces `maxLatencyMs` / `maxCostUsd`).
- Cost engine pricing regular input, cache reads/writes and output separately; unknown models report unknown cost. User-supplied prices via suite `pricing` or `--prices`.
- SQLite store (`runs`, `results` per attempt, `scores`), WAL, foreign keys, versioned migrations, redacted stored config.
- Errored vs. failed attempt status; case verdicts `passed` / `failed` / `flaky` / `errored`.
- Console reporter (append-only, CI-safe) and a versioned JSON report (`--json`).
- `regrade init` (example suite + mock pipeline) and `regrade schema` (suite JSON Schema for editor autocomplete).
- Library API: `createRegistry`, `registerScorer`, `registerAdapter`, `loadSuite`, `runSuite`, `SqliteStore`.
- Test suite with a fault-injecting mock pipeline and stub LLM server; CI on Node 22/24 across Linux, macOS and Windows.
