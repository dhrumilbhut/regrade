import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { INIT_SUITE, INIT_TS_SUITE, MOCK_PIPELINE } from "../templates.js";

export interface InitOptions {
  dir: string;
  force?: boolean;
  /** Scaffold a code-first TypeScript suite (no mock server needed). */
  ts?: boolean;
  cwd?: string;
  log?: (line: string) => void;
}

/** Scaffold a runnable example: a suite, a mock pipeline, and a .gitignore entry for the results DB. */
export function initCommand(opts: InitOptions): { written: string[]; skipped: string[] } {
  const cwd = opts.cwd ?? process.cwd();
  const log = opts.log ?? ((l) => console.log(l));
  const dir = join(cwd, opts.dir);
  mkdirSync(dir, { recursive: true });

  const written: string[] = [];
  const skipped: string[] = [];
  const files: Array<[string, string]> = opts.ts
    ? [["suite.mts", INIT_TS_SUITE]] // .mts is always an ES module, whatever the project's package.json "type" is
    : [
        ["suite.json", INIT_SUITE],
        ["mock-pipeline.mjs", MOCK_PIPELINE],
      ];
  for (const [name, content] of files) {
    const path = join(dir, name);
    const rel = `${opts.dir}/${name}`;
    if (existsSync(path) && !opts.force) {
      skipped.push(rel);
      continue;
    }
    writeFileSync(path, content, "utf8");
    written.push(rel);
  }

  const gitignore = join(cwd, ".gitignore");
  const entry = ".regrade/";
  const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  if (!current.split(/\r?\n/).some((l) => l.trim() === entry || l.trim() === ".regrade")) {
    appendFileSync(gitignore, `${current && !current.endsWith("\n") ? "\n" : ""}${entry}\n`);
    written.push(".gitignore (added .regrade/)");
  }

  for (const w of written) log(`  created ${w}`);
  for (const s of skipped) log(`  skipped ${s} (already exists; use --force to overwrite)`);
  log("");
  log("Next:");
  if (opts.ts) {
    log(`  regrade run ${opts.dir}/suite.mts     # needs Node 22.18+; no server or API key required`);
  } else {
    log(`  1. node ${opts.dir}/mock-pipeline.mjs      # start the mock pipeline (leave running)`);
    log(`  2. regrade run ${opts.dir}/suite.json      # in another terminal`);
  }
  return { written, skipped };
}
