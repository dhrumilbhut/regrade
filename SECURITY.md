# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** (a GitHub security advisory on this repository, or email the maintainer) rather than in a public issue. Include steps to reproduce, the Regrade version (`regrade --version`) and your Node version. You should get an acknowledgement within a few days.

## Trust model

- **JSON suite files are data.** Regrade parses and validates them; it does not execute them.
- **Code suites (`.ts`, `.mts`, `.js`, `.mjs`) are programs.** Loading one runs its code with your permissions, exactly like a test file, an npm script, or a `vitest.config.ts`: it can read files, use the network and spawn processes. Only run code suites you wrote or reviewed, and treat a pull request that changes one the way you treat a change to CI configuration. Regrade does not sandbox them. Timeouts bound how long a *run* waits for user code, not what that code can do, and a leaked timer or open handle is cut off shortly after the command finishes.
- **Secrets stay out of files and out of the database.** Suites reference `${ENV_VAR}`. Resolved values are never stored, and literal values under secret-looking keys (`authorization`, `api_key`, `token`, `secret`, `password`, ...) are masked before storing, with a warning. Error messages never include URL query strings.
- **The results database is sensitive.** It holds your raw test inputs and pipeline outputs. Treat `.regrade/` like any other artifact that may contain user data; `regrade init` adds it to `.gitignore`.
- **No telemetry.** Regrade only contacts the pipeline URLs and LLM providers you configure.
- **The LLM judge reads untrusted text.** Pipeline output can try to manipulate the judge. Regrade fences it with a per-call random delimiter, requires schema-validated structured output, and fails closed on anything malformed. This reduces, but does not eliminate, the risk: a determined adversarial output may still influence a judge. Do not use judge scores as a security control.

## Supported versions

Pre-1.0: only the latest release receives fixes.
