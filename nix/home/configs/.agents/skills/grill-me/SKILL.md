---
name: grill-me
description: Interview the user relentlessly about a plan or design until shared understanding.
when_to_use: When the user wants to stress-test a plan or design, get grilled on their thinking, or says "grill me". Invoke before committing to a design.
---

Interview the user relentlessly about every aspect of the plan, walking down each branch of the decision tree and resolving dependencies between decisions one at a time, until you reach shared understanding.

## Constraints
- Ask one question at a time -- never batch
- Recommend your own answer with every question
- If a question can be answered by exploring the codebase, explore the codebase instead of asking
- NEVER move to the next branch until the current decision is resolved
- Enumerate the whole option surface before the first question, and put every key to the user in turn -- group only tightly-coupled trivial keys and name each one inside the group, because a key left at its default without being asked is a decision the user never made
