---
name: refactor
description: Change structure while holding behavior -- pin the current behavior with a characterization test or recorded outputs, name the missing structure and the target shape, subtract before adding, migrate every caller and delete the old API in the same wave, prove equivalence on the real artifact, and keep the diff only when it lowers reader load.
when_to_use: When the user asks to refactor, restructure, clean up, simplify, untangle, reshape an API, or rename across a codebase, and the change is meant to keep behavior. A change that adds behavior is a feature; one that corrects behavior is a bug fix (skill `diagnose`).
---

# Refactor

You own the contract; the structure changes and the behavior does not. Follow the steps in order and state them in the reply before the first edit.

## 1. Pin the behavior first

Trace the affected subsystem until you can state its contract, then capture current behavior before any structure moves, following the "Behavior-preserving change" section of skill `tdd`: run the real entry points on representative inputs, edge cases included, and save the outputs. Where the area has a test runner, write those cases as a characterization test or snapshot that passes at HEAD, so every later step can rerun it. A type check and a lint run pass on code that behaves differently, so they never count as the pin.

## 2. Name the missing structure and the target shape

Write down, before editing, what the code lacks (a type that makes an invalid state unrepresentable, a domain boundary per skill `modularize-by-domain`, one owner for a duplicated rule) and the module layout, types and call graph you would build today. The reshape earns its place by deleting branches or invalid states; a new wrapper, layer or indirection that leaves every branch in place is the opposite. When the shape is already clear and local, leave the code as it is.

## 3. Subtract before you add

Delete dead code (skill `remove-dead-code`), collapse one-caller wrappers, drop redundant validation and orphan references, then introduce the new shape. Ship the smallest change that reaches the target shape, and revert a speculative cleanup that only "might help".

## 4. Move in small steps, each keeping the pin green

- Rerun the pin after each step.
- For an API reshape inside one deploy unit, migrate every caller and delete the old API in the same wave, leaving no compatibility shim and no parallel old and new path. Do the migration with a codemod per skill `build-the-lever`. Where the old API has a reader you cannot migrate in the same change (a published package, a deployed service boundary, another repo), use expand, switch, contract across PRs instead (`github-master/guides/pr.md`, case 3).
- After every rename, `rg -F '<old name>'` across code, docs, comments, config and string literals prints nothing, or only lines you name as intended. Renames miss usages in strings, prose and back-references.
- A bug or missing feature found on the way goes to its own follow-up change after the reshape, so the reshape stays comparable against the pin; list it in the reply.

## 5. Prove equivalence on the real artifact

Rerun the pin and diff against the HEAD outputs; the diff is empty. For a larger reshape, run the old and new code side by side on the same inputs and diff the outputs:

```sh
git worktree add --detach <scratchpad>/refactor-base HEAD
# run the same entry point with the same inputs in <scratchpad>/refactor-base and in the working tree
diff <scratchpad>/out-base.txt <scratchpad>/out-new.txt   # prints nothing
git worktree remove <scratchpad>/refactor-base
```

A UI or device surface gets a recorded flow replayed on both sides (skill `record-replay`).

## 6. Keep it only if reader load dropped

Name what the diff removed: a layer, a branch, a wrapper, a duplicated rule, an invalid state. With nothing to name, revert the refactor.

## 7. Order the commits

A subtraction commit, then the reshape, then any follow-on cleanup, each green against the pin on its own; build the stack per skill `git-master`.

## Reply

The structure that changed, the pin it was held against, the equivalence command and its output, what the diff removed, the follow-up bugs or features split out, and anything reverted.

---

*Adapted from pstack 0.15.48 (MIT, Lauren Tan): `skills/poteto-mode/playbooks/refactoring.md`.*
