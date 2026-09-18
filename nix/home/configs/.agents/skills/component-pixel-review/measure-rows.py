#!/usr/bin/env -S uv run --with pillow python
"""Measure every guided row in a playground screenshot and crop it.

  measure-rows.py --shot dark.png --theme dark --cases A,B,C --variants asis,tobe \
      --x0 93 --x1 990 --out crops/ --json measure.json

Rows are located by the 1px red guide the playground draws across each
container's vertical centre; the guide order must match cases x variants.
For each row the script reports, in device px relative to the guide (+ = down):
  ink   centre of the bounding box of every non-background pixel in x0..x1
  runs  each horizontally separated cluster (a badge, a word group, an arrow)
        as (x0, x1, centre_offset, colored_fraction) -- colored_fraction > 0.3
        usually identifies an icon rather than text.
The crop of each row is written as <out>/<case>-<variant>-<theme>.png, upscaled
4x with nearest-neighbour so a 1px shift stays visible in a gallery.
"""
import argparse, colorsys, json, os
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument('--shot', required=True)
ap.add_argument('--theme', required=True)
ap.add_argument('--cases', required=True, help='comma-separated row labels, in on-screen order')
ap.add_argument('--variants', default='asis,tobe')
ap.add_argument('--x0', type=int, required=True, help='left edge of the region to measure (inside the container)')
ap.add_argument('--x1', type=int, required=True, help='right edge of the region to measure')
ap.add_argument('--row-px', type=int, default=101, help='container height in device px (36dp at 450dpi = 101)')
ap.add_argument('--out', required=True)
ap.add_argument('--json', required=True)
ap.add_argument('--bg-threshold', type=int, default=90, help='sum of |rgb - background| that counts as ink')
a = ap.parse_args()

cases = a.cases.split(','); variants = a.variants.split(',')
im = Image.open(a.shot).convert('RGB'); px = im.load(); w, h = im.size

def isred(p): return p[0] > 200 and p[1] < 60 and p[2] < 60
rows = [y for y in range(h) if sum(1 for x in range(0, w, 4) if isred(px[x, y])) > w / 8]
groups = []
for y in rows:
    if groups and y - groups[-1][-1] <= 1: groups[-1].append(y)
    else: groups.append([y])
guides = [(g[0] + g[-1]) / 2 for g in groups]
expected = len(cases) * len(variants)
assert len(guides) == expected, f'{a.shot}: found {len(guides)} guides, expected {expected}'

os.makedirs(a.out, exist_ok=True)
half = a.row_px / 2
result = json.load(open(a.json)) if os.path.exists(a.json) else {}
for i, yg in enumerate(guides):
    case, variant = cases[i // len(variants)], variants[i % len(variants)]
    top = int(round(yg - half + 1))
    crop = im.crop((0, top, w, top + a.row_px))
    crop.resize((w * 4, a.row_px * 4), Image.NEAREST).save(f'{a.out}/{case}-{variant}-{a.theme}.png')
    y0, y1 = int(round(yg - half + 5)), int(round(yg + half - 4))
    bg = px[a.x0 + 2, y0 + 1]
    def ink(p): return not isred(p) and sum(abs(p[i] - bg[i]) for i in range(3)) > a.bg_threshold
    cols = {x: [y for y in range(y0, y1) if ink(px[x, y])] for x in range(a.x0, a.x1)}
    cols = {x: ys for x, ys in cols.items() if ys}
    runs = []
    for x in sorted(cols):
        sats = [colorsys.rgb_to_hsv(*[c / 255 for c in px[x, y]])[1] for y in cols[x]]
        if runs and x - runs[-1]['x1'] <= 7:
            runs[-1]['x1'] = x; runs[-1]['ys'] += cols[x]; runs[-1]['sat'] += sats
        else:
            runs.append({'x0': x, 'x1': x, 'ys': list(cols[x]), 'sat': sats})
    out_runs = []
    for r in runs:
        lo, hi = min(r['ys']), max(r['ys'])
        out_runs.append([r['x0'], r['x1'], round((lo + hi) / 2 - yg, 1), round(sum(s > 0.35 for s in r['sat']) / len(r['sat']), 2)])
    allys = [y for ys in cols.values() for y in ys]
    rec = {'ink': round((min(allys) + max(allys)) / 2 - yg, 1) if allys else None,
           'ink_box': [min(allys) - yg, max(allys) - yg] if allys else None, 'runs': out_runs}
    result[f'{case}|{variant}|{a.theme}'] = rec
    print(case, variant, a.theme, json.dumps(rec))
json.dump(result, open(a.json, 'w'), ensure_ascii=False, indent=1)
