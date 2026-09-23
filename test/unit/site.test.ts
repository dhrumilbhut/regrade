import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The documentation site is generated from README.md by scripts/site.mts. These checks are what a
// crawler (or an LLM following links) would trip over: broken links, raw Markdown, missing metadata.
const root = resolve(import.meta.dirname, "..", "..");
let out: string;
let pages: string[];

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const read = (f: string) => readFileSync(f, "utf8");
const rel = (f: string) => relative(out, f).replace(/\\/g, "/");

beforeAll(() => {
  out = mkdtempSync(join(tmpdir(), "regrade-site-"));
  const r = spawnSync(process.execPath, [join(root, "scripts", "site.mts"), "--out", out], { encoding: "utf8" });
  expect(r.status, r.stderr).toBe(0);
  pages = walk(out).filter((f) => f.endsWith(".html"));
});
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("documentation site", () => {
  it("has a landing page, every how-to guide and the key reference pages", () => {
    const paths = pages.map(rel);
    expect(paths).toContain("index.html");
    for (const p of ["docs/quickstart", "docs/faq", "docs/ci-baselines", "docs/traces", "docs/compare", "docs/for-ai-assistants", "guides/fail-a-github-pull-request-when-llm-quality-drops"]) {
      expect(paths).toContain(`${p}/index.html`);
    }
    const guides = [...read(join(root, "README.md")).split(/^## How-to guides$/m)[1]!.split(/^## /m)[0]!.matchAll(/^### /gm)].length;
    expect(paths.filter((p) => p.startsWith("guides/"))).toHaveLength(guides);
  });

  it("every internal link resolves to a generated page, and every #anchor to an id on that page", () => {
    const broken: string[] = [];
    for (const page of pages) {
      for (const [, href] of read(page).matchAll(/href="([^"]+)"/g)) {
        if (/^(https?:|mailto:|data:)/.test(href!)) continue; // external, or the inline favicon
        const [path, anchor] = href!.split("#") as [string, string | undefined];
        if (path === "sample/" || path.endsWith("/sample/")) continue; // written by scripts/sample-report.mjs
        let target = path === "" ? page : resolve(dirname(page), path);
        if (path === "" || path.endsWith("/") || path === "." || path === "./") target = path === "" ? page : join(target, "index.html");
        if (!existsSync(target)) {
          broken.push(`${rel(page)}: ${href} (no file)`);
          continue;
        }
        if (anchor && target.endsWith(".html") && !read(target).includes(`id="${anchor}"`)) broken.push(`${rel(page)}: ${href} (no id)`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("no raw Markdown leaks into the text", () => {
    for (const page of pages) {
      const text = read(page).replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<pre>[\s\S]*?<\/pre>/g, "").replace(/<code>[\s\S]*?<\/code>/g, "");
      expect(text, rel(page)).not.toMatch(/\*\*|\]\(|```|^#+ /m);
    }
  });

  it("every page has a unique title, a description of search-snippet length, and a canonical URL", () => {
    const titles = new Set<string>();
    for (const page of pages) {
      const html = read(page);
      const title = /<title>([^<]+)<\/title>/.exec(html)?.[1];
      // measured as search engines see it: entities decoded
      const description = (/<meta name="description" content="([^"]*)">/.exec(html)?.[1] ?? "")
        .replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      expect(title, rel(page)).toBeTruthy();
      expect(titles.has(title!), `duplicate title ${title}`).toBe(false);
      titles.add(title!);
      expect(description.length, `${rel(page)} description`).toBeGreaterThan(40);
      expect(description.length, `${rel(page)} description`).toBeLessThanOrEqual(160);
      expect(html).toMatch(/<link rel="canonical" href="https:\/\/dhrumilbhut\.github\.io\/regrade\/[^"]*">/);
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('name="viewport"');
    }
  });

  it("publishes structured data: SoftwareApplication on the landing page, FAQPage with every README question", () => {
    const ld = (f: string) => JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(read(join(out, f)))![1]!);
    expect(ld("index.html")).toMatchObject({ "@type": "SoftwareApplication", name: "Regrade", offers: { price: "0" } });
    const faq = ld("docs/faq/index.html");
    const questions = [...read(join(root, "README.md")).split(/^## FAQ$/m)[1]!.split(/^## /m)[0]!.matchAll(/^\*\*(.+\?)\*\*$/gm)].map((m) => m[1]);
    expect(faq["@type"]).toBe("FAQPage");
    expect(faq.mainEntity.map((q: { name: string }) => q.name)).toEqual(questions);
    expect(questions.length).toBeGreaterThanOrEqual(8);
    for (const q of faq.mainEntity) expect(q.acceptedAnswer.text.length).toBeGreaterThan(20);
  });

  it("writes a sitemap of every page, robots.txt, llms.txt and llms-full.txt", () => {
    const sitemap = read(join(out, "sitemap.xml"));
    for (const page of pages) {
      const url = `https://dhrumilbhut.github.io/regrade/${rel(page).replace(/index\.html$/, "")}`;
      expect(sitemap).toContain(`<loc>${url}</loc>`);
    }
    expect(read(join(out, "robots.txt"))).toContain("Sitemap: https://dhrumilbhut.github.io/regrade/sitemap.xml");
    expect(read(join(out, "llms.txt"))).toMatch(/^# Regrade\n\n> /);
    expect(read(join(out, "llms-full.txt"))).toBe(read(join(root, "README.md")));
  });

  it("supports light and dark themes: system preference by default, a toggle, and the saved choice applied before first paint", () => {
    for (const page of pages) {
      const html = read(page);
      expect(html, rel(page)).toContain('<button class="theme" id="theme" type="button"');
      const early = html.indexOf('localStorage.getItem("regrade-theme")');
      expect(early, rel(page)).toBeGreaterThan(-1);
      expect(early, `${rel(page)}: theme must be applied before the stylesheet`).toBeLessThan(html.indexOf("<style>"));
      expect(html).toContain(':root[data-theme="dark"]');
      expect(html).toContain('@media (prefers-color-scheme: dark)');
      expect(html).toContain(':root:not([data-theme="light"])');
    }
  });

  it("the landing page leads with the definition, a copyable install command and the main sections", () => {
    const html = read(join(out, "index.html"));
    expect(html).toMatch(/<h1>Regression testing for <span>LLM apps<\/span>, AI agents and RAG pipelines<\/h1>/);
    expect(html).toContain('<div class="install"><code>npx regrade init --ts &amp;&amp; npx regrade run regrade/suite.mts</code></div>');
    for (const id of ["features", "how-it-works", "how-to-guides", "reference"]) expect(html).toContain(`id="${id}"`);
  });

  it("escapes HTML in code examples", () => {
    const html = read(join(out, "docs", "ci-baselines", "index.html"));
    expect(html).toContain("&quot;$GITHUB_STEP_SUMMARY&quot;");
    expect(html).not.toMatch(/<pre><code[^>]*>[^<]*<(?!\/code)/);
  });
});
