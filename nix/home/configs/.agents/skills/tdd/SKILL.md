---
name: tdd
description: Test-driven development via red-green-refactor in vertical slices.
when_to_use: When building a feature or fixing a bug test-first, when the user mentions "red-green-refactor", TDD, or wants tests that survive refactors. Invoke before writing the implementation.
---

## Principle
Tests verify behavior through the public interface, not implementation. Good tests read like a specification ("user can checkout with valid cart") and survive refactors because they ignore internal structure. The warning sign of a bad test: it breaks when you rename an internal function though behavior is unchanged -- it was testing implementation.

## Anti-pattern: horizontal slices
Do NOT write all tests first, then all implementation. Tests written in bulk test imagined behavior and the *shape* of things (signatures, data structures), not actual user-facing behavior; they pass when behavior breaks and fail when it is fine. Instead, vertical slices: one test -> one implementation -> repeat. Each test responds to what the previous cycle taught you.

```
WRONG (horizontal):  RED: t1 t2 t3 t4 t5   GREEN: i1 i2 i3 i4 i5
RIGHT (vertical):    RED->GREEN: t1->i1, t2->i2, t3->i3, ...
```

## Phase 1: Plan
Confirm with the user what interface changes are needed and which behaviors matter most -- you can't test everything; focus on critical paths and complex logic, not every edge case. Design the interface for testability (small surface, deep implementation). List the behaviors to test (not implementation steps), and keep only the entries whose escaping regression you can state in one sentence. Get approval before writing code.

## Phase 2: Tracer bullet
Write ONE test that confirms ONE thing end-to-end. RED (it fails) -> GREEN (minimal code to pass). This proves the path works.

## Phase 3: Incremental loop
For each remaining behavior: write the next test (RED) -> minimal code to pass (GREEN). One test at a time; only enough code to pass the current test; don't anticipate future tests; keep tests on observable behavior.

## Phase 4: Refactor
Only once all tests are GREEN: extract duplication, deepen modules (complexity behind simple interfaces), apply SOLID where natural, reconsider existing code in light of the new code. Run tests after each refactor step.

## Bug fix
A reported bug skips Phase 1's approval and runs this path:
1. Write one test through the public interface that reproduces the reported symptom.
2. Run it before touching the code and confirm it fails for the reported reason -- an import error, typo or missing fixture is a broken test, not a reproduction.
3. Apply the smallest fix, rerun the test until it passes, then rerun the suites the fix reaches.
4. When a failing test is impractical, capture the repro another way before the fix -- a script that exits non-zero, a before/after screenshot diff, an audio metric or a listenable Artifact -- and run the same capture after it.
5. Report the test or repro name with its failing output before the fix and its passing output after.

## Per-cycle checklist
- The RED names in one sentence the real regression it catches; a sentence you cannot finish means this cycle skips the test and moves on
- Test describes behavior, not implementation
- Test uses the public interface only
- Two-edit check: breaking the behavior (wrong value, skipped or doubled effect) turns the test red, and changing only the internals keeps it green; an expected value computed by the code under test, or an assertion on data the test built itself, fails the first edit
- Code is minimal for this test; no speculative features

## Constraints
- NEVER write all tests up front (horizontal slicing)
- NEVER refactor while RED -- get to GREEN first
- NEVER mock internal collaborators or test private methods
