---
name: why
description: Answer "why is X this way" from the written record -- the commits, PRs, Jira tickets and incident notes that introduced and later changed X -- quoting their authors, labelling every inference, and naming what the record leaves open. Use when the user asks why code, a workaround, a config value, a hook, a rule or a threshold exists or was chosen ("why is this here", "why did we pick", "what was the reason", "왜 이렇게", "왜 넣었", design rationale, which change brought a regression in). For how code behaves at runtime, read the code instead.
---

# Why

Answer from the record. The code shows what X does; the commits, PR discussions, tickets and incident notes show why someone made it so. Read the record that introduced X and every later change to it, quote what the authors wrote, mark your own reading as inference, and say what the record does not answer.

## 1. Pin the target

Restate X as an exact identifier: `path:start-end`, a function name, a config key, a rule's line. A question about "this workaround" becomes a line range before the first command runs.

## 2. Find every commit that shaped it

| Target | Command |
|---|---|
| A line range | `git log -L <start>,<end>:<path> --format='%h %ad %an %s' --date=short` |
| A function | `git log -L :<function>:<path>` |
| A string that appeared or vanished | `git log -S '<string>' --format='%h %ad %an %s' --date=short -- <path>` (`-G '<regex>'` for a pattern) |
| Who last touched each current line | `git blame -w -C -C -L <start>,<end> <path>` |
| A deleted file | `git log --diff-filter=D --format='%h %s' -- <path>` |

Read each commit body in full with `git show <sha>`. When blame lands on a reformat, rename or mass move, step past it with `git blame <sha>^ -L <start>,<end> -- <old-path>` until you reach the commit that introduced the behavior.

## 3. Follow each commit to its PR

- A squash merge carries `(#<n>)` in its subject; otherwise run `gh api repos/{owner}/{repo}/commits/<sha>/pulls --jq '.[].number'`.
- Read the description and author: `gh pr view <n> --json number,title,author,mergedAt,body,url`.
- Read the discussion: `gh pr view <n> --comments`, plus the line-level review threads with `gh api repos/{owner}/{repo}/pulls/<n>/comments --paginate`. The reason for a workaround often sits in a review reply rather than the description.

## 4. Follow the ticket

Collect every key matching `[A-Z]+-[0-9]+` from the branch name, commit subjects, PR title and body. Load skill `jira-master`, then read each card with `jira info -i KEY`, `jira show -i KEY --rendered` and `jira comments -i KEY`. A parent epic or a linked card named there is the next hop.

## 5. In `~/.dotfiles`, read the incident log

For a hook, rule, guard or skill in `~/.dotfiles`, search `docs/src/agent-incidents.md` for its name and for the incident date its rule line cites, and search the session memory's `evidence/` notes (skill `evidence-store`). Commit bodies in this repo usually quote the incident that prompted the change.

## 6. Widen only while the trail is thin

When commits, PRs and tickets leave the decision unexplained, follow links they contain: a Slack thread (Slack MCP), a Notion page (`ntn pages get <id>`), an upstream issue or changelog for a pinned dependency. Stop as soon as a source states the decision.

## Answer

- **Answer** -- one or two sentences.
- **Record** -- each source in date order: the SHA with its subject, the PR as `#<n> (<title>)`, the ticket key with its summary; its author and date; and the author's own words in a quote.
- **Inference** -- every claim no source states, labelled as inference, with the sources it rests on.
- **Not in the record** -- what stays unanswered, and the person most likely to know (the author of the deciding commit or PR, by name).
- **Sources searched** -- each source read, with its range or query (the `git log` range or `-S` string, the PRs, the ticket keys, the Slack or Notion links), including the ones that came back empty, so the reader can tell an absent answer from an unsearched one.

---

*Adapted from pstack 0.15.48 (MIT, Lauren Tan): `skills/why`.*
