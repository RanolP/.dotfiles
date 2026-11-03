"""The fixed read-only use_figma script the index sends, and the guard that keeps it read-only."""

import json
import re

from figma_cli.auth import die

# ---------------------------------------------------------------- read-only script

# Sent verbatim (after a `const ARGS = {...};` line) to use_figma, once per page or
# per slice of a page. It reads nodes and returns JSON; read_only_violations()
# rejects it before sending if it ever gains a mutating call. The hash section above
# the marker is also run under node by figma_check.py.
INDEX_JS = r"""
const K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
const ror = (x, n) => (x >>> n) | (x << (32 - n));
// The plugin sandbox has neither crypto nor TextEncoder, so UTF-8 and SHA-256 are
// written out; arrays grow by push only so the read-only guard stays simple.
function utf8(str) {
  const out = [];
  for (const ch of str) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  return out;
}
function sha256(str) {
  const b = utf8(str);
  const bits = b.length * 8, hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
  b.push(0x80);
  while (b.length % 64 !== 56) b.push(0);
  b.push((hi >>> 24) & 255, (hi >>> 16) & 255, (hi >>> 8) & 255, hi & 255, (lo >>> 24) & 255, (lo >>> 16) & 255, (lo >>> 8) & 255, lo & 255);
  let H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  for (let o = 0; o < b.length; o += 64) {
    const W = [];
    for (let i = 0; i < 64; i++) {
      if (i < 16) W.push((b[o + 4 * i] << 24) | (b[o + 4 * i + 1] << 16) | (b[o + 4 * i + 2] << 8) | b[o + 4 * i + 3]);
      else {
        const x = W[i - 15], y = W[i - 2];
        W.push((W[i - 16] + (ror(x, 7) ^ ror(x, 18) ^ (x >>> 3)) + W[i - 7] + (ror(y, 17) ^ ror(y, 19) ^ (y >>> 10))) | 0);
      }
    }
    let a = H[0], bb = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
    for (let i = 0; i < 64; i++) {
      const t1 = (h + (ror(e, 6) ^ ror(e, 11) ^ ror(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + W[i]) | 0;
      const t2 = ((ror(a, 2) ^ ror(a, 13) ^ ror(a, 22)) + ((a & bb) ^ (a & c) ^ (bb & c))) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = bb; bb = a; a = (t1 + t2) | 0;
    }
    H = [(H[0] + a) | 0, (H[1] + bb) | 0, (H[2] + c) | 0, (H[3] + d) | 0, (H[4] + e) | 0, (H[5] + f) | 0, (H[6] + g) | 0, (H[7] + h) | 0];
  }
  return H.map(x => (x >>> 0).toString(16).padStart(8, '0')).join('');
}
const cpx = v => Math.round(v * 100);
function bbox(n) {
  const b = n.absoluteBoundingBox;
  return b ? [b.x, b.y, b.width, b.height] : [n.x || 0, n.y || 0, n.width || 0, n.height || 0];
}
// Paint, stroke, effect and opacity summary, so frames that differ only in colour or image
// hash apart. A figma.mixed value (a Symbol, e.g. fills on multi-styled text) is not an
// array or a number, so it summarises as null.
const q = v => (typeof v === 'number' ? Math.round(v * 1000) : null);
const rgb = c => (c ? [q(c.r), q(c.g), q(c.b), q(c.a)] : null);
const paints = v => (Array.isArray(v) ? v.map(p => [p.type, p.visible !== false, q(p.opacity), rgb(p.color), p.imageHash || null,
  p.scaleMode || null, p.gradientStops ? p.gradientStops.map(s => [q(s.position), rgb(s.color)]) : null]) : null);
const effects = v => (Array.isArray(v) ? v.map(e => [e.type, e.visible !== false, q(e.radius), rgb(e.color),
  e.offset ? [q(e.offset.x), q(e.offset.y)] : null, q(e.spread)]) : null);
// Canonical form of one node: type, raw name, size and visibility, text characters, the
// style summary with an INSTANCE's main component key (from `mains`, filled beforehand
// because getMainComponentAsync is async), then each child as [dx, dy, childHash]
// relative to this node, in layer order. Positions and sizes are integer centi-pixels;
// node ids and absolute position are left out, so two copies of the same design hash
// alike wherever they sit.
function canon(n, b, kids, mains) {
  return JSON.stringify([n.type, n.name, cpx(b[2]), cpx(b[3]), n.visible !== false, n.type === 'TEXT' ? n.characters : null,
    [paints(n.fills), paints(n.strokes), q(n.strokeWeight), effects(n.effects), q(n.opacity),
      n.type === 'INSTANCE' ? (mains.get(n.id) || null) : null], kids]);
}
function hashTree(n, b, vis, visit, mains) {
  const kids = [];
  if ('children' in n) for (const c of n.children) {
    const cb = bbox(c);
    kids.push([cpx(cb[0] - b[0]), cpx(cb[1] - b[1]), hashTree(c, cb, vis && c.visible !== false, visit, mains)]);
  }
  visit(n, b, vis);
  return sha256(canon(n, b, kids, mains));
}
// --- end hash ---
const t0 = Date.now();
const LABELS = new Set(['프레임 타이틀', '섹션 타이틀']);
const FRAMEISH = new Set(['FRAME', 'INSTANCE', 'COMPONENT', 'COMPONENT_SET', 'GROUP']);
const NOTEISH = new Set(['TEXT', 'STICKY', 'SHAPE_WITH_TEXT']);
const clip = s => (s.length > 60 ? s.slice(0, 60) + '…' : s);
const sections = [], screens = [], labels = [], notes = [], connectors = [];
function textsOf(n) {
  if (n.type === 'TEXT') return [n.characters];
  if (n.type === 'STICKY' || n.type === 'SHAPE_WITH_TEXT') return [n.text.characters];
  if (!('findAll' in n)) return [];
  return n.findAll(c => c.type === 'TEXT' && c.visible !== false).map(c => c.characters);
}
function vecEnds(n) {
  try {
    const net = n.vectorNetwork, t = n.absoluteTransform, used = [];
    for (const s of net.segments) used.push(s.start, s.end);
    const cap = typeof n.strokeCap === 'string' ? n.strokeCap : null;
    return net.vertices.map((v, i) => ({ v, i })).filter(o => used.filter(k => k === o.i).length === 1).map(o => ({
      x: t[0][0] * o.v.x + t[0][1] * o.v.y + t[0][2], y: t[1][0] * o.v.x + t[1][1] * o.v.y + t[1][2],
      cap: typeof o.v.strokeCap === 'string' && o.v.strokeCap !== 'NONE' ? o.v.strokeCap : cap,
    }));
  } catch (e) { return null; }
}
function walk(cont, sectionId) {
  for (const n of cont.children) {
    const b = bbox(n), name = n.name.trim();
    if (n.type === 'SECTION') {
      sections.push({ id: n.id, name: n.name, parent: sectionId, bb: b });
      walk(n, n.id);
    } else if (n.type === 'INSTANCE' && LABELS.has(name)) {
      labels.push({ id: n.id, kind: name, section: sectionId, bb: b, text: textsOf(n) });
    } else if (n.type === 'CONNECTOR') {
      connectors.push({ id: n.id, type: n.type, name: n.name, section: sectionId, bb: b,
        startNode: n.connectorStart.endpointNodeId || null, endNode: n.connectorEnd.endpointNodeId || null });
    } else if ((n.type === 'VECTOR' || n.type === 'LINE') && n.name.indexOf(' -> ') >= 0) {
      connectors.push({ id: n.id, type: n.type, name: n.name, section: sectionId, bb: b, ends: vecEnds(n) });
    } else if (FRAMEISH.has(n.type)) {
      screens.push({ n, section: sectionId, b });
    } else if (NOTEISH.has(n.type)) {
      notes.push({ id: n.id, type: n.type, section: sectionId, bb: b, text: textsOf(n).join('\n') });
    }
  }
}
const page = await figma.getNodeByIdAsync(ARGS.page);
await figma.setCurrentPageAsync(page);
walk(page, null);
const wanted = new Set();
for (const c of connectors) if (c.name.indexOf(' -> ') >= 0) for (const part of c.name.split(' | ')[0].split(' -> ')) wanted.add(part.trim());
// use_figma caps a return at 48,000 bytes, so the caller reads a big page in ARGS.parts
// slices: every list keeps the items whose index i has i % parts === part.
const pick = xs => xs.filter((x, i) => i % ARGS.parts === ARGS.part);
// A named layer is kept only if one of its edges lies on a connector end (gap capped as
// in TOUCH_MAX_GAP); otherwise names like "Vector" would ship every match on the page.
const endPts = [];
for (const c of connectors) if (c.type !== 'CONNECTOR') {
  const x = c.bb[0], y = c.bb[1], w = c.bb[2], h = c.bb[3];
  const ends = c.ends && c.ends.length === 2 ? c.ends
    : (w >= h ? [{ x, y: y + h / 2 }, { x: x + w, y: y + h / 2 }] : [{ x: x + w / 2, y }, { x: x + w / 2, y: y + h }]);
  for (const e of ends) endPts.push(e);
}
const near = (v, a, b) => Math.max(0, a - v, v - b) <= 400;
const touchesEnd = b => endPts.some(p => ((Math.abs(p.x - b[0]) <= 1 || Math.abs(p.x - b[0] - b[2]) <= 1) && near(p.y, b[1], b[1] + b[3]))
  || ((Math.abs(p.y - b[1]) <= 1 || Math.abs(p.y - b[1] - b[3]) <= 1) && near(p.x, b[0], b[0] + b[2])));
async function screenOf(id) {
  let n = id ? await figma.getNodeByIdAsync(id) : null;
  while (n && n.parent && n.parent.type !== 'SECTION' && n.parent.type !== 'PAGE') n = n.parent;
  return n ? n.id : null;
}
const resolved = [];
for (const c of pick(connectors)) if (c.type === 'CONNECTOR') resolved.push({ id: c.id, start: await screenOf(c.startNode), end: await screenOf(c.endNode) });
const frames = [], named = [];
for (const s of pick(screens)) {
  let nodes = 0, reactionCount = 0, textChars = 0, textsCut = 0;
  const texts = [], seen = new Set(), reactions = [];
  const visit = (n, b, vis) => {
    nodes += 1;
    if (n.type === 'TEXT' && vis) {
      const t = clip(n.characters.trim());
      if (t && !seen.has(t)) {
        seen.add(t);
        if (texts.length < 30 && textChars + t.length <= 900) { texts.push(t); textChars += t.length; } else textsCut += 1;
      }
    }
    if (n !== s.n && wanted.has(n.name.trim()) && touchesEnd(b)) named.push({ id: n.id, name: n.name, screen: s.n.id, bb: b });
    if ('reactions' in n) for (const r of n.reactions) {
      reactionCount += 1;
      for (const a of (r.actions || (r.action ? [r.action] : []))) if (a && a.destinationId) {
        reactions.push({ node: n.id, trigger: r.trigger ? r.trigger.type : null, dest: a.destinationId, navigation: a.navigation || null });
      }
    }
  };
  const mains = new Map();
  const insts = 'findAllWithCriteria' in s.n ? s.n.findAllWithCriteria({ types: ['INSTANCE'] }) : [];
  if (s.n.type === 'INSTANCE') insts.push(s.n);
  for (const i of insts) {
    const mc = await i.getMainComponentAsync();
    mains.set(i.id, mc ? mc.key : null);
  }
  const hash = hashTree(s.n, s.b, s.n.visible !== false, visit, mains);
  frames.push({ id: s.n.id, type: s.n.type, name: s.n.name, section: s.section, bb: s.b, visible: s.n.visible !== false,
    hash, nodes, texts, textsCut, reactions, reactionCount });
}
return { fileName: figma.root.name, page: ARGS.page, part: ARGS.part, parts: ARGS.parts,
  sections: pick(sections), frames, labels: pick(labels), notes: pick(notes), connectors: pick(connectors), resolved, named,
  ms: Date.now() - t0 };
"""

# Reading is all the index needs, so anything that writes is refused outright: a
# property or element assignment, a mutating Plugin API call, or any set*() except
# the page switch. Strings and comments are blanked first so their text cannot trip it.
_STRIP = re.compile(r"//[^\n]*|/\*.*?\*/|'(?:\\.|[^'\\\n])*'|\"(?:\\.|[^\"\\\n])*\"|`(?:\\.|[^`\\])*`", re.S)
_MUTATIONS = [
    (re.compile(r"\.\s*[A-Za-z_$][\w$]*\s*(?:\*\*|<<|>>>|>>|&&|\|\||\?\?|[+\-*/%&|^])?=(?![=>])"), "property assignment"),
    (re.compile(r"\]\s*(?:\*\*|<<|>>>|>>|&&|\|\||\?\?|[+\-*/%&|^])?=(?![=>])"), "element assignment"),
    (re.compile(r"(?:\.\s*[\w$]+|\])\s*(?:\+\+|--)|(?:\+\+|--)\s*[\w$]+\s*[.\[]"), "increment on a member"),
    (re.compile(r"\.\s*(?:create\w*|remove|appendChild|insertChild|resize\w*|rescale|commitUndo|triggerUndo|"
                r"clone|flatten|group|ungroup|union|subtract|intersect|exclude|detachInstance|swapComponent|"
                r"loadFontAsync|closePlugin|notify|saveVersionHistoryAsync|importComponent\w*|"
                r"importStyle\w*|importVariable\w*|scrollAndZoomIntoView|showUI|deleteCharacters|insertCharacters)\s*\("),
     "mutating API call"),
    (re.compile(r"\bset(?!CurrentPageAsync\b)[A-Z]\w*\s*\("), "set*() call"),
    (re.compile(r"\bObject\s*\.\s*(?:assign|defineProperty|defineProperties|setPrototypeOf)\b|\bdelete\s"), "object mutation"),
]


def read_only_violations(code: str) -> list[str]:
    bare = _STRIP.sub(lambda m: "_" if m.group(0)[0] in "'\"`" else " ", code)
    out = []
    for rx, what in _MUTATIONS:
        for m in rx.finditer(bare):
            line = bare.count("\n", 0, m.start()) + 1
            out.append(f"line {line}: {what}: {m.group(0).strip()}")
    return out


def script_for(page_id: str, part: int = 0, parts: int = 1) -> str:
    code = f"const ARGS = {json.dumps({'page': page_id, 'part': part, 'parts': parts})};\n{INDEX_JS}"
    if (bad := read_only_violations(code)):
        die("refusing to send a use_figma script that is not read-only:\n" + "\n".join(bad))
    return code
