Present multi-domain information one domain at a time.

## WHEN to invoke
- Task involves 2 or more distinct domains (e.g., frontend + backend, config + code, auth + storage)
- Invoke before presenting information that spans multiple concerns

## Phase 1: Identify domains
List all domains involved. Order by dependency or logical sequence.

## Phase 2: Present one domain
Show the current domain: findings, recommendation, proposed action.

## Phase 3: Await
REQUEST confirmation, modification, or "go back" before proceeding.
Every step must have an escape hatch -- the user drives.

## Phase 4: Proceed
Move to the next domain only after explicit user confirmation.

## Constraints
- NEVER dump all domains at once
- NEVER proceed to the next domain without user confirmation
- NEVER omit a domain to save space -- omission transfers cognitive burden to the user
