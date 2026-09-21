import { execFileSync } from "node:child_process";

export interface GitInfo {
  sha: string | null;
  dirty: boolean | null;
}

/** Best-effort: returns nulls outside a git repo or if git is missing. */
export function readGitInfo(cwd: string = process.cwd()): GitInfo {
  const run = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "ignore"], timeout: 3000 })
        .toString()
        .trim();
    } catch {
      return null;
    }
  };
  const sha = run(["rev-parse", "HEAD"]);
  if (!sha) return { sha: null, dirty: null };
  const status = run(["status", "--porcelain"]);
  return { sha, dirty: status === null ? null : status.length > 0 };
}
