---
name: how
description: Explain how a subsystem works -- its entry points, runtime flow, state owners and layering -- as a mental model a senior engineer new to the area can start working from; also answers placement questions ("where should this live", "which module owns this", "is this the right layer"). Use for /how and for a walkthrough before changing unfamiliar code. For why it was built that way, use skill `why`; for the static module map, `zoom-out`.
disable-model-invocation: true
---

# how

When the scope is ambiguous, state your reading of it in one line and go on; the user redirects.

## 1. Explain

Spawn one `general-purpose` agent with `model: "opus"`, read-only by brief, carrying the user's question and this brief:

> Write an architectural explanation for a senior engineer who is new to this area of the codebase, so they come away with a mental model good enough to start working in it confidently. You have read-only access: read and search, edit nothing. Lead with the mental model, then the mechanics: trace one representative action end to end through its entry point, the data flow and the owner of each piece of state, citing `path:line` for each hop. Mechanics come first, history second. For a placement question, judge it by business domain per skill `modularize-by-domain`. End with the files and searches you read, so the reader can tell what was covered.

## 2. Present

Present the agent's explanation with light edits for clarity or for context from this conversation, keeping its structure and its `path:line` anchors.
