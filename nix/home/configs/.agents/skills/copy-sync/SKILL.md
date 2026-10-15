---
name: copy-sync
description: Keep hand-synced copies of one file identical across repos by mirroring every edit and running `copy-sync-check`.
when_to_use: Editing a file that is a deliberate copy of a file in another repo, setting up such a sync, or being asked whether the copies are in sync. Also when the user says "sync manually" or "no shared package".
---

# copy-sync

Several implementations share code by deliberate copy-paste. The decision not to extract a shared package was made on purpose, so the copies are the design: they stay identical up to formatting, and the work is keeping them so.

## The rule

An edit to one copy is mirrored into every other copy in the same unit of work, then `copy-sync-check` runs and exits 0. A sync that is left for later drifts, because nobody remembers which copy held the newer logic.

When the copies diverge or a change is awkward to mirror, report the divergence and the cost of the mirror, and keep the copies as the shape of the solution.

## The check

```
copy-sync-check <manifest> [name=path ...]
```

- `<manifest>` is a `.toml` path, or a bare name resolved to `${XDG_CONFIG_HOME:-~/.config}/copy-sync/<name>.toml`.
- `name=path` replaces that root's default path. Use it to point a root at a git worktree.
- Exit 0: every file matches. Exit 1: some differ, each differing file is named with a unified diff, and every file is checked rather than stopping at the first mismatch. Exit 2: the manifest or the usage is wrong.

## The manifest

```toml
# first root is the reference; every other root is diffed against it
[roots]
web = "/path/to/acme-web"
app = "/path/to/acme-app"

# argv run once per copy; stdout is the normalized text.
# {file} = the copy being normalized, {root:<name>} = that root's path
normalize = ["node", "{root:web}/node_modules/prettier/bin/prettier.cjs", "--config", "{root:web}/.prettierrc", "{file}"]
# drop blank lines before comparing (absorbs import-grouping differences)
ignore_blank_lines = true

files = ["src/shared/foo.ts", "src/shared/foo-error.ts"]
```

- Pick ONE repo's formatter config as the normalizer, so per-repo style (semicolons, quotes) is formatted away and only real differences remain.
- The `files` list lives in the manifest only, one place. A file added to the sync is added there.
- Manifests name private repos and local paths, so they live under `~/.config/copy-sync/`, outside every public repo.

## Setting up a new sync

1. Write the manifest from the example above.
2. Run `copy-sync-check <manifest>` once and confirm exit 0. A red first run means the copies already differ or the normalizer is wrong; read the diff before editing anything.
3. Tell the user the exact command to re-run it.
