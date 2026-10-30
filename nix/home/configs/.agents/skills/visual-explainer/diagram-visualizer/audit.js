// Measures rules.md on the page as the browser rendered it, so an
// overlap or overflow that the source hides shows up as a number.
// Run on the open page: agent-browser --session vd eval --stdin < audit.js
// Prints {fail:[...], info:{...}}; an empty fail list means every rule held.
// Markup it reads (template.html): <svg class="vd" viewBox>,
// g.node > rect|polygon + text, g.callout > circle + text, path.edge (data-flow="backward" for a
// return edge), rect.boundary. Distances are reported in viewBox units.
(() => {
  const fail = [];
  const info = { svgs: 0, nodes: 0, edges: 0, texts: 0 };
  const canvas = document.createElementNS('http://www.w3.org/1999/xhtml', 'canvas'); // works in a bare .svg document too
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const rgba = (css) => {
    if (!css || css === 'none' || css.startsWith('url')) return null;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    return a === 0 ? null : [r, g, b, a / 255];
  };
  const over = (top, base, alpha) => top.slice(0, 3).map((c, i) => c * alpha + base[i] * (1 - alpha));
  const lum = (c) => {
    const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const pageBg = (el) => {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c && c[3] === 1) return c.slice(0, 3);
    }
    return [255, 255, 255];
  };
  const paint = (el, prop, base) => {
    const cs = getComputedStyle(el);
    const c = rgba(cs[prop]);
    if (!c) return null;
    const alpha = c[3] * parseFloat(cs[prop === 'fill' ? 'fillOpacity' : 'strokeOpacity'] || 1) * parseFloat(cs.opacity || 1);
    return over(c, base, alpha);
  };
  const name = (el) => (el.textContent || el.getAttribute('d') || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 40);
  const r1 = (v) => Math.round(v * 10) / 10;

  for (const svg of document.querySelectorAll('svg.vd')) {
    info.svgs++;
    const vb = svg.viewBox.baseVal;
    const box = svg.getBoundingClientRect();
    const k = box.width / vb.width; // screen px per viewBox unit
    const toUnits = (r) => ({ l: (r.left - box.left) / k, t: (r.top - box.top) / k, r: (r.right - box.left) / k, b: (r.bottom - box.top) / k });
    const id = (svg.getAttribute('aria-label') || `svg#${info.svgs}`).slice(0, 32);
    const bg = pageBg(svg);

    // Edge geometry: sample every path.edge in screen space, keep it in viewBox units.
    const edges = [...svg.querySelectorAll('.edge')].map((p) => {
      const m = p.getScreenCTM();
      const len = p.getTotalLength();
      const pts = [];
      for (let s = 0; s <= len; s += 1) {
        const q = new DOMPoint(p.getPointAtLength(s).x, p.getPointAtLength(s).y).matrixTransform(m);
        pts.push([(q.x - box.left) / k, (q.y - box.top) / k]);
      }
      return { el: p, pts };
    });
    info.edges += edges.length;

    // R5 connector shape: axis-aligned segments only; forward <= 1 turn, backward <= 3.
    let backward = 0;
    for (const { el } of edges) {
      const segs = el.getAttribute('d').match(/[MLHVZCSQTA][^MLHVZCSQTA]*/gi) || [];
      const dirs = [];
      let x = 0, y = 0;
      let diagonal = false;
      for (const s of segs) {
        const cmd = s[0];
        const n = (s.slice(1).match(/-?\d*\.?\d+(?:e-?\d+)?/gi) || []).map(Number);
        const rel = cmd === cmd.toLowerCase();
        const C = cmd.toUpperCase();
        if (C === 'M') { x = rel ? x + n[0] : n[0]; y = rel ? y + n[1] : n[1]; continue; }
        if (C === 'H') { const nx = rel ? x + n[0] : n[0]; dirs.push(nx > x ? 'R' : 'L'); x = nx; continue; }
        if (C === 'V') { const ny = rel ? y + n[0] : n[0]; dirs.push(ny > y ? 'D' : 'U'); y = ny; continue; }
        if (C === 'L') {
          const nx = rel ? x + n[0] : n[0], ny = rel ? y + n[1] : n[1];
          if (nx !== x && ny !== y) diagonal = true;
          else dirs.push(nx !== x ? (nx > x ? 'R' : 'L') : (ny > y ? 'D' : 'U'));
          x = nx; y = ny; continue;
        }
        diagonal = true;
      }
      const turns = dirs.filter((d, i) => i > 0 && d !== dirs[i - 1]).length;
      const back = el.dataset.flow === 'backward';
      if (back) backward++;
      if (diagonal) fail.push(`[${id}] R5 diagonal or curved segment in edge "${name(el)}"; draw it with M/H/V`);
      if (turns > (back ? 3 : 1)) fail.push(`[${id}] R5 edge "${name(el)}" turns ${turns} times (max ${back ? 3 : 1}${back ? ', backward' : ''})`);
    }
    if (svg.dataset.kind === 'architecture' && backward > 1) fail.push(`[${id}] R5 ${backward} backward edges in an architecture diagram (max 1); restructure so the dependency runs forward`);

    // Nodes.
    const nodes = [...svg.querySelectorAll('g.node')].map((g) => {
      const shape = g.querySelector('rect, polygon, ellipse, circle, path');
      return { g, shape, u: toUnits(shape.getBoundingClientRect()) };
    });
    info.nodes += nodes.length;
    for (const n of nodes) {
      // R1 height 56 for rectangles; a diamond or terminal mark is exempt.
      if (n.shape.tagName === 'rect' && Math.abs(n.shape.height.baseVal.value - 56) > 0.5 && !n.g.hasAttribute('data-free-size')) {
        fail.push(`[${id}] R1 node "${name(n.g)}" is ${r1(n.shape.height.baseVal.value)} tall (want 56)`);
      }
      // R2 every text inside its node with >= 16 units of horizontal padding.
      for (const t of n.g.querySelectorAll('text')) {
        const u = toUnits(t.getBoundingClientRect());
        const padL = u.l - n.u.l, padR = n.u.r - u.r;
        if (Math.min(padL, padR) < 16 || u.t < n.u.t || u.b > n.u.b) {
          fail.push(`[${id}] R2 text "${name(t)}" overflows its node (padding left ${r1(padL)}, right ${r1(padR)}; want >= 16)`);
        }
      }
    }
    // R3 nodes >= 40 apart.
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i].u, b = nodes[j].u;
      const gap = Math.max(b.l - a.r, a.l - b.r, b.t - a.b, a.t - b.b);
      if (gap < 40) fail.push(`[${id}] R3 nodes "${name(nodes[i].g)}" and "${name(nodes[j].g)}" are ${r1(gap)} apart (want >= 40)`);
    }
    // R3 nodes >= 40 inside a boundary.
    for (const bd of svg.querySelectorAll('rect.boundary')) {
      const B = toUnits(bd.getBoundingClientRect());
      for (const n of nodes) {
        const a = n.u;
        const inside = a.l >= B.l && a.r <= B.r && a.t >= B.t && a.b <= B.b;
        if (!inside) continue;
        const pad = Math.min(a.l - B.l, B.r - a.r, a.t - B.t, B.b - a.b);
        if (pad < 40) fail.push(`[${id}] R3 node "${name(n.g)}" sits ${r1(pad)} from its boundary edge (want >= 40)`);
      }
    }

    // Texts: clearance, contrast, rendered size, clipping.
    for (const t of svg.querySelectorAll('text')) {
      if (!t.textContent.trim()) continue;
      info.texts++;
      const u = toUnits(t.getBoundingClientRect());
      // R6 label box >= 8 units from every edge stroke.
      for (const e of edges) {
        let d = Infinity;
        for (const [px, py] of e.pts) {
          const dx = Math.max(u.l - px, 0, px - u.r), dy = Math.max(u.t - py, 0, py - u.b);
          d = Math.min(d, Math.hypot(dx, dy));
        }
        if (d < 8) fail.push(`[${id}] R6 text "${name(t)}" is ${r1(d)} from edge "${name(e.el)}" (want >= 8)`);
      }
      // R9 nothing outside the viewBox (it would be cut off).
      if (u.l < 0 || u.t < 0 || u.r > vb.width || u.b > vb.height) fail.push(`[${id}] R9 text "${name(t)}" runs past the viewBox edge`);
      // R8 rendered size >= 11 px at this viewport width.
      const px = parseFloat(getComputedStyle(t).fontSize) * k;
      if (px < 11) fail.push(`[${id}] R8 text "${name(t)}" renders at ${r1(px)} px at this width (want >= 11); give the svg a min-width inside an overflow-x container`);
      // R7 contrast against what is behind it.
      const node = t.closest('g.node');
      const holder = t.closest('g.node, g.callout');
      const shape = holder && holder.querySelector('rect, polygon, ellipse, circle, path');
      const behind = (shape && paint(shape, 'fill', bg)) || bg;
      const ink = paint(t, 'fill', behind);
      if (!ink) continue;
      const userSize = parseFloat(getComputedStyle(t).fontSize);
      const shortLabel = node && userSize >= 14 && t.textContent.trim().split(/\s+/).length <= 3;
      const need = shortLabel ? 3 : 4.5;
      const cr = ratio(ink, behind);
      if (cr < need) fail.push(`[${id}] R7 text "${name(t)}" contrast ${r1(cr)}:1 (want >= ${need}:1)`);
    }
    // R7 graphic contrast: edges and node outlines >= 3:1 against the ground.
    for (const el of [...svg.querySelectorAll('.edge'), ...nodes.map((n) => n.shape)]) {
      const st = paint(el, 'stroke', bg);
      const fl = paint(el, 'fill', bg);
      const best = Math.max(st ? ratio(st, bg) : 0, fl ? ratio(fl, bg) : 0);
      if (best < 3) fail.push(`[${id}] R7 "${name(el.closest('g.node') || el)}" stroke/fill contrast ${r1(best)}:1 against the ground (want >= 3:1)`);
    }
  }
  // R8 the page itself never scrolls sideways; a wide diagram scrolls in its own container.
  const doc = document.scrollingElement || document.documentElement;
  if (doc.scrollWidth > window.innerWidth + 1) fail.push(`page scrolls sideways (${doc.scrollWidth} > ${window.innerWidth}); wrap the svg in an overflow-x:auto container`);
  if (!info.svgs) fail.push('no svg.vd on the page');
  info.viewport = `${window.innerWidth}x${window.innerHeight}`;
  info.scheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  return { fail, info };
})();
