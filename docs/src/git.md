# Git

**Managed by:** `nix/home/programs/git.nix`

## Identity

| Setting | Value |
|---------|-------|
| user.name | RanolP |
| user.email | me@ranolp.dev |

## Workflow

| Setting | Value |
|---------|-------|
| init.defaultBranch | main |
| push.autoSetupRemote | true |
| pull.rebase | true |
| merge.conflictstyle | zdiff3 |
| rerere.enabled | true |

## Signing

| Setting | Value |
|---------|-------|
| commit.gpgSign | true |
| user.signingKey | BB9C29B5FA1C8305 |

See [GnuPG](./gnupg.md) for GPG setup.

## Diff and Pager

| Setting | Value |
|---------|-------|
| core.pager | delta |
| interactive.diffFilter | delta --color-only |
| delta.navigate | true |
| delta.side-by-side | false |
| diff.colorMoved | default |
| diff.algorithm | histogram |
