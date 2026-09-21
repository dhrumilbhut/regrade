import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

/**
 * The project keeps its planning/design docs private (in `docs/`, never published). These tests make sure
 * that stays true: nothing private can be published, and nothing public depends on it.
 */
describe("public surface", () => {
  it("git-ignores the private docs folder", () => {
    // No trailing slash: docs/ may be a real folder, a Windows junction or a macOS symlink into a separate
    // private repo, and only a slash-less pattern matches all three (see .gitignore).
    expect(read(".gitignore").split(/\r?\n/)).toContain("/docs");
    const inGit = spawnSync("git rev-parse --is-inside-work-tree", { cwd: root, shell: true, encoding: "utf8" });
    if (inGit.status === 0) {
      // Check the folder itself: git refuses to look "beyond a symbolic link", so a symlinked docs/ can't be queried inside.
      const ignored = spawnSync("git check-ignore docs", { cwd: root, shell: true, encoding: "utf8" });
      expect(ignored.stdout.trim(), "git should ignore docs/ (folder, junction or symlink)").toBe("docs");
    }
  });

  it("npm publishes only a whitelist of files, none of them private", () => {
    const pkg = JSON.parse(read("package.json")) as { files?: string[] };
    expect(pkg.files).toEqual(["dist", "schema", "README.md", "LICENSE", "CHANGELOG.md"]);

    const r = spawnSync("npm pack --dry-run --json", { cwd: root, shell: true, encoding: "utf8" });
    expect(r.status, r.stderr).toBe(0);
    const packed = (JSON.parse(r.stdout) as Array<{ files: Array<{ path: string }> }>)[0]?.files.map((f) => f.path) ?? [];
    expect(packed.length).toBeGreaterThan(3);
    const allowed = /^(dist\/|schema\/|README\.md$|LICENSE$|CHANGELOG\.md$|package\.json$)/;
    expect(packed.filter((p) => !allowed.test(p))).toEqual([]);
    expect(packed.some((p) => /docs\/|BUILDLOG|FEATURES|PLAN|SPEC|archive/i.test(p))).toBe(false);
  });

  it("only the standard public Markdown files are in the repository root, and docs/ is not tracked", () => {
    const mdInRoot = readdirSync(root).filter((f) => f.toLowerCase().endsWith(".md")).sort();
    expect(mdInRoot).toEqual(["CHANGELOG.md", "README.md", "SECURITY.md"]);
    const tracked = spawnSync("git ls-files docs", { cwd: root, shell: true, encoding: "utf8" });
    if (tracked.status === 0) expect(tracked.stdout.trim()).toBe("");
  });

  const PRIVATE = /docs\/|SPEC-v2|MASTER-SPEC|BUILDLOG|FEATURES\.md|PLAN\.md|CONTENT\.md|INTERVIEW-LOG|BUILD-IN-PUBLIC|\bADR\b|adr\//;

  it.each(["README.md", "CHANGELOG.md", "SECURITY.md"])("%s does not mention or link to the private docs", (file) => {
    const hits = read(file)
      .split(/\r?\n/)
      .map((line, i) => ({ line, n: i + 1 }))
      .filter(({ line }) => PRIVATE.test(line))
      .map(({ line, n }) => `${file}:${n}: ${line.slice(0, 100)}`);
    expect(hits).toEqual([]);
  });

  it("source, tests helpers and scripts do not point at the private docs either", () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(join(root, dir))) {
        const rel = `${dir}/${name}`;
        if (statSync(join(root, rel)).isDirectory()) walk(rel);
        else if (/\.(ts|mjs|json|yml|tape)$/.test(name) && !rel.endsWith("publicSurface.test.ts") && !rel.endsWith("prices.json")) files.push(rel);
      }
    };
    for (const d of ["src", "scripts", ".github", ".vhs"]) if (existsSync(join(root, d))) walk(d);
    const hits = files.flatMap((f) =>
      read(f)
        .split(/\r?\n/)
        .filter((line) => PRIVATE.test(line))
        .map((line) => `${f}: ${line.trim().slice(0, 100)}`),
    );
    expect(hits).toEqual([]);
  });
});
