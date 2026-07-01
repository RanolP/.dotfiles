# Claude Code

AI coding assistant CLI.

**Managed by:** `nix/home/default.nix` (home.file declarations), installed via mise (`claude` tool)

## Managed Files

| File | Purpose |
|------|---------|
| `~/.claude/CLAUDE.md` | Rules and behavioral config for Claude Code sessions |
| `~/.claude/settings.json` | Claude Code app settings |
| `~/.claude/statusline.sh` | Custom status line script (executable) |
| `~/.claude/hooks/git-push-guard.py` | PreToolUse hook restricting `git push` (executable) |

## Skills

Skills extend Claude Code with domain-specific workflows.

| Skill | Source |
|-------|--------|
| handoff | `nix/home/configs/.agents/skills/handoff/SKILL.md` |
| decompose | `nix/home/configs/.agents/skills/decompose/SKILL.md` |
| one-domain | `nix/home/configs/.agents/skills/one-domain/SKILL.md` |
| codex-edit | `nix/home/configs/.agents/skills/codex-edit/SKILL.md` |
| diagnose | `nix/home/configs/.agents/skills/diagnose/SKILL.md` |
| tdd | `nix/home/configs/.agents/skills/tdd/SKILL.md` |
| grill-me | `nix/home/configs/.agents/skills/grill-me/SKILL.md` |
| prototype | `nix/home/configs/.agents/skills/prototype/SKILL.md` |
| zoom-out | `nix/home/configs/.agents/skills/zoom-out/SKILL.md` |
| remove-dead-code | `nix/home/configs/.agents/skills/remove-dead-code/` (vendored from [qdhenry/Claude-Command-Suite](https://github.com/qdhenry/Claude-Command-Suite), MIT) |
| audit-env-variables | `nix/home/configs/.agents/skills/audit-env-variables/` (vendored from [qdhenry/Claude-Command-Suite](https://github.com/qdhenry/Claude-Command-Suite), MIT) |
| skill-creator | [anthropics/skills](https://github.com/anthropics/skills) (pinned rev) |
| frontend-design | [anthropics/skills](https://github.com/anthropics/skills) (pinned rev) |

The `anthropics/skills` repo is fetched via `pkgs.fetchFromGitHub` at a pinned revision and linked into `~/.claude/skills/`. The two vendored multi-file skills are linked as whole directories rather than a single `SKILL.md`, and their MIT provenance is declared in `REUSE.toml`.

## Hooks

### git-push-guard

A `PreToolUse` hook (registered in `settings.json` under the `Bash` matcher) that restricts `git push` to `claude/*` branches.

A static `deny` rule cannot express "deny all pushes except `claude/*`" because deny always wins over allow regardless of specificity. So the blanket `Bash(git push*)` deny was removed and replaced by this hook, which inspects each `git push` command and:

- **allows** pushes whose refspec destination targets a `claude/*` branch (e.g. `git push -u origin claude/topic`);
- **denies** everything else, failing safe to deny — bare `git push`, a remote with no refspec, non-`claude/*` destinations, and pushes chained with `&&`/`||`/`;`/`|`.
