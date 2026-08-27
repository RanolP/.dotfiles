---
name: evidence-store
description: Save a hard-won conclusion as an evidence file, and recall one before re-deriving it. Covers the frontmatter fields, the Premises/Proposal/Conclusion body, the staleness judgement, and the verify-before-trust step. Use when a session establishes a non-obvious conclusion worth keeping -- a diagnosis, a verified technical claim, a decision that survived scrutiny -- or when you are about to re-derive a conclusion in territory you have worked before.
---

# Evidence store

A conclusion that cost real work to reach is worth more than the answer it produced. The answer expires; the reasoning that produced it can be re-checked. An evidence file keeps the reasoning, so the next session re-runs one command instead of the whole investigation.

## What earns a file

Save a conclusion that meets all three:

- **Non-obvious** -- it did not follow from reading one file.
- **Premise-backed** -- you can name what it rests on.
- **Expensive to re-derive** -- reproducing it would cost more than a couple of tool calls.

Skip anything the repository already records: code structure, git history, a fix already in the diff, a fact any grep answers.

## Where it goes

One file per conclusion, at `<memory-dir>/evidence/<slug>.md`. The memory directory is the one the session's memory instructions name.

## Frontmatter

```yaml
---
name: <short-kebab-case-slug>
description: <one line, used to decide relevance during recall>
metadata:
  type: evidence
  createdAt: <absolute YYYY-MM-DD, never "today" or "last week">
  verify: <one command that re-checks the conclusion cheaply>
---
```

`verify` is what makes the file trustworthy later. Prefer a command that runs in seconds and answers yes or no: a `grep` for the symbol the conclusion depends on, a `--version` check, a dry-run, a single test. Omit the field only when no cheap check exists, and say so in the body.

## Body

Three headings, in this order, each stated explicitly:

```markdown
**Premises:** what was true when this was established -- versions, file states, observed behavior.

**Proposal:** the question that was being answered, or the change that was being judged.

**Conclusion:** what was established, in one or two sentences, with the reasoning that connects it to the premises.
```

Write each premise as a fact someone else can re-check. "The parser hangs on quoted strings" is a premise; "it seemed slow" is not.

## Recall

Before re-deriving a conclusion in familiar territory:

1. `grep` the evidence directory for the subject.
2. On a hit, read `createdAt` and judge staleness against what has changed since -- a dependency bump, a refactor, a platform upgrade.
3. Run the `verify` command.
4. Trust the conclusion only after the verify passes. A failed verify means the file is stale: re-derive, then rewrite the file rather than adding a second one.

## Constraints

- One conclusion per file. A file holding two conclusions cannot be verified by one command.
- The file stands alone -- a reader with none of your context must follow it, so no transcript references, no "as discussed earlier".
- Update the existing file when a conclusion changes; delete it when it turns out wrong.
