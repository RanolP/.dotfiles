// Catches: an interdiff that shows a hunk only one version touches as a whole-block change, or that
// fills upstream lines it never saw, when the two versions of a patch cover overlapping old-side ranges;
// and an unnumbered PaperMC hunk header (`+_`) left in place, which the diff parser rejects.
// run: node interdiff.test.mjs
import assert from 'node:assert/strict';
import { interdiffFile, normalizeUnnumberedHunks, parsePatch } from './interdiff.mjs';

// Upstream lines 1..20 are "u1".."u20". Base edits u12; head edits u12 the same way and also u16,
// with a hunk that reaches further down; a second head-only hunk sits far below at u40.
const base = `--- a/f.ts
+++ b/f.ts
@@ -10,5 +10,5 @@
 u10
 u11
-u12
+B12
 u13
 u14
`;
const head = `--- a/f.ts
+++ b/f.ts
@@ -10,9 +_,10 @@
 u10
 u11
-u12
+B12
 u13
 u14
 u15
-u16
+H16
+H16b
 u17
 u18
@@ -39,3 +_,3 @@
 u39
-u40
+H40
 u41
`;

const [b] = parsePatch(base).files, [h] = parsePatch(head).files;
assert.equal(h.hunks[0].newStart, 10);
assert.equal(h.hunks[1].newStart, 40, 'second hunk starts after the +1 line offset of the first');
assert.match(normalizeUnnumberedHunks(head), /^@@ -39,3 \+40,3 @@$/m);

const r = interdiffFile(b, h);
assert.equal(r.aligned, true);
assert.deepEqual(r.hunks, [
  // Region u10..u18: base's post-image is filled with u15..u18 taken from head's context lines;
  // the shared B12 edit is not reported. Line numbers are post-image numbers on each side.
  '@@ -13,6 +13,7 @@', ' u13', ' u14', ' u15', '-u16', '+H16', '+H16b', ' u17', ' u18',
  // Region u39..u41 exists only in head: base produces the upstream lines there.
  '@@ -39,3 +40,3 @@', ' u39', '-u40', '+H40', ' u41',
]);

// The two versions disagree on an upstream line (u11 vs X11): fall back to post-images in hunk order.
const drifted = parsePatch(base.replace(' u11', ' X11')).files[0];
assert.equal(interdiffFile(drifted, h).aligned, false);
console.log('interdiff: ok');
