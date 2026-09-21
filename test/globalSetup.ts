import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

/**
 * E2E tests spawn the built CLI, so build once before the suite runs.
 * Set REGRADE_SKIP_BUILD=1 to reuse an existing `dist/`.
 */
export default function setup(): void {
  const root = resolve(import.meta.dirname, "..");
  const cli = resolve(root, "dist", "cli.js");
  if (process.env.REGRADE_SKIP_BUILD && existsSync(cli)) return;
  // A single command string with `shell: true` works on every OS (npm is npm.cmd on Windows).
  const res = spawnSync("npm run build", { cwd: root, encoding: "utf8", shell: true });
  if (res.status !== 0) {
    throw new Error(`npm run build failed before tests:\n${res.stdout}\n${res.stderr}`);
  }
}
