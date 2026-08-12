---
name: memory-review
description: Survey the Claude memories saved across every project, rank them by how much they belong in the shared rules file, and recommend a shortlist to internalize, keep, or delete. Use when the user asks which memories should become rules, wants the memory store cleaned up, or opens `~/.dotfiles` after a stretch of work in other repos.
---

# Memory review

Memories are written wherever the work happened, so a correction that applies on every host can sit in one project folder forever. This skill reads the whole store, sorts it by where each memory belongs, and hands the user a ranked shortlist. It recommends; the user picks; `memory-internalize` does the moving.

Nothing is deleted here. This skill only reads.

## 1. Sweep cheaply

Memory files live at `~/.claude/projects/<project-slug>/memory/*.md`, indexed by `MEMORY.md` in the same folder, with lazily-searched files under `evidence/`.

Bodies are large, so read the frontmatter first and nothing else:

```sh
grep -H "^description:\|^  type:" ~/.claude/projects/*/memory/*.md
```

Read a full body only for the candidates that survive step 2.

## 2. Sort each memory into one bucket

| Bucket | What it looks like | Recommendation |
|---|---|---|
| **Global habit** | describes how the agent should work, and nothing in it is repo-specific | internalize into `nix/home/configs/.agents/AGENTS.md` |
| **Global fact** | a tool, path, or platform behavior true on this machine regardless of repo | internalize, or keep if it is already in a rules file |
| **Project fact** | names a repo, a service, a ticket, a schema | keep where it is |
| **Duplicate** | an existing rule already says it | delete after confirming the rule covers it |
| **Stale** | its premise no longer holds — a shell that changed, a version that moved, a file that is gone | delete, or rewrite from the current facts |
| **Conflicting** | it contradicts a live rule or another memory | raise it first; the user decides which side is right |

Two checks make this real rather than a guess:

```sh
grep -n "^## " ~/.claude/CLAUDE.md                    # every rule that already exists
grep -rn "\[\[<memory-name>\]\]" ~/.claude/projects/*/memory/   # who links to it
```

A memory in the **Stale** or **Conflicting** bucket needs its premise tested before you report it — check the version, the path, or the setting yourself rather than trusting what the file says.

## 3. Rank by what it costs to leave it alone

Order the shortlist by damage, highest first:

1. **Conflicting** — a memory that fights a rule makes behavior random, so it lands at the top no matter how small it is.
2. **Global habit** repeated across projects — the same correction saved twice means it keeps happening.
3. **Global habit** seen once.
4. **Stale** — wrong facts are worse than missing ones.
5. **Duplicate** — harmless, just noise in every session's startup context.

## 4. Report as a table the user can act on

One row per memory, ranked, with the exact file path, the bucket, and one sentence of evidence. Name the rule it conflicts with or duplicates by its heading text, so the user can judge without opening anything.

Close with the single highest-value next step: which memory to internalize first, and why that one.

---

*Paired with `memory-internalize`, which performs the move this skill recommends.*
