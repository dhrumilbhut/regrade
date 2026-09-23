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

const CSS = `
:root { color-scheme: light; --page: #f9f9f7; --surface: #fcfcfb; --ink: #0b0b0b; --ink2: #52514e; --muted: #898781;
  --grid: #e1e0d9; --border: rgba(11,11,11,.10); --accent: #2a78d6; --wash: rgba(11,11,11,.04); --code: #f1f0ec; }
@media (prefers-color-scheme: dark) { :root { color-scheme: dark; --page: #0d0d0d; --surface: #1a1a19; --ink: #ffffff;
  --ink2: #c3c2b7; --grid: #2c2c2a; --border: rgba(255,255,255,.10); --accent: #3987e5; --wash: rgba(255,255,255,.05); --code: #1f1f1d; } }
* { box-sizing: border-box; }
html { background: var(--page); }
body { margin: 0; background: var(--page); color: var(--ink); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
a { color: var(--accent); text-underline-offset: 2px; }
header { border-bottom: 1px solid var(--border); background: var(--surface); }
header nav { max-width: 880px; margin: 0 auto; padding: 12px 16px; display: flex; flex-wrap: wrap; gap: 6px 18px; align-items: center; font-size: 14px; }
header nav .brand { font-weight: 700; color: var(--ink); text-decoration: none; margin-right: auto; font-size: 16px; }
header nav a:not(.brand) { color: var(--ink2); text-decoration: none; }
header nav a:not(.brand):hover { color: var(--ink); }
main { max-width: 880px; margin: 0 auto; padding: 24px 16px 48px; }
h1 { font-size: 30px; line-height: 1.25; margin: 8px 0 16px; }
h2 { font-size: 22px; margin: 36px 0 12px; padding-top: 8px; border-top: 1px solid var(--grid); }
h3 { font-size: 18px; margin: 28px 0 8px; }
p, li { color: var(--ink); }
code { font: 13.5px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; background: var(--code); padding: 1px 5px; border-radius: 4px; }
pre { font-size: 13px; line-height: 1.5; background: var(--code); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; overflow-x: auto; }
pre code { background: none; padding: 0; font-size: 13px; }
.table { overflow-x: auto; margin: 16px 0; }
table { border-collapse: collapse; width: 100%; font-size: 14.5px; }
th, td { text-align: left; vertical-align: top; padding: 8px 10px; border-bottom: 1px solid var(--grid); }
th { color: var(--ink2); font-weight: 600; }
.crumbs { font-size: 13px; color: var(--muted); }
.crumbs a { color: var(--muted); }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 10px; padding: 0; list-style: none; }
.cards li a { display: block; height: 100%; padding: 12px 14px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface); text-decoration: none; color: var(--ink); }
.cards li a:hover { border-color: var(--accent); }
.cta { display: inline-block; margin: 4px 0 8px; padding: 8px 14px; border-radius: 8px; background: var(--accent); color: #fff; text-decoration: none; font-weight: 600; }
.pager { display: flex; justify-content: space-between; gap: 12px; margin-top: 40px; padding-top: 16px; border-top: 1px solid var(--grid); font-size: 14px; }
footer { max-width: 880px; margin: 0 auto; padding: 0 16px 32px; font-size: 13px; color: var(--muted); }
footer a { color: var(--muted); }
`;

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

function layout(page: Page, content: string, extraHead: string, pager: string): string {
  const up = page.path === "" ? "" : "../../";
  const url = `${SITE}/${page.path}`;
  const description = page.kind === "home"
    ? "Open-source CLI for regression testing LLM apps, AI agents and RAG pipelines: score answers, compare runs, and fail CI when quality drops."
    : describe(page.body.replace(/^# .*$/m, ""), page.title);
  const title = page.kind === "home" ? page.title : `${page.title} · Regrade`;
  const crumbs = page.kind === "home" ? "" : `<p class="crumbs"><a href="${up}">Regrade</a> › ${page.kind === "guide" ? "How-to guides" : "Reference"}</p>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta property="og:type" content="${page.kind === "home" ? "website" : "article"}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary">
<link rel="alternate" type="text/plain" title="llms.txt" href="${up}llms.txt">
${extraHead}
<style>${CSS}</style>
</head>
<body>
<header><nav aria-label="Site">
<a class="brand" href="${up || "./"}">Regrade</a>
<a href="${up}docs/quickstart/">Quickstart</a>
<a href="${up}#how-to-guides">Guides</a>
<a href="${up}#reference">Reference</a>
<a href="${up}docs/faq/">FAQ</a>
<a href="${up}sample/">Sample report</a>
<a href="${REPO}">GitHub</a>
<a href="https://www.npmjs.com/package/regrade">npm</a>
</nav></header>
<main>
${crumbs}
${content}
${pager}
</main>
<footer>Regrade ${esc(pkg.version)} · MIT · This page is generated from the <a href="${REPO}#readme">README</a> · <a href="${up}llms-full.txt">plain text for LLMs</a></footer>
</body>
</html>
`;
}

function landing(page: Page, pages: Page[], link: LinkMapper): string {
  const intro = page.body.replace(/^# .*$/m, "").trim();
  const card = (p: Page) => `<li><a href="${p.path}">${inline(p.heading, () => "")}</a></li>`;
  return `<h1>Regrade: regression testing for LLM apps, AI agents and RAG pipelines</h1>
${renderMarkdown(intro, link)}
<p><a class="cta" href="docs/quickstart/">Get started</a></p>
<h2 id="how-to-guides">How-to guides</h2>
<ul class="cards">${pages.filter((p) => p.kind === "guide").map(card).join("")}</ul>
<h2 id="reference">Reference</h2>
<ul class="cards">${pages.filter((p) => p.kind === "doc").map(card).join("")}</ul>`;
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
      content = landing(page, pages, link);
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
      content = renderMarkdown(page.body, link);
      const i = ordered.indexOf(page);
      const prev = ordered[i - 1];
      const next = ordered[i + 1];
      pager = `<nav class="pager" aria-label="Pages">${prev ? `<a href="../../${prev.path}">← ${esc(prev.title)}</a>` : "<span></span>"}${next ? `<a href="../../${next.path}">${esc(next.title)} →</a>` : ""}</nav>`;
      head = page.path === "docs/faq/"
        ? jsonLd(faqLd(page.body))
        : jsonLd({ "@context": "https://schema.org", "@type": "TechArticle", headline: page.title, url: `${SITE}/${page.path}`, about: "Regrade", isPartOf: `${SITE}/` });
    }
    files.set(`${page.path}index.html`, layout(page, content, head, pager));
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
