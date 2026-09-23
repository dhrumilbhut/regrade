/**
 * Static assets for the self-contained HTML report.
 *
 * Rules for this file:
 * - No backticks or `${` inside CSS/JS (they are template literals here).
 * - The report is written as UTF-8 and declares <meta charset="utf-8">, so the few
 *   symbols it uses (check, cross, arrows) are plain characters.
 * - Untrusted data (pipeline outputs) is only ever inserted with textContent,
 *   never innerHTML.
 */

export const EARLY_THEME_JS = String.raw`try{var t=localStorage.getItem('regrade-theme');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;

export const CSS = String.raw`
:root {
  color-scheme: light;
  --page: #f9f9f7;
  --surface: #fcfcfb;
  --ink: #0b0b0b;
  --ink2: #52514e;
  --muted: #898781;
  --grid: #e1e0d9;
  --border: rgba(11, 11, 11, 0.10);
  --accent: #2a78d6;
  --wash: rgba(11, 11, 11, 0.04);
  --good: #0ca30c;
  --warning: #fab219;
  --serious: #ec835a;
  --critical: #d03b3b;
  --neutral: #898781;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --page: #0d0d0d;
    --surface: #1a1a19;
    --ink: #ffffff;
    --ink2: #c3c2b7;
    --grid: #2c2c2a;
    --border: rgba(255, 255, 255, 0.10);
    --accent: #3987e5;
    --wash: rgba(255, 255, 255, 0.05);
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --page: #0d0d0d;
  --surface: #1a1a19;
  --ink: #ffffff;
  --ink2: #c3c2b7;
  --grid: #2c2c2a;
  --border: rgba(255, 255, 255, 0.10);
  --accent: #3987e5;
  --wash: rgba(255, 255, 255, 0.05);
}
* { box-sizing: border-box; }
html { background: var(--page); }
body {
  margin: 0;
  background: var(--page);
  color: var(--ink);
  font: 15px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  -webkit-text-size-adjust: 100%;
}
.wrap { max-width: 1040px; margin: 0 auto; padding: 24px 16px 64px; }
h1, h2, h3, p, ul { margin: 0; }
.top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 20px; }
.brand { font-size: 13px; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--ink2); }
h1 { font-size: 26px; line-height: 1.2; font-weight: 650; margin: 2px 0 4px; overflow-wrap: anywhere; }
.meta { color: var(--ink2); font-size: 13px; overflow-wrap: anywhere; }
.btn {
  font: inherit; font-size: 13px; color: var(--ink); background: var(--surface);
  border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; cursor: pointer; white-space: nowrap;
}
.btn:hover { background: var(--wash); }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); gap: 12px; margin-bottom: 20px; }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
.tlabel { font-size: 13px; font-weight: 600; color: var(--ink2); }
.tvalue { font-size: 30px; line-height: 1.15; font-weight: 650; margin: 6px 0 2px; }
.tsub { font-size: 13px; color: var(--ink2); }

.bar { display: flex; gap: 2px; height: 10px; margin: 12px 0 8px; }
.seg { display: block; min-width: 4px; }
.seg:first-child { border-radius: 4px 0 0 4px; }
.seg:last-child { border-radius: 0 4px 4px 0; }
.seg:only-child { border-radius: 4px; }
.legend { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 14px; font-size: 13px; color: var(--ink2); }
.legend li { display: inline-flex; align-items: center; gap: 6px; }
.legend b { color: var(--ink); font-weight: 600; }

.badge {
  --c: var(--neutral);
  display: inline-flex; align-items: center; justify-content: center;
  width: 20px; height: 20px; flex: none; border-radius: 50%;
  border: 2px solid var(--c);
  background: color-mix(in srgb, var(--c) 18%, transparent);
  color: var(--ink); font-size: 11px; font-weight: 700; line-height: 1;
}
.status { display: inline-flex; align-items: center; gap: 8px; font-weight: 600; }

section.block { margin-bottom: 24px; }
h2.sec { font-size: 17px; font-weight: 650; margin-bottom: 10px; }
.cmp-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.cmp-head h2 { font-size: 18px; font-weight: 650; }
dl.facts { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0 0 14px; font-size: 14px; }
dl.facts dt { color: var(--ink2); }
dl.facts dd { margin: 0; overflow-wrap: anywhere; }
.warn { color: var(--ink); background: color-mix(in srgb, var(--warning) 16%, transparent); border: 1px solid color-mix(in srgb, var(--warning) 45%, transparent); border-radius: 8px; padding: 8px 12px; font-size: 13px; margin-bottom: 8px; }

.scroll { overflow-x: auto; }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
.scroll table { min-width: 680px; }
th { text-align: left; font-size: 12px; font-weight: 600; color: var(--ink2); padding: 8px 10px; border-bottom: 1px solid var(--grid); white-space: nowrap; }
td { padding: 9px 10px; border-bottom: 1px solid var(--grid); vertical-align: top; }
td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
td.id { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; overflow-wrap: anywhere; min-width: 200px; }
td .note { display: block; color: var(--ink2); font-size: 12px; margin-top: 2px; }
.dim { color: var(--ink2); }

.tools { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 10px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  font: inherit; font-size: 13px; color: var(--ink); background: var(--surface);
  border: 1px solid var(--border); border-radius: 999px; padding: 4px 12px; cursor: pointer;
}
.chip[aria-pressed="true"] { background: var(--ink); color: var(--surface); border-color: var(--ink); }
.search {
  font: inherit; font-size: 14px; color: var(--ink); background: var(--surface);
  border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; min-width: 200px; margin-left: auto;
}
.cases { display: flex; flex-direction: column; gap: 8px; }
details.case { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
details.case > summary {
  list-style: none; cursor: pointer; padding: 10px 14px;
  display: grid; grid-template-columns: 110px 1fr auto auto; gap: 12px; align-items: center;
}
details.case > summary::-webkit-details-marker { display: none; }
details.case > summary::before { content: "\25B8"; position: absolute; margin-left: -12px; color: var(--muted); }
details.case[open] > summary::before { content: "\25BE"; }
details.case > summary:hover { background: var(--wash); border-radius: 10px; }
.cid { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 13px; overflow-wrap: anywhere; }
.tags { display: inline-flex; gap: 4px; flex-wrap: wrap; margin-left: 8px; }
.tag { font-size: 11px; color: var(--ink2); border: 1px solid var(--border); border-radius: 999px; padding: 0 8px; }
.cnum { font-size: 13px; color: var(--ink2); font-variant-numeric: tabular-nums; white-space: nowrap; }
.cbody { padding: 4px 14px 14px; border-top: 1px solid var(--grid); }
.kv { margin-top: 12px; }
.kv > .k { font-size: 12px; font-weight: 600; color: var(--ink2); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 4px; }
pre {
  margin: 0; padding: 10px 12px; background: var(--wash); border: 1px solid var(--border); border-radius: 8px;
  font: 13px/1.45 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  white-space: pre-wrap; overflow-wrap: anywhere; max-height: 280px; overflow: auto;
}
.attempt { margin-top: 14px; padding-top: 12px; border-top: 1px dashed var(--grid); }
details.trace { margin-top: 12px; }
details.trace > summary { cursor: pointer; font-size: 12px; font-weight: 600; color: var(--ink2); text-transform: uppercase; letter-spacing: 0.04em; }
.steps { margin-top: 8px; display: grid; gap: 2px; }
.srow > summary { list-style: none; cursor: pointer; }
.srow > summary::-webkit-details-marker { display: none; }
.srow[open] { padding-bottom: 8px; }
.step { display: grid; grid-template-columns: 72px minmax(0, 1fr) minmax(60px, 32%) 64px; gap: 10px; align-items: center; padding: 3px 4px; border-radius: 4px; font-size: 13px; }
.srow > summary:hover .step, .srow[open] .step { background: var(--wash); }
.step .kind { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
.step .sname { overflow-wrap: anywhere; }
.step.serr .sname { color: var(--critical); }
.step .bar { position: relative; height: 8px; border-radius: 4px; background: var(--wash); }
.step .fill { position: absolute; top: 0; bottom: 0; min-width: 2px; border-radius: 4px; background: var(--accent); }
.step.serr .fill { background: var(--critical); }
.step .cnum { text-align: right; }
.ahead { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; margin-bottom: 8px; }
.ahead .cnum { margin-left: 0; }
.err { margin: 6px 0; font-size: 14px; }
ul.scores { list-style: none; padding: 0; margin: 8px 0 0; display: flex; flex-direction: column; gap: 6px; font-size: 14px; }
ul.scores li { display: flex; gap: 8px; align-items: flex-start; }
ul.scores .sn { font-weight: 600; min-width: 96px; }
ul.scores .sr { color: var(--ink2); overflow-wrap: anywhere; }
ul.scores .sm { color: var(--muted); font-size: 12px; margin-top: 2px; }
.empty { color: var(--ink2); padding: 16px; text-align: center; }
footer { color: var(--ink2); font-size: 12px; margin-top: 32px; }

@media (max-width: 640px) {
  .step { grid-template-columns: 60px minmax(0, 1fr) 56px; }
  .step .bar { display: none; }
  .wrap { padding: 16px 12px 48px; }
  dl.facts { grid-template-columns: 1fr; gap: 0; }
  dl.facts dt { margin-top: 8px; font-size: 12px; }
  details.case > summary { grid-template-columns: 96px 1fr; }
  details.case > summary .cnum { grid-column: 2; }
  .search { margin-left: 0; width: 100%; }
}
@media print {
  .btn, .tools { display: none; }
  details.case > .cbody { display: block; }
}
`;

export const JS = String.raw`
(function () {
  'use strict';
  var D;
  try { D = JSON.parse(document.getElementById('regrade-data').textContent); } catch (e) { return; }
  var root = document.documentElement;
  var app = document.getElementById('app');
  var run = D.run, S = D.summary;

  // ---- tiny DOM helper: strings become text nodes, never HTML ----
  function add(node, kid) {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (x) { add(node, x); }); return; }
    node.appendChild(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
  }
  function h(tag, props) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (k) {
        var v = props[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.slice(0, 2) === 'on') node.addEventListener(k.slice(2), v);
        else node.setAttribute(k, v === true ? '' : v);
      });
    }
    for (var i = 2; i < arguments.length; i++) add(node, arguments[i]);
    return node;
  }

  // ---- formatting ----
  function pct(r, d) { return (r * 100).toFixed(d || 0) + '%'; }
  function pctI(p) { return pct(p.rate) + ' [' + pct(p.lo) + '–' + pct(p.hi) + ']'; }
  function pts(d) { var v = d * 100; var s = Math.abs(v) < 0.05 ? '0.0' : Math.abs(v).toFixed(1); return (v < 0 ? '-' : v > 0 ? '+' : '') + s + ' pts'; }
  function ms(x) { return Math.round(x).toLocaleString('en-US') + ' ms'; }
  function usd(n) { return n === 0 ? '$0' : n < 0.0001 ? '<$0.0001' : '$' + n.toFixed(4); }
  function when(iso) { var d = new Date(iso); return isNaN(d.getTime()) ? iso : d.toLocaleString(); }
  function runLabel(m) {
    var p = [m.runId.slice(0, 8), when(m.startedAt)];
    if (m.label) p.push(m.label);
    if (m.gitSha) p.push(m.gitSha.slice(0, 7) + (m.gitDirty ? '*' : ''));
    if (m.status !== 'completed') p.push(m.status);
    return p.join(' · ');
  }

  // ---- status vocabulary: colour is never the only channel (icon + label always) ----
  var ST = {
    passed:  ['✓', 'Passed',  '--good'],
    failed:  ['✗', 'Failed',  '--critical'],
    flaky:   ['~',      'Flaky',   '--warning'],
    errored: ['!',      'Errored', '--serious']
  };
  var CH = {
    regressed: ['✗', 'Regressed', '--critical'],
    improved:  ['✓', 'Improved',  '--good'],
    flaky:     ['~',      'Flaky',     '--warning'],
    errored:   ['!',      'Errored',   '--serious'],
    unchanged: ['·', 'Unchanged', '--neutral'],
    modified:  ['·', 'Modified',  '--neutral'],
    'new':     ['+',      'New',       '--neutral'],
    removed:   ['−', 'Removed',   '--neutral']
  };
  function badgeOf(meta) { return h('span', { class: 'badge', style: '--c:var(' + meta[2] + ')', 'aria-hidden': 'true', text: meta[0] }); }
  function statusOf(meta) { return h('span', { class: 'status' }, badgeOf(meta), h('span', { text: meta[1] })); }

  // ---- header + theme ----
  function themeButton() {
    var modes = ['auto', 'light', 'dark'];
    var cur = 'auto';
    try { cur = localStorage.getItem('regrade-theme') || 'auto'; } catch (e) {}
    var btn = h('button', { class: 'btn', type: 'button', 'aria-label': 'Change colour theme' });
    function apply() {
      if (cur === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', cur);
      btn.textContent = 'Theme: ' + cur;
    }
    btn.addEventListener('click', function () {
      cur = modes[(modes.indexOf(cur) + 1) % modes.length];
      try { localStorage.setItem('regrade-theme', cur); } catch (e) {}
      apply();
    });
    apply();
    return btn;
  }
  function header() {
    var meta = ['run ' + run.runId.slice(0, 8), when(run.startedAt)];
    if (run.label) meta.push(run.label);
    if (run.gitSha) meta.push(run.gitSha.slice(0, 7) + (run.gitDirty ? '*' : ''));
    if (run.status !== 'completed') meta.push(run.status);
    return h('header', { class: 'top' },
      h('div', null,
        h('div', { class: 'brand', text: 'Regrade' }),
        h('h1', { text: run.suiteName }),
        h('p', { class: 'meta', text: meta.join('  ·  ') })),
      themeButton());
  }

  // ---- summary tiles ----
  function statusBar(c) {
    var order = ['passed', 'flaky', 'failed', 'errored'];
    var label = order.map(function (k) { return c[k] + ' ' + k; }).join(', ');
    var bar = h('div', { class: 'bar', role: 'img', 'aria-label': 'Cases by outcome: ' + label });
    var legend = h('ul', { class: 'legend' });
    order.forEach(function (k) {
      if (!c[k]) return;
      bar.appendChild(h('span', { class: 'seg', style: 'flex:' + c[k] + ';background:var(' + ST[k][2] + ')', title: c[k] + ' ' + k }));
      legend.appendChild(h('li', null, badgeOf(ST[k]), ST[k][1], h('b', { text: String(c[k]) })));
    });
    return h('div', null, bar, legend);
  }
  function tile(label, value, sub, extra) {
    return h('section', { class: 'card' },
      h('h2', { class: 'tlabel', text: label }),
      h('div', { class: 'tvalue', text: value }),
      sub ? h('div', { class: 'tsub', text: sub }) : null,
      extra);
  }
  function tiles() {
    var c = S.cases, t = [];
    t.push(tile('Cases passed', c.passed + ' / ' + c.total, c.total ? pct(c.passed / c.total) + ' of cases' : '', statusBar(c)));
    if (D.attemptRate && D.attemptRate.attempts > 0) {
      t.push(tile('Attempt pass rate', pct(D.attemptRate.rate),
        '95% Wilson interval ' + pct(D.attemptRate.lo) + '–' + pct(D.attemptRate.hi) + ' · ' + S.attempts.total + ' attempt' + (S.attempts.total === 1 ? '' : 's')));
    }
    if (S.latency) t.push(tile('Latency', ms(S.latency.avgMs), 'average · p95 ' + ms(S.latency.p95Ms)));
    var unknown = S.costUsd.unknownAttempts, total = S.attempts.total;
    var costValue = (total > 0 && unknown === total) ? 'unknown' : usd(S.costUsd.pipeline);
    var costSub = [];
    if (unknown > 0 && unknown < total) costSub.push(unknown + ' attempt' + (unknown === 1 ? '' : 's') + ' with unknown cost');
    if (S.costUsd.judge > 0) costSub.push('judge ' + usd(S.costUsd.judge));
    t.push(tile('Pipeline cost', costValue, costSub.join(' · ') || (costValue === 'unknown' ? 'the pipeline reported no usage or price' : '')));
    return h('div', { class: 'grid' }, t);
  }

  // ---- comparison ----
  var VERDICT = {
    'significant-regression': 'significant regression',
    'significant-improvement': 'significant improvement',
    'not-significant': 'not significant',
    'no-comparable-cases': 'no comparable cases'
  };
  function comparison() {
    var C = D.comparison;
    if (!C) return null;
    var reg = C.counts.regressed, o = C.overall;
    var facts = h('dl', { class: 'facts' },
      h('dt', { text: 'Base' }), h('dd', { text: runLabel(C.base) }),
      h('dt', { text: 'Head' }), h('dd', { text: runLabel(C.head) }));
    if (o.base && o.head) {
      facts.appendChild(h('dt', { text: 'Attempt pass rate' }));
      facts.appendChild(h('dd', { text: pctI(o.base) + ' → ' + pctI(o.head) + '  (' + o.comparableCases + ' comparable case' + (o.comparableCases === 1 ? '' : 's') + '; descriptive)' }));
    }
    if (o.meanDelta !== null) {
      var ci = o.ci ? ', 95% CI [' + pts(o.ci.lo) + ', ' + pts(o.ci.hi) + ']' : '';
      var pv = o.pValue === null ? '' : ', p=' + (o.pValue < 0.0001 ? '<0.0001' : o.pValue.toFixed(4));
      facts.appendChild(h('dt', { text: 'Overall change' }));
      facts.appendChild(h('dd', { text: 'mean per case ' + pts(o.meanDelta) + ci + pv + ' → ' + VERDICT[o.verdict] + '  (case-stratified permutation test; interval from a within-case bootstrap)' }));
    }
    var bl = C.metrics.base.latency, hl = C.metrics.head.latency;
    if (bl && hl) {
      facts.appendChild(h('dt', { text: 'Latency' }));
      facts.appendChild(h('dd', { text: 'avg ' + ms(bl.avgMs) + ' → ' + ms(hl.avgMs) + ' · p95 ' + ms(bl.p95Ms) + ' → ' + ms(hl.p95Ms) }));
    }
    var counts = Object.keys(CH).map(function (k) { return k + ' ' + C.counts[k]; }).join(' · ');
    facts.appendChild(h('dt', { text: 'Cases' }));
    facts.appendChild(h('dd', { text: counts }));

    var shown = C.cases.filter(function (c) { return c.change !== 'unchanged'; });
    var table = null;
    if (shown.length) {
      var rows = shown.map(function (c) {
        var evidence = [];
        if (c.change === 'regressed' || c.change === 'improved') {
          evidence.push('p = ' + (c.pValue === undefined ? '–' : c.pValue.toFixed(3)) + (c.significant ? ' · significant' : ''));
        }
        return h('tr', null,
          h('td', null, statusOf(CH[c.change])),
          h('td', { class: 'id', text: c.caseId }),
          h('td', { class: 'num', text: c.base ? c.base.passed + '/' + c.base.attempts : '–' }),
          h('td', { class: 'num', text: c.head ? c.head.passed + '/' + c.head.attempts : '–' }),
          h('td', { class: 'num', text: c.base && c.head ? pct(c.base.rate) + ' → ' + pct(c.head.rate) : '' }),
          h('td', null, evidence.join(''), c.note ? h('span', { class: 'note', text: c.note }) : null));
      });
      table = h('div', { class: 'scroll' },
        h('table', null,
          h('caption', { class: 'meta', style: 'text-align:left;padding-bottom:6px', text: 'Cases that changed between the two runs' }),
          h('thead', null, h('tr', null,
            h('th', { text: 'Change' }), h('th', { text: 'Case' }),
            h('th', { class: 'num', text: 'Base' }), h('th', { class: 'num', text: 'Head' }),
            h('th', { class: 'num', text: 'Pass rate' }), h('th', { text: 'Evidence' }))),
          h('tbody', null, rows)));
    }
    var unchanged = C.counts.unchanged;
    return h('section', { class: 'block card' },
      h('div', { class: 'cmp-head' },
        badgeOf(reg > 0 ? ST.failed : ST.passed),
        h('div', null,
          h('h2', { text: reg > 0 ? reg + ' regressed case' + (reg === 1 ? '' : 's') : 'No regressed cases' }),
          h('p', { class: 'meta', text: 'Compared with ' + runLabel(C.base) }))),
      C.warnings.map(function (w) { return h('div', { class: 'warn', text: 'Warning: ' + w }); }),
      facts,
      table,
      unchanged ? h('p', { class: 'meta', style: 'margin-top:8px', text: unchanged + ' unchanged case' + (unchanged === 1 ? '' : 's') + ' not listed.' }) : null);
  }

  // ---- cases ----
  function kv(k, v) { return h('div', { class: 'kv' }, h('div', { class: 'k', text: k }), h('pre', { text: v })); }
  function attemptBlock(a) {
    var head = h('div', { class: 'ahead' }, statusOf(ST[a.status]), h('span', { class: 'cnum', text: 'Attempt ' + a.attempt }));
    if (a.latencyMs !== null) head.appendChild(h('span', { class: 'cnum', text: ms(a.latencyMs) }));
    head.appendChild(h('span', { class: 'cnum', text: a.costUsd === null ? 'cost unknown' : usd(a.costUsd) }));
    var block = h('div', { class: 'attempt' }, head);
    if (a.error) block.appendChild(h('p', { class: 'err', text: 'Error: ' + a.error }));
    if (a.output !== null && a.output !== undefined) block.appendChild(kv('Output', a.output));
    if (a.scores.length) {
      var list = h('ul', { class: 'scores' });
      a.scores.forEach(function (s) {
        var m = s.error ? ST.errored : (s.pass ? ST.passed : ST.failed);
        list.appendChild(h('li', null, badgeOf(m), h('span', { class: 'sn', text: s.scorerName }),
          h('div', null,
            h('span', { class: 'sr', text: s.error ? 'error: ' + s.error : (s.reasoning || (s.pass ? 'passed' : 'failed')) }),
            s.note ? h('div', { class: 'sm', text: s.note }) : null)));
      });
      block.appendChild(list);
    }
    if (a.trace && a.trace.length) block.appendChild(traceBlock(a.trace));
    return block;
  }
  function flatSteps(steps, depth, out) {
    steps.forEach(function (s) { out.push({ s: s, depth: depth }); flatSteps(s.children || [], depth + 1, out); });
    return out;
  }
  function traceBlock(steps) {
    var rows = flatSteps(steps, 0, []);
    var end = 0;
    rows.forEach(function (r) { if (r.s.start !== null && r.s.duration !== null) end = Math.max(end, r.s.start + r.s.duration); });
    var list = h('div', { class: 'steps' });
    rows.forEach(function (r) {
      var s = r.s;
      var bar = h('div', { class: 'bar' });
      if (end > 0 && s.start !== null && s.duration !== null) {
        var fill = h('span', { class: 'fill' });
        fill.style.left = (s.start / end * 100) + '%';
        fill.style.width = Math.max(0.5, s.duration / end * 100) + '%';
        bar.appendChild(fill);
      }
      var name = h('span', { class: 'sname', text: s.name });
      name.style.paddingLeft = (r.depth * 14) + 'px';
      var line = h('div', { class: 'step' + (s.error ? ' serr' : '') },
        h('span', { class: 'kind', text: s.kind }), name, bar,
        h('span', { class: 'cnum', text: s.duration === null ? '' : ms(s.duration) }));
      if (s.error || s.input !== null || s.output !== null) {
        list.appendChild(h('details', { class: 'srow' }, h('summary', null, line),
          s.error ? h('p', { class: 'err', text: 'Error: ' + s.error }) : null,
          s.input !== null ? kv('Step input', s.input) : null,
          s.output !== null ? kv('Step output', s.output) : null));
      } else {
        list.appendChild(h('div', { class: 'srow' }, line));
      }
    });
    return h('details', { class: 'trace' }, h('summary', { text: 'Trace · ' + rows.length + (rows.length === 1 ? ' step' : ' steps') }), list);
  }
  function caseItem(c, open) {
    var passed = c.attempts.filter(function (a) { return a.status === 'passed'; }).length;
    var lat = c.attempts.filter(function (a) { return a.latencyMs !== null; });
    var avg = lat.length ? lat.reduce(function (s, a) { return s + a.latencyMs; }, 0) / lat.length : null;
    var tags = (c.tags && c.tags.length) ? h('span', { class: 'tags' }, c.tags.map(function (t) { return h('span', { class: 'tag', text: t }); })) : null;
    var body = h('div', { class: 'cbody' }, kv('Input', c.inputText));
    if (c.expected !== null && c.expected !== undefined) body.appendChild(kv('Expected', c.expected));
    c.attempts.forEach(function (a) { body.appendChild(attemptBlock(a)); });
    return h('details', { class: 'case', open: open ? true : false },
      h('summary', null,
        statusOf(ST[c.verdict]),
        h('span', null, h('span', { class: 'cid', text: c.caseId }), tags),
        h('span', { class: 'cnum', text: passed + '/' + c.attempts.length + ' passed' }),
        h('span', { class: 'cnum', text: avg === null ? '' : ms(avg) })),
      body);
  }
  var RANK = { errored: 0, failed: 1, flaky: 2, passed: 3 };
  function casesSection() {
    var cases = D.cases.slice().sort(function (a, b) { return RANK[a.verdict] - RANK[b.verdict]; });
    var state = { f: 'all', q: '' };
    var list = h('div', { class: 'cases' });
    var chips = h('div', { class: 'chips', role: 'group', 'aria-label': 'Filter cases by outcome' });
    var firstBad = -1;
    cases.forEach(function (c, i) { if (firstBad < 0 && c.verdict !== 'passed') firstBad = i; });

    function draw() {
      list.textContent = '';
      var n = 0;
      cases.forEach(function (c, i) {
        if (state.f !== 'all' && c.verdict !== state.f) return;
        if (state.q && (c.caseId + ' ' + (c.tags || []).join(' ')).toLowerCase().indexOf(state.q) < 0) return;
        list.appendChild(caseItem(c, i === firstBad && state.f === 'all' && !state.q));
        n++;
      });
      if (!n) list.appendChild(h('div', { class: 'empty', text: 'No cases match.' }));
    }
    function chip(key, label, count) {
      var b = h('button', { class: 'chip', type: 'button', 'aria-pressed': state.f === key ? 'true' : 'false', text: label + ' ' + count });
      b.addEventListener('click', function () {
        state.f = key;
        Array.prototype.forEach.call(chips.children, function (x) { x.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
        draw();
      });
      return b;
    }
    chips.appendChild(chip('all', 'All', cases.length));
    ['errored', 'failed', 'flaky', 'passed'].forEach(function (k) {
      var n = cases.filter(function (c) { return c.verdict === k; }).length;
      if (n) chips.appendChild(chip(k, ST[k][1], n));
    });
    var search = h('input', { class: 'search', type: 'search', placeholder: 'Search cases', 'aria-label': 'Search cases' });
    search.addEventListener('input', function () { state.q = search.value.toLowerCase(); draw(); });
    draw();
    return h('section', { class: 'block' }, h('h2', { class: 'sec', text: 'Cases' }), h('div', { class: 'tools' }, chips, search), list);
  }

  function footer() {
    return h('footer', { text: 'Generated by Regrade ' + D.version + ' on ' + when(D.generatedAt) + '. This report is a single self-contained file: it loads nothing from the network. Outputs are shown exactly as the pipeline returned them.' });
  }

  var wrap = h('div', { class: 'wrap' }, header(), tiles(), comparison(), casesSection(), footer());
  app.textContent = '';
  app.appendChild(wrap);
})();
`;
