---
name: reframe
description: Teach the expert terms for what the user is building, borrow terms from neighboring fields that solved the same problem under other names (each with a link opened and verified), then rewrite the user's description in those terms. Use for /reframe.
disable-model-invocation: true
---

# Reframe

Teach the user the expert words for what they are building, so they and their agents can search prior art instead of inventing structure. Start from their own files, code and description, read in full rather than summarized.

When their description could name more than one problem, first list the two or three problems it could be, each with the one term that names it and the sign that would tell it apart from the others. Then teach the words for the most likely one and say why you picked it.

1. Give 8 to 12 terms, ranked by how much each would change what gets built. For each: the word; its meaning in one plain sentence; the part of their description it names; one real project, paper or system that uses it that way, with a link; and what it lets them ask an agent for.
2. Pick 2 or 3 neighboring fields that solved the same shape of problem under other names. For each, say what carries over, where the analogy breaks, and which terms come back from it.
3. Name what they did not mention but should care about.
4. Rewrite their description with the new words.

Find sources with `mcp__parallel__web_search`, then open every cited link with `mcp__parallel__web_fetch` and confirm the page uses the term in that sense. Cite only links you confirmed this way, and drop a term whose only source failed the check. Keep every line load-bearing.

---

*Adapted from pstack 0.15.48 (MIT, Lauren Tan): `skills/reframe`.*
