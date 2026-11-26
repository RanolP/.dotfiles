# Maintain a verify skill

A feature map rots as the app changes. Use this pass when the user asks to audit a repo's `verify-<app>` skill, or from a scheduled run, to bring the skill and its `features/` back in line with the app. The unit of rigor is the feature: every feature file gets source coverage and a live drive, without proving every bullet.

## Outcome and edit scope

The pass ends in exactly one outcome, named in the reply:

- `clean` -- every feature got source and live coverage, and nothing needs changing.
- `changed` -- proven corrections to the map, the harness or the skill body, left in the working tree and reported; commit or open a draft PR only when the user asks.
- `blocked` -- coverage could not finish, or a proven fix could not land safely; name the exact blocker.

Edits stay inside the `verify-<app>/` directory: its `SKILL.md`, `features/`, `journeys/` and the helper scripts it owns. Product code stays as it is. A behavior the map describes and the app no longer does is either doc drift (fix the map) or a product regression (report it to the user, and keep the map describing the intended behavior) -- a doc edit never hides a regression.

## Pass

0. **Locate the target.** Find the skill by its shape: launch and drive sections plus a `features/` map, under `<repo>/.claude/skills/verify-*/` or `<repo>/.agents/skills/verify-*/`. With several candidates, ask which one by name; with none, stop and offer to generate one with this skill's step 1.
1. **Index hygiene.** Read `features/README.md` and list its sibling files. Fix index lines that are missing, extra, duplicated, or point at a file that is gone.
2. **Source wave.** Send one read-only worker per feature file, all in one message. Each explains how that user-facing feature works from the current source, flags likely drift with `file:line` citations, and returns exactly `{feature: str, summary: str, source_entry_points: [str], drift: [{claim: str, source: str}] | "none", recipe: str}`. Workers read only; they drive nothing and edit nothing.
3. **Reconcile.** Require a returned summary for every feature file, and re-send a worker whose result lacks one. Merge overlapping recipes into as few app states as practical. Spot-check each cited drift against the source; leave claims reported clean unproven. Sweep recent churn (`git log --since` over the routes, commands and menus) for user-facing surfaces missing from the map, and call one missing only with a concrete source path.
4. **Live pass.** Run it even when the source looks clean; you drive, following the skill's own launch model (one long-lived instance driven serially, or a fresh session per drive for a short-lived CLI). Exercise every feature at least once under the three invariants of this skill's step 4. Then:
   - A doctor failure caused by drift in the skill itself is drift: fix it within the edit scope and retry once, restarting only what the fix invalidated, before calling the pass `blocked`.
   - A feature counts as `verified-unreachable` only with the concrete prerequisite it lacks (auth, entitlement, OS, external state) and the route attempted; a map that omits that prerequisite has drifted.
   - Re-drive every harness fix live before it lands, and run the final teardown after the last drive, re-proofs included. Evidence stays.
5. **Triage.** Classify each disagreement as this skill's step 5 does: doc drift, harness gap, or product regression. A harness fix follows the Helpers rule (executable, invocation in the body).
6. **Land or stop.** For `changed`, re-read every changed file, then report the diff. For `clean` or `blocked`, report the outcome and the coverage as it was.

Keep run notes (features covered, unreachable prerequisites, confirmed drift, outcome) in the scratchpad, out of the repo.

## Reply

The outcome; features covered from source and live, each with its evidence path; drift fixed, with the files changed; product regressions found; unreachable features with their prerequisite; what stayed unverified.

---

*Adapted from pstack 0.15.48 (MIT, Lauren Tan): `skills/maintain-verification-skill`.*
