---
name: ship
description: Run the whole publish sequence for finished work in one pass -- stage explicit paths, prove the diff carries no secret and no private identifier, commit, then push on one confirmation. Use when work is ready to commit, when the user says commit, push, ship, or asks whether pushing is safe, and before any git commit or git push in a public repository.
---

# ship

One pass takes finished work from the working tree to the remote. The user confirms the push once, at the end, and reads a single report instead of a step-by-step conversation.

## Stage and commit in separate Bash calls

`leak-guard.py` is a PreToolUse hook that inspects the index BEFORE the command runs. A call that stages and commits together therefore shows it an empty index and ships whatever the staging step was about to add.

```
git add <paths>                # one call, and nothing else in it
git commit -F <message-file>   # the next call
```

NEVER: chain `git add` and `git commit` with `&&`, `;`, or a newline inside a single Bash call. A commit in exactly that form once carried a private organisation identifier past a denylist that already held it, into two commits that had to be rewritten.

## The sequence

1. **Read what is actually there.** `git status --short` and `git diff HEAD`. Name every path that changed and decide which ones this unit owns; a path modified before this session started stays out.
2. **Stage explicit paths**, never `-A` and never `.`, in a Bash call that does nothing else.
3. **Check safety** against the staged diff, before writing the message. The checks are below.
4. **Commit** in its own call, with the message in the repo's dominant form (`git log --oneline -30` decides subject style, prefix and language).
5. **Report and ask once.** Give the user the commit subjects, the file list, the push state, and one `git -C <absolute-path> push <remote> <branch>` command. Stop there.
6. **Push** only after the user answers, then confirm the remote moved.

## The safety check

Run all four against the staged diff and report each one's verdict. Any failure stops the sequence at the working tree.

**Publication reach.** `git remote -v` decides how much the rest costs. A repository whose `origin` is public pays the full cost of every check below; a private or work repository pays a lighter one, because the identifiers in it are already inside their own boundary.

**Identifiers.** Scan the staged diff for anything that names a party outside this repository: an employer or organisation name, an internal repository, a ticket key, a PR or issue number from another repo, a customer name, a person's name or handle, an internal hostname or URL. Replace each with an angle-bracket placeholder -- `<org>`, `<repo>`, `<CARD-KEY>`, `<a teammate>` -- and keep the sentence around it. `leak-guard.py` denies the ones its denylist knows; the ones it cannot know are yours to catch, so read the diff rather than trusting the hook to have read it.

**Measurements.** A number measured in someone else's system travels with them: build times, throughput, revenue, user counts, error rates. Keep the shape and drop the value -- `<전> -> <후> (-N%p)`.

**Scope.** `git diff --cached --stat` lists only the paths this unit owns. A file you did not touch this session that appears there is a staging mistake, not a bonus.

**Secrets.** Tokens, keys, PEM blocks and credentials never enter a commit, in any repository, public or private.

## Reporting the push state

Fetch first, then state the position as a fact rather than an impression:

```
git -C <absolute-path> fetch --prune origin
git -C <absolute-path> rev-list --left-right --count origin/<branch>...<branch>
```

`0 N` means the push is a fast-forward and nothing on the remote is at risk. Any non-zero left count means the remote moved: rebase onto it, and ask the user when the rebase is not obviously safe.

## When a leak is already committed

Commits that never left this machine are below the publication threshold, so rewrite them freely:

1. `git rev-list --count origin/<branch>..<branch>` establishes that nothing was pushed. Say that number out loud in the report.
2. `git reset --soft HEAD~<n>`, scrub the files, re-stage and re-commit -- message text included, because an identifier in a commit message publishes exactly as well as one in a diff.
3. Verify with `git grep -inE "<term>|<term>" -- .` over the tree AND `git log -p -<n> | grep -inE "<term>|<term>" ` over the new commits. Report both exit codes.
4. When the commits WERE already pushed, stop and tell the user immediately: the identifier is public, history rewriting alone does not retract it, and the next step is theirs to choose.
