---
name: prompt-authoring
description: Write text that a model reads as behavior -- a skill, a subagent brief, a prompt, a rules file -- in positive form, so the instruction names the action to take rather than the anti-pattern to avoid. Covers which prohibitions earn their place and which plant the thing they forbid. Use when authoring or editing any SKILL.md, agent definition, AGENTS.md, CLAUDE.md, or prompt. The `prompt-authoring-guard` PreToolUse hook injects this skill at the first such edit of a session.
---

# Prompt authoring

Naming an anti-pattern plants it. Attention latches onto X, and later steps drift toward the forbidden thing -- "no separate `app-manifest.json`" leaves the next reader thinking about `app-manifest.json`. This is the "don't think of an elephant" failure in its authoring form, and it is why a rules file full of `NEVER` lines reads as a list of suggestions.

The reading form of this rule stays in `AGENTS.md` under `## Lead with the action`: a prohibition that arrives in an instruction gets silently restated as the positive action that excludes it. This skill is the authoring form.

## Write the `DO` sentence first, then read it alone

Put the positive instruction on the page before anything else, and read it by itself:

> the manifest is `public/vibe-manifest.json`, served and imported by code

That sentence tells the reader where the file is, what serves it, and what imports it. A reader who follows it cannot create the separate manifest, because the sentence already says where the manifest lives.

Reach for a "do not" sentence only after the positive form is on the page and **visibly loses something**. Most of the time it loses nothing, and the prohibition was a restatement wearing a warning label.

## Keep a prohibition that carries its incident

A failure report is the one thing a positive line cannot hold:

> `NEVER: run git push --force, -f, --force-with-lease, or --force-if-includes -- the same guard denies these; the failure this replaces was force-push commands handed over for 4 branches already identical to origin`

`DO: fetch and rebase` does not teach that. The incident -- four branches, already identical, a force-push offered anyway -- is a fact about a real failure, and it is what makes the reader recognize the situation next time.

So the test is not "is this a NEVER?" but "does this carry a fact the DO line cannot?"

## Cut a prohibition that restates its own `DO` backwards

When the `NEVER` line is the `DO` line with the polarity flipped, it adds no fact and plants the elephant. Delete it.

Two lines that fail this test:

- `DO: use the repo's package manager` / `NEVER: use a different package manager` -- the second is the first, inverted.
- `DO: open every PR as a draft` / `NEVER: open a non-draft PR` -- same.

One that passes:

- `NEVER: pass --no-verify ... the git-integrity-guard.py PreToolUse hook denies it, with no bypass` -- it names the enforcement mechanism, which the `DO` line does not.

## Keep the migration note where a human reads it

"Was X, now Y" belongs in human-facing docs and changelogs, where a reader needs the history to understand what changed. It does not belong in a rules file, where the old value is just another elephant. A rules file states the current truth; the changelog carries how it got there.

## Generalize past the incident

One failure is the evidence, not the rule. Name the class of situation the incident belongs to and write the instruction for that class, then keep the incident inside the line as the fact that makes the class recognizable.

- Incident: "I kept a feature flag alive on a branch nobody had pulled."
- Rule: "unshipped code has no reader to protect, so delete it rather than preserving it."

A line that fires only on the exact file, branch, or ticket that produced it reads as a story, and the next session meets a different file and reads past it.

## A `WHY` states the mechanism, not the conclusion

The `WHY` exists so the reader can apply the rule to a case the author never saw, which takes the causal chain rather than its verdict.

- Conclusion: "caution is not free."
- Mechanism: "preserving a thing buys down exactly one risk and pays in complexity that every later reader carries."

The second tells the reader what to weigh next time. Write the second.

## Write agent-facing prose in English

Every file a model reads as behavior is written in English, because Hangul fragments into many BPE tokens and that cost is paid in every session that loads the file.

Korean stays for five cases:

1. A runtime string a person reads (a message the tool prints, a document the user opens).
2. An identifier that is already Korean.
3. A trigger phrase the user types, such as `시말서`.
4. A Korean-language specimen the rule is teaching about.
5. A Korean writing-style term, glossed in English at first use -- `번역체 (translationese)`.

This also replaces quoting the user's own Korean words as a `WHY`. Extract what the quote means and write that mechanism in English; the rule keeps the force and drops the token cost.

## Applying this to a whole file

When editing an existing rules file or skill, work bullet by bullet:

1. Read each `NEVER` / `- DO NOT` line and ask what fact it carries beyond its own `DO` line.
2. Delete it when the answer is "none".
3. Rewrite it as a `DO` when the answer is a real constraint stated backwards.
4. Keep it verbatim when the answer is an incident, a measurement, or an enforcement mechanism.
