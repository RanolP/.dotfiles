Decompose the current task and execute it using the orchestrator pattern.

## WHEN to invoke
- Non-trivial task with 2 or more independently meaningful steps
- Invoke this before writing any code or running any commands

## Phase 1: Decompose
Break the task into the smallest independently meaningful sub-tasks. Each sub-task must have a single clear output.

## Phase 2: Draw the DAG
Identify dependencies. A sub-task with no incoming edges is parallelizable. A sub-task with dependencies must wait.

## Phase 3: Register
Call TaskCreate for every sub-task. The user must see the full plan before any work begins.

## Phase 4: Execute by topology
- Independent nodes: dispatch in parallel via Agent tool in a single message (multiple Agent calls)
- Dependent nodes: hand off sequentially; carry only (goal + relevant files), never the full thread history
- Mark each task `in_progress` before starting; mark `completed` only after confirming the result

## Phase 5: Synthesize
Collect results in the orchestrator thread. Resolve conflicts. Confirm completion with the user.

## Constraints
- NEVER start work before all tasks are registered
- NEVER carry full thread history into a sub-agent handoff
- NEVER run long or destructive commands with `run_in_background` unless user explicitly asks
- When context accumulates unrelated work, invoke /handoff to reset
