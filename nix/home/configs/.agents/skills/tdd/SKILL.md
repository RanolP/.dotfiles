---
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
Confirm with the user what interface changes are needed and which behaviors matter most -- you can't test everything; focus on critical paths and complex logic, not every edge case. Design the interface for testability (small surface, deep implementation). List the behaviors to test (not implementation steps). Get approval before writing code.

## Phase 2: Tracer bullet
Write ONE test that confirms ONE thing end-to-end. RED (it fails) -> GREEN (minimal code to pass). This proves the path works.

## Phase 3: Incremental loop
For each remaining behavior: write the next test (RED) -> minimal code to pass (GREEN). One test at a time; only enough code to pass the current test; don't anticipate future tests; keep tests on observable behavior.

## Phase 4: Refactor
Only once all tests are GREEN: extract duplication, deepen modules (complexity behind simple interfaces), apply SOLID where natural, reconsider existing code in light of the new code. Run tests after each refactor step.

## Per-cycle checklist
- Test describes behavior, not implementation
- Test uses the public interface only
- Test would survive an internal refactor
- Code is minimal for this test; no speculative features

## Constraints
- NEVER write all tests up front (horizontal slicing)
- NEVER refactor while RED -- get to GREEN first
- NEVER mock internal collaborators or test private methods
