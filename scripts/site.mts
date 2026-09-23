#!/usr/bin/env node
// Builds the documentation website from README.md, so the site and the README can never disagree:
// a landing page, one page per how-to guide and per reference section, the FAQ with FAQPage
// structured data, sitemap.xml, robots.txt, llms.txt and llms-full.txt (llmstxt.org).
// The sample report is written separately into <out>/sample by scripts/sample-report.mjs.
//
//   node scripts/site.mts [--out site]
//
// No dependencies: README.md uses a small subset of Markdown, rendered here.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SITE = "https://dhrumilbhut.github.io/regrade";
const REPO = "https://github.com/dhrumilbhut/regrade";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = process.argv.includes("--out") ? process.argv[process.argv.indexOf("--out") + 1]! : join(root, "site");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };

// ---- Markdown subset ------------------------------------------------------------------------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** GitHub's heading anchor: lower case, drop punctuation except - and _, spaces to hyphens. */
export const slugify = (heading: string) =>
  heading.replace(/`/g, "").trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, "").replace(/ /g, "-");

type LinkMapper = (href: string) => string;

function emphasis(text: string): string {
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?=[^\w*]|$)/g, "$1<em>$2</em>");
}

function inline(text: string, link: LinkMapper): string {
  let out = "";
  let last = 0;
  // bold may wrap code (**`.mts`**), link text may contain code: match those as whole tokens
  const re = /\*\*((?:`[^`]*`|[^*])+?)\*\*|`([^`]+)`|\[((?:`[^`]*`|[^\]])+)\]\(([^)\s]+)\)/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    out += emphasis(text.slice(last, m.index));
    if (m[1] !== undefined) out += `<strong>${inline(m[1], link)}</strong>`;
    else if (m[2] !== undefined) out += `<code>${esc(m[2])}</code>`;
    else out += `<a href="${esc(link(m[4]!))}">${inline(m[3]!, link)}</a>`;
    last = re.lastIndex;
  }
  return out + emphasis(text.slice(last));
}

const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

/** Render Markdown to HTML. Headings get GitHub-style ids; `link` rewrites every href. */
export function renderMarkdown(md: string, link: LinkMapper): string {
  const lines = md.split("\n");
  const html: string[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) html.push(`<p>${inline(para.join(" "), link)}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      flush();
      const code: string[] = [];
      for (i++; i < lines.length && !lines[i]!.startsWith("```"); i++) code.push(lines[i]!);
      html.push(`<pre><code${fence[1] ? ` class="language-${fence[1]}"` : ""}>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const heading = /^(#{1,6}) (.+)$/.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      html.push(`<h${level} id="${slugify(heading[2]!)}">${inline(heading[2]!, link)}</h${level}>`);
      continue;
    }
    if (line.startsWith("|") && /^\|[\s|:-]+\|$/.test(lines[i + 1]?.trim() ?? "")) {
      flush();
      const head = cells(line);
      const body: string[][] = [];
      for (i += 2; i < lines.length && lines[i]!.startsWith("|"); i++) body.push(cells(lines[i]!));
      i--;
      const th = head.every((h) => h === "") ? "" : `<thead><tr>${head.map((h) => `<th>${inline(h, link)}</th>`).join("")}</tr></thead>`;
      html.push(`<div class="table"><table>${th}<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c, link)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const item = /^(\s*)(-|\d+\.) (.+)$/.exec(line);
    if (item) {
      flush();
      const ordered = item[2] !== "-";
      const items: string[] = [];
      for (; i < lines.length; i++) {
        const m = /^(\s*)(-|\d+\.) (.+)$/.exec(lines[i]!);
        if (!m) break;
        items.push(`<li>${inline(m[3]!, link)}</li>`);
      }
      i--;
      html.push(`<${ordered ? "ol" : "ul"}>${items.join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    if (line.trim() === "") flush();
    else para.push(line.trim());
  }
  flush();
  return html.join("\n");
}

/** Plain text of a Markdown snippet, for meta descriptions. */
const plain = (md: string) =>
  md.replace(/```[\s\S]*?```/g, "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[`*]/g, "").replace(/\s+/g, " ").trim();

function describe(md: string, title: string): string {
  // the opening prose, list items included ("Use Regrade when: - ..."), until there is a snippet's worth
  let first = "";
  for (const block of md.replace(/```[\s\S]*?```/g, "").split(/\n\s*\n/)) {
    const p = block.trim();
    if (!p || /^(#|\|)/.test(p)) {
      if (first) break;
      continue;
    }
    first += ` ${p.replace(/^(- |\d+\. )/gm, "")}`;
    if (plain(first).length >= 100) break;
  }
  // a page that opens with a table or code has no prose to quote
  const text = plain(first) || `${title}: reference for Regrade, the open-source regression testing tool for LLM apps, AI agents and RAG pipelines.`;
  return text.length <= 158 ? text : `${text.slice(0, 155).replace(/\s+\S*$/, "")}…`;
}

// ---- Split the README into pages ----------------------------------------------------------------

interface Page {
  path: string; // "" for the landing page, else "docs/x/" or "guides/x/"
  title: string;
  heading: string;
  body: string; // Markdown, starting with the page's own heading
  kind: "home" | "guide" | "doc";
}

/** Short URLs for the reference sections (the README's H2 headings). */
const DOC_SLUGS: Record<string, string> = {
  "When to use Regrade": "when-to-use",
  Quickstart: "quickstart",
  Concepts: "concepts",
  "Suite format": "suite-format",
  "Adapters: what to test": "adapters",
  Scorers: "scorers",
  "Code suites: TypeScript or JavaScript": "code-suites",
  "Traces: check what the agent did, not just what it said": "traces",
  "Non-determinism: repeat your cases": "repeats",
  "Compare runs: what regressed, and is it real?": "compare",
  "Baselines and CI: fail the pull request that made things worse": "ci-baselines",
  Reports: "reports",
  "Exit codes and storage": "exit-codes-and-storage",
  Cost: "cost",
  "CLI reference": "cli",
  "Library API and custom scorers": "library",
  FAQ: "faq",
  "For AI coding assistants": "for-ai-assistants",
  "Security and privacy": "security",
  "Prior art": "prior-art",
  Roadmap: "roadmap",
};
const SKIP = new Set(["Contents", "Development", "Contributing", "License", "How-to guides"]);

export function splitReadme(readme: string): Page[] {
  const noBadges = readme.replace(/^\[!\[.*$/m, "");
  const parts = noBadges.split(/^(?=## )/m);
  const intro = parts.shift()!;
  const pages: Page[] = [
    { path: "", title: "Regrade: regression testing for LLM apps, AI agents and RAG pipelines", heading: "Regrade", body: intro, kind: "home" },
  ];
  for (const part of parts) {
    const heading = /^## (.+)$/m.exec(part)![1]!.trim();
    if (heading === "How-to guides") {
      for (const guide of part.split(/^(?=### )/m).slice(1)) {
        const h = /^### (.+)$/m.exec(guide)![1]!.trim();
        pages.push({ path: `guides/${slugify(h)}/`, title: h.replace(/`/g, ""), heading: h, body: guide.replace(/^### /m, "# "), kind: "guide" });
      }
      continue;
    }
    if (SKIP.has(heading)) continue;
    const slug = DOC_SLUGS[heading];
    if (!slug) throw new Error(`README section "${heading}" has no page slug in scripts/site.mts (add it to DOC_SLUGS or SKIP)`);
    // The page's own heading becomes <h1>; its sub-sections move up one level.
    const body = part.replace(/^## /m, "# ").replace(/^### /gm, "## ").replace(/^#### /gm, "### ");
    pages.push({ path: `docs/${slug}/`, title: heading.replace(/`/g, ""), heading, body, kind: "doc" });
  }
  return pages;
}

// ---- Links --------------------------------------------------------------------------------------

/** Every heading anchor in the README -> the page that now holds it. */
function anchorIndex(pages: Page[]): Map<string, Page> {
  const index = new Map<string, Page>();
  for (const p of pages) {
    for (const m of p.body.matchAll(/^#{1,6} (.+)$/gm)) {
      const slug = slugify(m[1]!);
      if (!index.has(slug)) index.set(slug, p);
    }
  }
  // the README's own section headings (before they moved up a level) keep resolving
  for (const p of pages) if (p.kind !== "home") index.set(slugify(p.heading), p);
  return index;
}

function linker(page: Page, anchors: Map<string, Page>): LinkMapper {
  const up = page.path === "" ? "" : "../../";
  return (href) => {
    if (/^https?:|^mailto:/.test(href)) {
      if (href === `${SITE}/` || href === SITE) return up || "./";
      if (href.startsWith(`${SITE}/`)) return up + href.slice(SITE.length + 1);
      return href;
    }
    if (href.startsWith("#")) {
      const target = anchors.get(href.slice(1));
      if (!target) throw new Error(`README link ${href} points at no heading`);
      const isPageTop = target.kind !== "home" && slugify(target.heading) === href.slice(1);
      const url = target === page ? "" : up + target.path || "./";
      return isPageTop ? url || "#" : `${url}${href}`;
    }
    return `${REPO}/blob/main/${href}`; // LICENSE, CHANGELOG.md, SECURITY.md
  };
}

// ---- HTML ---------------------------------------------------------------------------------------

// Light by default; dark from the system setting, or from the toggle (stored per browser).
const CSS = `
:root {
  color-scheme: light;
  --bg: #fafafa; --surface: #ffffff; --raised: #ffffff; --ink: #0f1115; --ink2: #475061; --muted: #6b7280;
  --line: #e7e8ec; --line2: #d9dbe1; --accent: #2563eb; --accent-ink: #ffffff; --accent-soft: rgba(37, 99, 235, .08);
  --code-bg: #f3f4f6; --shadow: 0 1px 2px rgba(15, 17, 21, .04), 0 8px 24px rgba(15, 17, 21, .06);
  --header: rgba(250, 250, 250, .82);
  --term-bg: #0e1116; --term-ink: #e6e9ef; --term-dim: #8b93a1; --good: #4ade80; --bad: #f87171; --warn: #fbbf24;
  --wide: 1120px; --text: 760px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --bg: #0b0d11; --surface: #12151b; --raised: #161a21; --ink: #eceef2; --ink2: #b3b9c4; --muted: #8a919d;
    --line: #232832; --line2: #2e3440; --accent: #6ea8fe; --accent-ink: #0b0d11; --accent-soft: rgba(110, 168, 254, .12);
    --code-bg: #161a21; --shadow: 0 1px 2px rgba(0, 0, 0, .3), 0 8px 24px rgba(0, 0, 0, .35); --header: rgba(11, 13, 17, .78);
    --term-bg: #0e1116;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --bg: #0b0d11; --surface: #12151b; --raised: #161a21; --ink: #eceef2; --ink2: #b3b9c4; --muted: #8a919d;
  --line: #232832; --line2: #2e3440; --accent: #6ea8fe; --accent-ink: #0b0d11; --accent-soft: rgba(110, 168, 254, .12);
  --code-bg: #161a21; --shadow: 0 1px 2px rgba(0, 0, 0, .3), 0 8px 24px rgba(0, 0, 0, .35); --header: rgba(11, 13, 17, .78);
  --term-bg: #0e1116;
}
* { box-sizing: border-box; }
html { background: var(--bg); -webkit-text-size-adjust: 100%; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.65 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
a { color: var(--accent); text-underline-offset: 3px; text-decoration-thickness: 1px; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; border-radius: 6px; }
svg.i { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; flex: none; }
.wrap { max-width: var(--wide); margin: 0 auto; padding: 0 20px; }

/* header */
.top { position: sticky; top: 0; z-index: 10; background: var(--header); backdrop-filter: saturate(180%) blur(12px); -webkit-backdrop-filter: saturate(180%) blur(12px); border-bottom: 1px solid var(--line); }
.top .wrap { display: flex; align-items: center; gap: 20px; height: 60px; }
.brand { display: inline-flex; align-items: center; gap: 10px; color: var(--ink); text-decoration: none; font-weight: 700; font-size: 17px; letter-spacing: -.01em; }
.brand svg { width: 26px; height: 26px; }
.menu { display: flex; gap: 4px; margin-left: auto; align-items: center; }
.menu a { color: var(--ink2); text-decoration: none; font-size: 14.5px; padding: 6px 10px; border-radius: 8px; }
.menu a:hover { color: var(--ink); background: var(--accent-soft); }
.theme { display: inline-grid; place-items: center; width: 36px; height: 36px; border-radius: 10px; border: 1px solid var(--line2); background: var(--surface); color: var(--ink2); cursor: pointer; }
.theme:hover { color: var(--ink); border-color: var(--muted); }
.theme .i-sun { display: none; }
:root[data-theme="dark"] .theme .i-sun { display: block; }
:root[data-theme="dark"] .theme .i-moon { display: none; }
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) .theme .i-sun { display: block; }
  :root:not([data-theme="light"]) .theme .i-moon { display: none; }
}
@media (max-width: 760px) { .menu .opt { display: none; } .top .wrap { gap: 10px; } .menu a { padding: 6px 7px; font-size: 14px; } }

/* buttons, chips */
.btn { display: inline-flex; align-items: center; gap: 8px; height: 44px; padding: 0 18px; border-radius: 10px; font-weight: 600; font-size: 15px; text-decoration: none; border: 1px solid transparent; }
.btn:hover { text-decoration: none; }
.btn.primary { background: var(--accent); color: var(--accent-ink); }
.btn.primary:hover { filter: brightness(1.08); }
.btn.ghost { border-color: var(--line2); color: var(--ink); background: var(--surface); }
.btn.ghost:hover { border-color: var(--muted); }
.pill { display: inline-flex; align-items: center; gap: 8px; padding: 4px 12px; border-radius: 999px; border: 1px solid var(--line2); background: var(--surface); color: var(--ink2); font-size: 13px; font-weight: 500; }
.pill b { color: var(--accent); font-weight: 600; }

/* landing */
.hero { padding: 72px 0 56px; }
.hero .wrap { display: grid; grid-template-columns: minmax(0, 1.05fr) minmax(0, 1fr); gap: 56px; align-items: center; }
.hero h1 { font-size: clamp(34px, 5vw, 52px); line-height: 1.08; letter-spacing: -.03em; margin: 18px 0 18px; font-weight: 750; }
.hero h1 span { color: var(--accent); }
.lede { font-size: 18.5px; line-height: 1.6; color: var(--ink2); margin: 0 0 28px; max-width: 34em; }
.actions { display: flex; flex-wrap: wrap; gap: 12px; margin-bottom: 22px; }
.install { display: flex; align-items: center; gap: 10px; max-width: 100%; padding: 6px 6px 6px 16px; border: 1px solid var(--line2); border-radius: 12px; background: var(--surface); font: 14px/1.4 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.install code { background: none; padding: 0; font-size: 13px; flex: 1; min-width: 0; overflow-x: auto; white-space: nowrap; color: var(--ink); }
.install code::before { content: "$ "; color: var(--muted); }
.note { color: var(--muted); font-size: 13.5px; margin: 10px 0 0; }
.term { margin: 0; background: var(--term-bg); color: var(--term-ink); border-radius: 16px; border: 1px solid #1f2530; box-shadow: var(--shadow); overflow: hidden; font: 12.8px/1.65 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.term .bar { display: flex; align-items: center; gap: 7px; padding: 12px 14px; border-bottom: 1px solid #1f2530; color: var(--term-dim); font-size: 12px; }
.term .bar i { width: 11px; height: 11px; border-radius: 50%; background: #2b3240; display: inline-block; }
.term .bar span { margin-left: 8px; }
.term pre { margin: 0; padding: 16px 18px 18px; background: none; border: 0; border-radius: 0; overflow-x: auto; color: var(--term-ink); font: inherit; }
.term .d { color: var(--term-dim); } .term .g { color: var(--good); } .term .r { color: var(--bad); } .term .y { color: var(--warn); } .term .b { font-weight: 700; }
.band { padding: 20px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); background: var(--surface); }
.band .wrap { display: flex; flex-wrap: wrap; align-items: center; gap: 10px 12px; }
.band .label { color: var(--muted); font-size: 13.5px; margin-right: 6px; }
.chip { padding: 5px 12px; border-radius: 999px; background: var(--accent-soft); color: var(--ink); font-size: 13.5px; }
section.block { padding: 80px 0 0; }
.eyebrow { color: var(--accent); font-weight: 600; font-size: 13.5px; letter-spacing: .06em; text-transform: uppercase; margin: 0 0 10px; }
section.block h2 { font-size: clamp(26px, 3.2vw, 34px); line-height: 1.2; letter-spacing: -.02em; margin: 0 0 12px; border: 0; padding: 0; }
.sub { color: var(--ink2); font-size: 17px; margin: 0 0 32px; max-width: 42em; }
.grid { display: grid; gap: 16px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.feature { padding: 22px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
.feature .ico { display: inline-grid; place-items: center; width: 40px; height: 40px; border-radius: 10px; background: var(--accent-soft); color: var(--accent); margin-bottom: 14px; }
.feature h3 { margin: 0 0 6px; font-size: 17px; letter-spacing: -.01em; }
.feature p { margin: 0; color: var(--ink2); font-size: 15px; line-height: 1.6; }
.steps { counter-reset: step; }
.step { position: relative; padding: 22px; border: 1px solid var(--line); border-radius: 14px; background: var(--surface); }
.step::before { counter-increment: step; content: counter(step); display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 50%; background: var(--accent); color: var(--accent-ink); font-weight: 700; font-size: 14px; margin-bottom: 12px; }
.step h3 { margin: 0 0 6px; font-size: 17px; }
.step p { margin: 0 0 14px; color: var(--ink2); font-size: 15px; }
.step pre { margin: 0; font-size: 12.5px; }
.links { display: grid; gap: 12px; grid-template-columns: repeat(3, minmax(0, 1fr)); list-style: none; padding: 0; margin: 0; }
.links a { display: flex; align-items: center; justify-content: space-between; gap: 12px; height: 100%; padding: 16px 18px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); color: var(--ink); text-decoration: none; font-weight: 500; font-size: 15.5px; line-height: 1.4; }
.links a::after { content: "→"; color: var(--muted); transition: transform .15s; }
.links a:hover { border-color: var(--accent); }
.links a:hover::after { color: var(--accent); transform: translateX(3px); }
.ref { columns: 3 220px; column-gap: 32px; list-style: none; padding: 0; margin: 0; }
.ref li { break-inside: avoid; padding: 6px 0; border-bottom: 1px solid var(--line); }
.ref a { color: var(--ink); text-decoration: none; font-size: 15px; }
.ref a:hover { color: var(--accent); }
.final { margin: 96px 0 0; padding: 48px 20px; text-align: center; border-top: 1px solid var(--line); background: var(--surface); }
.final h2 { font-size: clamp(24px, 3vw, 30px); letter-spacing: -.02em; margin: 0 0 10px; }
.final p { color: var(--ink2); margin: 0 0 24px; }
.final .install { margin: 0 auto; max-width: 560px; text-align: left; }
@media (max-width: 600px) {
  .install code { white-space: normal; overflow-wrap: anywhere; }
  .term { font-size: 11px; }
  .term pre { padding: 14px; }
}
@media (max-width: 900px) {
  .hero { padding: 44px 0 40px; }
  .hero .wrap { grid-template-columns: minmax(0, 1fr); gap: 36px; }
  .grid, .links { grid-template-columns: minmax(0, 1fr); }
  section.block { padding-top: 56px; }
}
@media (min-width: 640px) and (max-width: 900px) { .grid, .links { grid-template-columns: repeat(2, minmax(0, 1fr)); } }

/* documentation pages */
.doc { max-width: var(--text); margin: 0 auto; padding: 36px 20px 64px; }
.crumbs { font-size: 13.5px; color: var(--muted); margin: 0 0 8px; }
.crumbs a { color: var(--muted); text-decoration: none; }
.crumbs a:hover { color: var(--accent); }
.doc h1 { font-size: clamp(28px, 4vw, 38px); line-height: 1.15; letter-spacing: -.025em; margin: 0 0 20px; }
.doc h2 { font-size: 23px; letter-spacing: -.015em; margin: 44px 0 12px; padding-top: 20px; border-top: 1px solid var(--line); }
.doc h3 { font-size: 18px; margin: 32px 0 8px; }
.doc p, .doc li { color: var(--ink); }
.doc li { margin: 4px 0; }
.doc h1 + p { font-size: 18px; color: var(--ink2); }
code { font: 13.5px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background: var(--code-bg); padding: 2px 6px; border-radius: 6px; }
pre { position: relative; font-size: 13px; line-height: 1.55; background: var(--code-bg); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; overflow-x: auto; }
pre code { background: none; padding: 0; font-size: 13px; }
.copy { position: absolute; top: 8px; right: 8px; padding: 4px 10px; border-radius: 8px; border: 1px solid var(--line2); background: var(--surface); color: var(--ink2); font: 500 12px/1.4 ui-sans-serif, system-ui, sans-serif; cursor: pointer; opacity: 0; transition: opacity .15s; }
pre:hover .copy, .copy:focus-visible, .install .copy { opacity: 1; }
.install .copy { position: static; flex: none; height: 32px; }
@media (hover: none) { .copy { opacity: 1; } }
.table { overflow-x: auto; margin: 20px 0; border: 1px solid var(--line); border-radius: 12px; }
table { border-collapse: collapse; width: 100%; font-size: 14.5px; }
th, td { text-align: left; vertical-align: top; padding: 10px 14px; border-bottom: 1px solid var(--line); }
tr:last-child td { border-bottom: 0; }
th { color: var(--ink2); font-weight: 600; background: var(--code-bg); }
.pager { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 56px; }
.pager a { display: block; padding: 14px 16px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); color: var(--ink); text-decoration: none; font-size: 15px; }
.pager a small { display: block; color: var(--muted); font-size: 12.5px; margin-bottom: 2px; }
.pager a:hover { border-color: var(--accent); }
.pager a.next { text-align: right; grid-column: 2; }

/* footer */
.foot { margin-top: 0; border-top: 1px solid var(--line); }
.foot .wrap { display: flex; flex-wrap: wrap; gap: 8px 22px; align-items: center; padding-top: 22px; padding-bottom: 28px; color: var(--muted); font-size: 13.5px; }
.foot a { color: var(--muted); text-decoration: none; }
.foot a:hover { color: var(--ink); }
.foot .sp { margin-right: auto; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
`;

const THEME_EARLY = `try{var t=localStorage.getItem("regrade-site-theme");if(t==="light"||t==="dark")document.documentElement.setAttribute("data-theme",t)}catch(e){}`;

const THEME_AND_COPY = `(function(){
var b=document.getElementById("theme");
function cur(){var a=document.documentElement.getAttribute("data-theme");return a||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light")}
function sync(){if(!b)return;var d=cur()==="dark";b.setAttribute("aria-label",d?"Switch to light theme":"Switch to dark theme");b.title=b.getAttribute("aria-label")}
if(b){b.addEventListener("click",function(){var n=cur()==="dark"?"light":"dark";document.documentElement.setAttribute("data-theme",n);try{localStorage.setItem("regrade-site-theme",n)}catch(e){}sync()});sync()}
function copyButton(host,text){var c=document.createElement("button");c.type="button";c.className="copy";c.textContent="Copy";c.addEventListener("click",function(){if(!navigator.clipboard)return;navigator.clipboard.writeText(text()).then(function(){c.textContent="Copied";setTimeout(function(){c.textContent="Copy"},1400)},function(){})});host.appendChild(c)}
document.querySelectorAll("pre:not(.plain)").forEach(function(p){copyButton(p,function(){var c=p.querySelector("code");return (c||p).textContent})});
document.querySelectorAll(".install").forEach(function(el){copyButton(el,function(){return el.querySelector("code").textContent})});
})();`;

const ICONS: Record<string, string> = {
  logo: `<svg viewBox="0 0 26 26" aria-hidden="true"><rect width="26" height="26" rx="7" fill="var(--accent)"/><path d="M6 9.5l4.5 5 3-3 6.5 6.5" fill="none" stroke="var(--accent-ink)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M15.5 18h4.5v-4.5" fill="none" stroke="var(--accent-ink)" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  sun: `<svg class="i i-sun" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6 6 6M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></svg>`,
  moon: `<svg class="i i-moon" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>`,
  run: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M10 8.5v7l6-3.5z"/></svg>`,
  check: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="m8.5 12.5 2.5 2.5 5-6"/></svg>`,
  stats: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h16"/><path d="M7 16v-5M12 16V6M17 16v-8"/></svg>`,
  pr: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="18" r="2.2"/><path d="M6 8.2v7.6M18 15.8V10a3 3 0 0 0-3-3h-3"/><path d="m13.5 5-1.8 2 1.8 2"/></svg>`,
  trace: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5v6h5M10 11v6h5"/><circle cx="5" cy="5" r="1.6"/><circle cx="10" cy="11" r="1.6"/><circle cx="15" cy="17" r="1.6"/><path d="M13 5h6M15 11h4M18 17h1"/></svg>`,
  local: `<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 5 6v5c0 4.5 3 8 7 10 4-2 7-5.5 7-10V6z"/><path d="m9.5 12 2 2 3.5-4"/></svg>`,
};

function jsonLd(value: unknown): string {
  return `<script type="application/ld+json">${JSON.stringify(value).replace(/</g, "\\u003c")}</script>`;
}

function faqLd(md: string) {
  const entities = [...md.matchAll(/^\*\*(.+?\?)\*\*\n([\s\S]+?)(?=\n\n|$)/gm)].map((m) => ({
    "@type": "Question",
    name: m[1],
    acceptedAnswer: { "@type": "Answer", text: plain(m[2]!) },
  }));
  return { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: entities };
}

function layout(page: Page, content: string, extraHead: string): string {
  const up = page.path === "" ? "" : "../../";
  const home = up || "./";
  const url = `${SITE}/${page.path}`;
  const description = page.kind === "home"
    ? "Open-source CLI for regression testing LLM apps, AI agents and RAG pipelines: score answers, compare runs, and fail CI when quality drops."
    : describe(page.body.replace(/^# .*$/m, ""), page.title);
  const title = page.kind === "home" ? page.title : `${page.title} · Regrade`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta name="theme-color" content="#fafafa" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#0b0d11" media="(prefers-color-scheme: dark)">
<meta property="og:type" content="${page.kind === "home" ? "website" : "article"}">
<meta property="og:site_name" content="Regrade">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary">
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 26 26"><rect width="26" height="26" rx="7" fill="#2563eb"/><path d="M6 9.5l4.5 5 3-3 6.5 6.5M15.5 18h4.5v-4.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>')}">
<link rel="alternate" type="text/plain" title="llms.txt" href="${up}llms.txt">
<script>${THEME_EARLY}</script>
${extraHead}
<style>${CSS}</style>
</head>
<body>
<header class="top"><div class="wrap">
<a class="brand" href="${home}">${ICONS.logo}Regrade</a>
<nav class="menu" aria-label="Site">
<a href="${up}docs/quickstart/">Quickstart</a>
<a class="opt" href="${up}#how-to-guides">Guides</a>
<a class="opt" href="${up}#reference">Reference</a>
<a class="opt" href="${up}docs/faq/">FAQ</a>
<a class="opt" href="${up}sample/">Sample report</a>
<a href="${REPO}">GitHub</a>
</nav>
<button class="theme" id="theme" type="button" aria-label="Switch theme">${ICONS.moon}${ICONS.sun}</button>
</div></header>
${content}
<footer class="foot"><div class="wrap">
<span class="sp">Regrade ${esc(pkg.version)} · MIT license</span>
<a href="${REPO}">GitHub</a>
<a href="https://www.npmjs.com/package/regrade">npm</a>
<a href="${REPO}/blob/main/CHANGELOG.md">Changelog</a>
<a href="${up}llms.txt">llms.txt</a>
<a href="${REPO}#readme">Generated from the README</a>
</div></footer>
<script>${THEME_AND_COPY}</script>
</body>
</html>
`;
}

function docPage(page: Page, body: string, pager: string): string {
  const crumbs = `<p class="crumbs"><a href="../../">Regrade</a> › ${page.kind === "guide" ? `<a href="../../#how-to-guides">How-to guides</a>` : `<a href="../../#reference">Reference</a>`}</p>`;
  return `<main class="doc">\n${crumbs}\n${body}\n${pager}\n</main>`;
}

const install = (cmd: string) => `<div class="install"><code>${esc(cmd)}</code></div>`;

function landing(pages: Page[]): string {
  const guides = pages.filter((p) => p.kind === "guide");
  const docs = pages.filter((p) => p.kind === "doc");
  const feature = (icon: string, title: string, text: string, href: string) =>
    `<article class="feature"><span class="ico">${ICONS[icon]}</span><h3><a href="${href}" style="color:inherit;text-decoration:none">${title}</a></h3><p>${text}</p></article>`;
  return `<main>
<section class="hero"><div class="wrap">
<div>
<span class="pill"><b>v${esc(pkg.version)}</b> Open source · MIT · No account</span>
<h1>Regression testing for <span>LLM apps</span>, AI agents and RAG pipelines</h1>
<p class="lede">Run your test cases through the real pipeline, score every answer, and fail the pull request that made things worse, with statistics that tell a real regression from random noise.</p>
<div class="actions"><a class="btn primary" href="docs/quickstart/">Get started</a><a class="btn ghost" href="sample/">See a sample report</a></div>
${install("npx regrade init --ts && npx regrade run regrade/suite.mts")}
<p class="note">No API key needed to try it. Requires Node.js 24 or newer.</p>
</div>
<figure class="term" aria-label="Example: regrade compare output">
<div class="bar"><i></i><i></i><i></i><span>regrade compare</span></div>
<pre class="plain"><span class="d">$</span> npx regrade compare --fail-on-regression
<span class="b">regrade compare · support-bot</span>
<span class="d">  base  f033e1c8  prompt-v6
  head  22ec5145  prompt-v7</span>

  <span class="r">✗ regressed</span> author-of-hamlet   5/5 → 0/5  <span class="r">p=0.008 significant</span>
  <span class="r">✗ regressed</span> symbol-for-gold    5/5 → 2/5  <span class="d">p=0.167</span>
  <span class="g">✓ improved </span> is-pluto-a-planet  0/5 → 5/5  <span class="g">p=0.008 significant</span>
  <span class="y">~ flaky    </span> largest-ocean      3/5 → 3/5

  overall  -21.7 pts  <span class="d">95% CI [-28.3, -15.0]  p=0.0015</span>
  <span class="r b">→ significant regression · gate failed</span></pre>
</figure>
</div></section>

<div class="band"><div class="wrap">
<span class="label">Tests</span>
<span class="chip">Any HTTP service</span><span class="chip">Python · FastAPI · LangChain</span><span class="chip">OpenAI</span><span class="chip">Anthropic Claude</span><span class="chip">Azure · Ollama · vLLM · OpenRouter</span><span class="chip">TypeScript functions</span>
</div></div>

<section class="block" id="features"><div class="wrap">
<p class="eyebrow">What it does</p>
<h2>Know whether a change made your AI worse</h2>
<p class="sub">A prompt tweak, a model swap or a new retrieval setting can quietly break answers. Regrade turns that into a test you run locally and in CI.</p>
<div class="grid">
${feature("run", "Test the real pipeline", "An HTTP endpoint in any language, an OpenAI-compatible or Anthropic model, or a function in your own process.", "docs/adapters/")}
${feature("check", "Score every answer", "Exact match, a prompt-injection-hardened LLM judge, latency and cost limits, or your own scorers in TypeScript.", "docs/scorers/")}
${feature("stats", "Tell regressions from noise", "Repeat each case, then compare runs with Wilson intervals, Fisher's exact test and a case-stratified permutation test.", "docs/compare/")}
${feature("pr", "Fail the pull request", "Commit a compact baseline; CI compares every pull request against it and exits non-zero when quality drops.", "docs/ci-baselines/")}
${feature("trace", "Check what the agent did", "Store each run's tool calls and LLM steps, and test that the agent called the right tool without looping.", "docs/traces/")}
${feature("local", "Zero infrastructure", "One CLI and one local SQLite file. No server, no account, no telemetry, no default provider. MIT licensed.", "docs/security/")}
</div>
</div></section>

<section class="block" id="how-it-works"><div class="wrap">
<p class="eyebrow">How it works</p>
<h2>Three steps from prompt change to confident merge</h2>
<p class="sub">Suites are plain JSON you can commit, or TypeScript when you want to call your agent directly.</p>
<div class="grid steps">
<article class="step"><h3>Write a suite</h3><p>List your pipeline and the cases that matter, with the scorers for each.</p>
<pre><code>{
  "name": "support-bot",
  "pipeline": { "adapter": "openai",
    "config": { "model": "gpt-6-luna" } },
  "cases": [{
    "id": "refund-window",
    "input": "Return after 40 days?",
    "scorers": ["llmJudge"] }]
}</code></pre></article>
<article class="step"><h3>Run, change, compare</h3><p>Run before and after your change, a few attempts per case, and see what moved.</p>
<pre><code>regrade run suite.json --repeat 5
# edit the prompt or swap the model
regrade run suite.json --repeat 5
regrade compare</code></pre></article>
<article class="step"><h3>Gate every pull request</h3><p>Commit a baseline once; CI fails the pull request that makes results worse.</p>
<pre><code>regrade run suite.json \\
  --repeat 3 --compact \\
  --export regrade.baseline.json
# then in CI:
regrade compare \\
  regrade.baseline.json \\
  --fail-on-regression</code></pre></article>
</div>
</div></section>

<section class="block" id="how-to-guides"><div class="wrap">
<p class="eyebrow">How-to guides</p>
<h2>Start from what you want to do</h2>
<p class="sub">Short, task-first guides with copy-paste examples.</p>
<ul class="links">${guides.map((p) => `<li><a href="${p.path}">${esc(p.title)}</a></li>`).join("")}</ul>
</div></section>

<section class="block" id="reference"><div class="wrap">
<p class="eyebrow">Reference</p>
<h2>Everything in detail</h2>
<p class="sub">The suite format, every adapter and scorer, the statistics, the CLI and the library API.</p>
<ul class="ref">${docs.map((p) => `<li><a href="${p.path}">${esc(p.title)}</a></li>`).join("")}</ul>
</div></section>

<section class="final">
<h2>Try it in one command</h2>
<p>A working suite with a stand-in agent. No API key, no server, no account.</p>
${install("npx regrade init --ts && npx regrade run regrade/suite.mts")}
</section>
</main>`;
}

export function buildSite(readme: string): Map<string, string> {
  const pages = splitReadme(readme);
  const anchors = anchorIndex(pages);
  const files = new Map<string, string>();
  const ordered = pages.filter((p) => p.kind !== "home");
  for (const page of pages) {
    const link = linker(page, anchors);
    let content: string;
    let head = "";
    let pager = "";
    if (page.kind === "home") {
      content = landing(pages);
      head = jsonLd({
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: "Regrade",
        description: "Regression testing for LLM apps, AI agents and RAG pipelines: run test cases through your pipeline, score answers, compare runs with statistical tests, and fail CI when quality drops.",
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Windows, macOS, Linux (Node.js 24+)",
        softwareVersion: pkg.version,
        license: "https://opensource.org/licenses/MIT",
        url: `${SITE}/`,
        downloadUrl: "https://www.npmjs.com/package/regrade",
        codeRepository: REPO,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      });
    } else {
      const body = renderMarkdown(page.body, link);
      const i = ordered.indexOf(page);
      const prev = ordered[i - 1];
      const next = ordered[i + 1];
      pager = `<nav class="pager" aria-label="Pages">${prev ? `<a href="../../${prev.path}"><small>Previous</small>← ${esc(prev.title)}</a>` : ""}${next ? `<a class="next" href="../../${next.path}"><small>Next</small>${esc(next.title)} →</a>` : ""}</nav>`;
      content = docPage(page, body, pager);
      head = page.path === "docs/faq/"
        ? jsonLd(faqLd(page.body))
        : jsonLd({ "@context": "https://schema.org", "@type": "TechArticle", headline: page.title, url: `${SITE}/${page.path}`, about: "Regrade", isPartOf: `${SITE}/` });
    }
    files.set(`${page.path}index.html`, layout(page, content, head));
  }
  const urls = [...pages.map((p) => `${SITE}/${p.path}`), `${SITE}/sample/`];
  files.set("sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n")}\n</urlset>\n`);
  files.set("robots.txt", `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`);
  return files;
}

// ---- CLI ----------------------------------------------------------------------------------------

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const files = buildSite(readFileSync(join(root, "README.md"), "utf8"));
  for (const [path, text] of files) {
    mkdirSync(dirname(join(outDir, path)), { recursive: true });
    writeFileSync(join(outDir, path), text);
  }
  copyFileSync(join(root, "llms.txt"), join(outDir, "llms.txt"));
  copyFileSync(join(root, "README.md"), join(outDir, "llms-full.txt"));
  process.stdout.write(`site: ${files.size} files + llms.txt, llms-full.txt → ${outDir}\n`);
}
