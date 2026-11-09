// Compares two versions of one patch file by the code each version produces, not by its diff text.
// Both versions patch the same upstream file, so their old-side line numbers are a shared coordinate:
// hunks are aligned on old-side ranges, each version's post-image is rebuilt over the merged range,
// and the two post-images are diffed. render.mjs renders the result; interdiff.test.mjs checks it.
// Plain JavaScript with no imports, so the check runs without the renderer's packages.

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+|_)(?:,(\d+))? @@/;
const strip = (p) => p.trim().replace(/^"|"$/g, '').replace(/^[ab]\//, '');

// Parses a unified diff into files and hunks, and returns the text with every unnumbered new-side
// start (PaperMC / paperweight's `@@ -223,6 +_,37 @@`) replaced by the start it implies: the old start
// plus the lines earlier hunks of the same file added minus removed.
export function parsePatch(text) {
  const files = [], out = [];
  let file = null, hunk = null, oldLeft = 0, newLeft = 0, offset = 0;
  const startFile = () => { file = { name: null, oldName: null, sawMinus: false, hunks: [] }; files.push(file); offset = 0; };
  for (const line of text.split('\n')) {
    if (hunk && (oldLeft > 0 || newLeft > 0)) {
      // An empty line inside a hunk is a context line whose leading space an editor trimmed.
      const t = line === '' && oldLeft > 0 && newLeft > 0 ? ' ' : line[0];
      if (t === '\\') { out.push(line); continue; }
      if ((t === ' ' && oldLeft > 0 && newLeft > 0) || (t === '-' && oldLeft > 0) || (t === '+' && newLeft > 0)) {
        hunk.lines.push({ t, s: line.slice(1) });
        if (t !== '+') oldLeft--;
        if (t !== '-') newLeft--;
        out.push(line);
        continue;
      }
      hunk = null; // malformed or short hunk: treat the line as header text
    }
    const m = file ? line.match(HUNK) : null;
    if (m) {
      const oldStart = +m[1], oldCount = m[2] == null ? 1 : +m[2], newCount = m[4] == null ? 1 : +m[4];
      let newStart = m[3];
      if (newStart === '_') {
        newStart = oldStart + offset + (oldCount === 0 ? 1 : 0) - (newCount === 0 ? 1 : 0);
        out.push(line.replace(/\+_/, `+${newStart}`));
      } else { newStart = +newStart; out.push(line); }
      offset += newCount - oldCount;
      hunk = { oldStart, oldCount, newStart, newCount, lines: [] };
      file.hunks.push(hunk);
      [oldLeft, newLeft] = [oldCount, newCount];
      continue;
    }
    out.push(line);
    const git = line.match(/^diff --git (\S+) (\S+)$/);
    if (git) { startFile(); file.oldName = strip(git[1]); file.name = strip(git[2]); continue; }
    if (line.startsWith('--- ')) {
      if (!file || file.sawMinus || file.hunks.length) startFile();
      file.sawMinus = true;
      const p = line.slice(4).split('\t')[0];
      if (p.trim() === '/dev/null') file.added = true; else file.oldName = strip(p);
      continue;
    }
    if (file && line.startsWith('+++ ')) {
      const p = line.slice(4).split('\t')[0];
      if (p.trim() === '/dev/null') file.deleted = true; else file.name = strip(p);
    }
  }
  for (const f of files) { f.name = (f.deleted ? f.oldName : f.name) ?? f.oldName; delete f.sawMinus; }
  return { files: files.filter((f) => f.hunks.length), text: out.join('\n') };
}

export const normalizeUnnumberedHunks = (text) => (/^@@ .*\+_/m.test(text) ? parsePatch(text).text : text);

// `foo@1.2.0.patch`, `@scope__foo@1.2.0.patch` (pnpm), `foo+1.2.0.patch` (patch-package).
export function patchPackage(fileName) {
  const m = fileName.match(/^(.+)[@+](\d[\w.\-]*)\.(?:patch|diff)$/);
  return m ? { pkg: m[1], version: m[2] } : null;
}

const oldRange = (h) => { const s = h.oldCount ? h.oldStart : h.oldStart + 1; return [s, s + h.oldCount - 1]; };

// Upstream lines by old-side line number, from the context and removed lines of both versions.
// Returns the first line number where the two versions disagree on the upstream text, if any.
function upstream(versions) {
  const up = new Map(); let conflict = null;
  for (const f of versions) for (const h of f.hunks) {
    let n = oldRange(h)[0];
    for (const l of h.lines) {
      if (l.t === '+') continue;
      if (up.has(n) && up.get(n) !== l.s && conflict == null) conflict = n;
      if (!up.has(n)) up.set(n, l.s);
      n++;
    }
  }
  return { up, conflict };
}

// Merges every hunk's old-side range from both versions; ranges that overlap or touch become one region.
export function regions(base, head) {
  const r = [...base.hunks, ...head.hunks].map(oldRange).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (const [s, e] of r) {
    const last = out.at(-1);
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

// The code one version produces over upstream lines s..e, and the post-image line number of its first line.
function postImage(f, [s, e], up) {
  const lines = []; let cur = s, offset = 0;
  for (const h of f.hunks) {
    const [hs, he] = oldRange(h);
    if (he < s) { offset += h.newCount - h.oldCount; continue; }
    if (hs > e + 1) break;
    while (cur < hs) lines.push(up.get(cur++));
    for (const l of h.lines) if (l.t !== '-') lines.push(l.s);
    cur = hs + h.oldCount;
  }
  while (cur <= e) lines.push(up.get(cur++));
  return { start: s + offset, lines };
}

// Line diff by longest common subsequence after trimming the shared prefix and suffix.
// Returns ops [type, text] with type ' ', '-' (only in a) or '+' (only in b).
export function diffLines(a, b) {
  let p = 0, q = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p++;
  while (q < a.length - p && q < b.length - p && a[a.length - 1 - q] === b[b.length - 1 - q]) q++;
  const A = a.slice(p, a.length - q), B = b.slice(p, b.length - q), n = A.length, m = B.length, W = m + 1;
  const ops = a.slice(0, p).map((s) => [' ', s]);
  if (n * m > 4e7) { // too large for the table: show the middle as replaced rather than run out of memory
    ops.push(...A.map((s) => ['-', s]), ...B.map((s) => ['+', s]));
  } else {
    const L = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i * W + j] = A[i] === B[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (A[i] === B[j]) { ops.push([' ', A[i]]); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) ops.push(['-', A[i++]]);
      else ops.push(['+', B[j++]]);
    }
    while (i < n) ops.push(['-', A[i++]]);
    while (j < m) ops.push(['+', B[j++]]);
  }
  ops.push(...a.slice(a.length - q).map((s) => [' ', s]));
  return ops;
}

// Unified-diff hunks (3 lines of context) for ops whose sides start at line aStart and bStart.
function toHunks(ops, aStart, bStart, C = 3) {
  const pos = []; let ai = 0, bi = 0;
  for (const [t] of ops) { pos.push([ai, bi]); if (t !== '+') ai++; if (t !== '-') bi++; }
  const changed = ops.map((o, k) => (o[0] !== ' ' ? k : -1)).filter((k) => k >= 0);
  const out = [];
  for (let g = 0; g < changed.length;) {
    let last = changed[g], h = g + 1;
    while (h < changed.length && changed[h] - last <= 2 * C + 1) last = changed[h++];
    const from = Math.max(0, changed[g] - C), to = Math.min(ops.length - 1, last + C);
    const slice = ops.slice(from, to + 1);
    const ac = slice.filter((o) => o[0] !== '+').length, bc = slice.filter((o) => o[0] !== '-').length;
    const [a0, b0] = pos[from];
    out.push(`@@ -${aStart + a0 - (ac ? 0 : 1)},${ac} +${bStart + b0 - (bc ? 0 : 1)},${bc} @@`, ...slice.map(([t, s]) => t + s));
    g = h;
  }
  return out;
}

// Compares one target file as patched by two versions of a patch.
// Returns { hunks: unified-diff hunk lines of base post-image vs head post-image (empty when both
// produce the same code), aligned: whether hunks were aligned on upstream line numbers, conflict }.
// With `inOrder` (the upstream source differs, such as a package version bump) or when the two
// versions disagree on an upstream line, the post-images are concatenated in hunk order instead.
export function interdiffFile(base, head, { inOrder = false } = {}) {
  const { up, conflict } = upstream([base, head]);
  if (inOrder || conflict != null) {
    const all = (f) => f.hunks.flatMap((h) => h.lines.filter((l) => l.t !== '-').map((l) => l.s));
    return { hunks: toHunks(diffLines(all(base), all(head)), 1, 1), aligned: false, conflict };
  }
  const hunks = [];
  for (const r of regions(base, head)) {
    const a = postImage(base, r, up), b = postImage(head, r, up);
    hunks.push(...toHunks(diffLines(a.lines, b.lines), a.start, b.start));
  }
  return { hunks, aligned: true, conflict };
}
