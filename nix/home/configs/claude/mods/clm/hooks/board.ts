import type { ClmBoardIssue } from '../types'

// `/clm board` writes this page and opens it in the browser. Everything is
// embedded, so the page works from a file:// URL with no network.

const COLUMNS = [['todo', 'To do'], ['doing', 'Doing'], ['done', 'Done'], ['question', 'Question']] as const

export const shortRepo = (repo: string) => repo.split('/').slice(-2).join('/')

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const CSS = `
:root{--bg:#fafafa;--fg:#1b1b1f;--dim:#6b6b76;--card:#fff;--line:#dcdce2;--accent:#3b5bdb}
@media (prefers-color-scheme:dark){:root{--bg:#16161a;--fg:#e8e8ee;--dim:#9a9aa8;--card:#202026;--line:#34343c;--accent:#7c93ff}}
*{box-sizing:border-box}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-bottom:16px}
h1{font-size:18px;margin:0 8px 0 0}
.toggle button{font:inherit;color:inherit;background:var(--card);border:1px solid var(--line);padding:4px 12px;cursor:pointer}
.toggle button:first-child{border-radius:6px 0 0 6px}.toggle button:last-child{border-radius:0 6px 6px 0;border-left:0}
.toggle button[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:#fff}
.meta{color:var(--dim);font-size:12px}
main{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;align-items:start}
section h2{font-size:14px;margin:0 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px 10px;margin-bottom:8px;overflow-wrap:anywhere}
.card .sub{color:var(--dim);font-size:12px}
.empty{color:var(--dim)}
[hidden]{display:none!important}
`

const SCRIPT = `
const here = document.body.dataset.repo;
const buttons = document.querySelectorAll('.toggle button');
function apply(mode) {
  buttons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  document.querySelectorAll('section').forEach(sec => {
    let n = 0;
    sec.querySelectorAll('.card').forEach(c => {
      const show = mode === 'all' || c.dataset.repo === here;
      c.hidden = !show;
      if (show) n++;
    });
    sec.querySelector('.count').textContent = n;
    sec.querySelector('.empty').hidden = n !== 0;
  });
}
buttons.forEach(b => b.addEventListener('click', () => apply(b.dataset.mode)));
apply('repo');
`

function card(i: ClmBoardIssue): string {
  const where = [esc(shortRepo(i.repo)), ...(i.branch ? [esc(i.branch)] : [])].join(' · ')
  return `<div class="card" data-repo="${esc(i.repo)}"><div>${esc(i.title)}</div>`
    + `<div class="sub">${esc(i.id)} · ${where}</div><div class="sub">updated <time>${esc(i.updated)}</time></div></div>`
}

export function boardHtml(issues: ClmBoardIssue[], repo: string, generatedAt: string): string {
  const columns = COLUMNS.map(([status, label]) => {
    const items = issues.filter(i => i.status === status).sort((x, y) => (x.updated < y.updated ? 1 : -1))
    return `<section><h2>${label} (<span class="count">${items.length}</span>)</h2>${items.map(card).join('')}<div class="empty">-</div></section>`
  }).join('')
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>clm board</title><style>${CSS}</style></head>
<body data-repo="${esc(repo)}">
<header><h1>clm board</h1>
<div class="toggle"><button data-mode="repo" aria-pressed="true">this repo (${esc(shortRepo(repo))})</button><button data-mode="all" aria-pressed="false">all repos</button></div>
<span class="meta">generated ${esc(generatedAt)} · run /clm board to regenerate</span></header>
<main>${columns}</main>
<script>${SCRIPT}</script>
</body></html>
`
}
