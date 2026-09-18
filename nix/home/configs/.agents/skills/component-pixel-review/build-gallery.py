#!/usr/bin/env -S uv run python
"""Write compare.html: one section per case x theme, as-is left and to-be right.

  build-gallery.py --json measure.json --crops crops/ --out qa/<KEY>/ \
      --title '<KEY> ...' --lead 'device, branch, what the numbers mean' \
      --cases 'A=A short label;B=...' [--full dark.png --full light.png]

Sections carry the ink-centre offsets from measure.json so the reader sees the
number next to the image. Hover-overlay mode and a theme filter are built in.
"""
import argparse, html, json, os, shutil

ap = argparse.ArgumentParser()
ap.add_argument('--json', required=True); ap.add_argument('--crops', required=True); ap.add_argument('--out', required=True)
ap.add_argument('--title', required=True); ap.add_argument('--lead', default='')
ap.add_argument('--cases', required=True, help='"key=title;key=title" in display order')
ap.add_argument('--variants', default='asis,tobe'); ap.add_argument('--themes', default='dark,light')
ap.add_argument('--full', action='append', default=[], help='full screenshot(s) to append at the bottom')
a = ap.parse_args()

m = json.load(open(a.json)); left, right = a.variants.split(','); themes = a.themes.split(',')
cases = [c.split('=', 1) for c in a.cases.split(';')]
os.makedirs(f'{a.out}/img', exist_ok=True)
for f in os.listdir(a.crops): shutil.copy(f'{a.crops}/{f}', f'{a.out}/img/{f}')
for f in a.full: shutil.copy(f, f'{a.out}/img/full-{os.path.basename(f)}')

def fmt(v): return '–' if v is None else f'{v:+.1f}'
secs = []
for t in themes:
    for key, title in cases:
        l, r = m.get(f'{key}|{left}|{t}', {}), m.get(f'{key}|{right}|{t}', {})
        meas = f"ink centre {fmt(l.get('ink'))} → {fmt(r.get('ink'))}"
        L, R = f'img/{key}-{left}-{t}.png', f'img/{key}-{right}-{t}.png'
        secs.append(f'''<section class="case" data-theme="{t}">
<h3>{html.escape(title)} <span class="tag">{t}</span> <span class="m">{meas}</span></h3>
<div class="pair"><figure><figcaption>{left}</figcaption><img src="{L}"></figure><figure><figcaption>{right}</figcaption><img src="{R}"></figure></div>
<div class="overlay"><img class="b" src="{L}"><img class="a" src="{R}"><span class="hint">hover = {right}</span></div>
</section>''')
full = ''.join(f'<figure><figcaption>{html.escape(os.path.basename(f))}</figcaption><img src="img/full-{os.path.basename(f)}"></figure>' for f in a.full)
page = f'''<!doctype html><html lang="ko"><meta charset="utf-8"><title>{html.escape(a.title)}</title>
<style>
body{{margin:0;padding:24px;font:14px/1.5 -apple-system,Pretendard,sans-serif;background:#f4f4f5;color:#111}}
h1{{font-size:20px;margin:0 0 4px}} p.lead{{margin:0 0 16px;color:#555}}
.bar{{position:sticky;top:0;background:#f4f4f5;padding:8px 0 12px;display:flex;gap:12px;align-items:center;border-bottom:1px solid #ddd;margin-bottom:16px}}
button{{padding:6px 12px;border:1px solid #bbb;border-radius:6px;background:#fff;cursor:pointer}} button.on{{background:#111;color:#fff;border-color:#111}}
.case{{background:#fff;border:1px solid #e2e2e2;border-radius:10px;padding:12px 16px;margin-bottom:14px}}
.case h3{{margin:0 0 8px;font-size:14px}} .tag{{font-size:11px;padding:1px 6px;border-radius:4px;background:#eee;margin-left:6px}} .m{{font-weight:400;color:#666;margin-left:8px;font-size:12px}}
.pair{{display:grid;grid-template-columns:1fr 1fr;gap:12px}} figure{{margin:0}} figcaption{{font-size:11px;color:#888;margin-bottom:4px}}
img{{width:100%;display:block;image-rendering:pixelated;border:1px solid #ddd}}
.overlay{{position:relative;margin-top:10px;display:none}} body.mode-overlay .overlay{{display:block}} body.mode-overlay .pair{{display:none}}
.overlay .a{{position:absolute;inset:0;opacity:0}} .overlay:hover .a{{opacity:1}} .hint{{position:absolute;right:8px;top:6px;font-size:11px;color:#c00;background:#fff8;padding:0 4px}}
body.only-dark .case[data-theme=light],body.only-light .case[data-theme=dark]{{display:none}}
.full{{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:24px}} .full img{{image-rendering:auto}}
</style>
<h1>{html.escape(a.title)}</h1><p class="lead">{html.escape(a.lead)}</p>
<div class="bar"><span>view</span><button data-mode="pair" class="on">side by side</button><button data-mode="overlay">overlay (hover)</button>
<span style="margin-left:12px">theme</span><button data-theme="all" class="on">both</button>{''.join(f'<button data-theme="{t}">{t}</button>' for t in themes)}</div>
{''.join(secs)}
{f'<h2 style="font-size:16px">full screens</h2><div class="full">{full}</div>' if full else ''}
<script>
document.querySelectorAll('[data-mode]').forEach(b=>b.onclick=()=>{{document.body.classList.toggle('mode-overlay',b.dataset.mode==='overlay');document.querySelectorAll('[data-mode]').forEach(x=>x.classList.toggle('on',x===b))}});
document.querySelectorAll('button[data-theme]').forEach(b=>b.onclick=()=>{{document.body.className=document.body.className.replace(/only-\\w+/,'').trim();if(b.dataset.theme!=='all')document.body.classList.add('only-'+b.dataset.theme);document.querySelectorAll('button[data-theme]').forEach(x=>x.classList.toggle('on',x===b))}});
</script>'''
open(f'{a.out}/compare.html', 'w').write(page)
print(f'{a.out}/compare.html')
