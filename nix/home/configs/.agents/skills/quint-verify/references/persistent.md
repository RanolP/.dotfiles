# Promote a spec to a persistent repo check

The loop in `SKILL.md` writes a spec to the scratchpad and ends in a report. When the modelled code keeps changing and its property is worth rechecking on every change, move the spec into the repo beside the code and tie it to the code with a replay test. clm's fold job is the worked instance; the clm mod was removed in 89affcc, so read its files from the parent commit (`git show 89affcc^:nix/home/configs/claude/mods/clm/spec/fold-job.qnt`):

- `spec/fold-job.qnt` -- the model, its run commands in the header, and instances bound to current and past code;
- `spec/fold-job-traces.sh` -- samples the `current` instance and writes `spec/fold-job-traces.ts`;
- `hooks/fold-conformance.test.ts` -- replays every sampled trace against the real `fold-job.ts` and `register.ts`.

Write every piece for an agent who opens it cold in the middle of an unrelated change: from the files alone it must tell whether its change touches the covered code, run the check, and tell a code bug from a model error.

## Choose the target

Pick a promise the code makes whose break harms the user and whose breaking order tests rarely reach: a retry, a claim or lease, a multi-step persist, a queue whose messages must neither vanish nor repeat. Take the strongest such target in the repo, not the easiest to model. Read the answer from the code, and ask the user only what the code cannot show.

## Layout

Put the spec at `spec/<concern>.qnt` inside the module it describes. Open it with a header in this order:

1. `// Run:` -- the one command that checks it, with `nice -n 15`, every invariant and witness named, and a fixed `--seed` (`fold-job.qnt:1`).
2. `// Red on ...:` -- the same command per bug instance and the invariant each violates (`fold-job.qnt:2`).
3. `// Regenerate ...:` -- the trace script, when a replay exists (`fold-job.qnt:3`).
4. `// Covers:` -- the files and functions the model describes.
5. `// Synced: <sha>` -- the commit at which you last confirmed that the model describes those files.
6. A paragraph saying what the model is and which sizes or values it abstracts.

`fold-job.qnt` predates lines 4-5; add them to a spec you create, and add them to `fold-job.qnt` at its next resync.

Cite the code on each action and each record field (`fold-job.qnt`'s `Msg` fields point at `register.ts:589-597`, `fold.ts:90`). End the file with instances: `current` binds today's code, and each fixed bug keeps an instance named after it whose consts restore that behaviour, with a comment naming its commit (`head` is 9928335, `prefix` is 520a61f, `unguarded` is a mutation toggle). Those instances keep "the check can fail" provable in the repo after the fix lands.

## Tie the model to the code

A model that passes describes the model. The conformance replay is what shows the code moves the same way:

1. A script runs the `current` instance with `--mbt --out-itf` at a fixed SEED, TRACES and STEPS and packs each state's variables, `mbt::actionTaken` and `mbt::nondetPicks` into a generated `.ts` (the plugin test loader imports code files only). Its first line records the seed and counts and says the file is generated.
2. A test drives the real functions through a fake IO whose awaits wait on gates the trace opens one step at a time, and after every step compares each model variable with the code's observable state (`fold-conformance.test.ts` compares queue membership with `inStore`, the job with `phase`, the pending write with `swap.pc`).
3. One more test asserts that the traces cover every model action (the test 'the replayed traces cover every model action' in `fold-conformance.test.ts`), so a regenerated sample that loses an action fails loudly.

Run a mod's tests with `claude plugin test .` from the mod folder (`docs/src/claude-code.md:34`); elsewhere use the repo's own runner. The replay catches disagreement on sampled traces only; code paths the model has no action for stay invisible to it, and the resync pass below is what finds them.

## Prove it before handing off

Make a scratch break in the real code of the kind the property guards against -- drop a guard, swap two persist steps -- and run the conformance test and the `// Run:` command. Both must go red. Revert the break and confirm the check is back to green, or red only on findings you report. Report a property the current code breaks as a finding, with the counterexample told in the code's words; keep the property and the product code as they are unless the user asks for a fix.

Commit the spec, the trace script, the generated traces and the test together, apart from any product fix, and add each new path to `REUSE.toml`.

## Resync

Run this pass after covered code changed without the spec moving with it -- a merge, another session's edit, several commits of drift -- or when the user asks whether the model is still true to the code. A stale pass is the dangerous case: it looks like a proof of code that no longer exists.

1. **Sync point.** Read `// Synced:`. With no such line, use `git log -1 --format=%h -- <spec>` and say that you did.
2. **Run as is.** Run the `// Run:` command, each `// Red on` command and the conformance test once, and record the results. Classify a failure only at step 5.
3. **Read every change.** `git log --format='%h %s' <sync>..HEAD -- <covered files>` and `git diff <sync> -- <covered files>`; follow a renamed or moved covered function with `git log -S'<name>'`, and grep for new writers of the state the property guards. Sort each change:
   - **no effect** -- checked against the model, not the commit message;
   - **shape changed** -- one atomic region became two, a branch appeared or went, a new path reaches the guarded state: the model changes;
   - **promise changed on purpose** -- a test, doc comment or commit message says so: the property changes, and you record the old wording, the new wording and that evidence;
   - **promise possibly broken** -- no evidence of intent: a failure that follows is a bug candidate.
4. **Update from the code.** Edit the model so each changed part again cites code a reviewer can open, one atomic region per action, before rerunning. Keep the bounds; report any bound you lower. Regenerate the traces.
5. **Rerun and judge.** On a pass, break the new code the way the property guards against and confirm the check catches it. On a failure, replay the counterexample (`--seed <s> --mbt`) step by step against the code: a step the code cannot take is a model error, fixed and reported as one; a trace whose every step the code can take is a bug -- name the commit that introduced it, tell the steps in the code's words, and state the harm in one sentence. When a scratch test or repro against the real code shows the bug cheaply, attach it to the report as evidence and keep it out of the commit.
6. **Move the sync point** to the checked commit for an in-sync or updated check only, and record covered files and commands again in the header.

Give each check one outcome:

- **in-sync** -- nothing since the sync point alters what the model describes, and the check passes;
- **updated** -- the model now describes the new code, and the check passes;
- **bug** -- the model describes the current code, and the code breaks the property;
- **blocked** -- the check could not be brought in line or could not run; say exactly why, and leave `// Synced:` where it was.

A check can be updated and bug at once. When a check passed before the update and fails after it, say that the old pass was on a stale description.

Report per check: the outcome, the commits read, each model or property change with its reason, the rerun result and the break that proved the check can still fail, each bug in plain words, and the covered code the model still has no action for. Commit the spec updates on their own, apart from any product fix.

<!--
Adapted (modified, condensed into a quint-verify reference built on the clm fold-job check) from
pstack 0.15.48, github.com/cursor/plugins/tree/main/pstack, skills/create-formal-verification-skill/SKILL.md
and skills/maintain-formal-verification-skill/SKILL.md -- MIT, Copyright (c) 2026 Lauren Tan.
Changes and original text: Copyright 2026 RanolP, MIT.
-->
