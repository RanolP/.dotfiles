# Agent Incidents

Long-form background for the rules in `AGENTS.md` at the repository root. Each entry records a failure that produced a rule, or the detail behind a rule too long to keep in a file that loads into every agent session. Read one after a rule surprises you, or before changing the rule itself.

## 2026-08-31 -- an agent installed packages imperatively instead of editing declarations

Every tool, app and version on this host is declared in exactly one file, so an install performed on the machine is drift that the next rebuild silently reverts or preserves at random.

Asked to find upgradeable software, an agent ran `npm i -g corepack npm pi-subagents` and `brew upgrade`. That left `pi-subagents` at a version no file declared, and it moved `npm` to 12.0.2 under a mise-managed `node = "24.18.0"` that reverts it on the next `mise install`. Meanwhile the flake inputs the agent never looked at were six weeks stale -- and those were the actual upgrade.

The answer to "upgrade X" is to edit the declaration and hand the rebuild over. The three declaration surfaces are also the three places an "what is upgradeable?" report comes from: `mise outdated` for the `[tools]` table of `nix/home/mise-global.toml`, `brew outdated --greedy` for `homebrew.casks` / `homebrew.brews` in `nix/darwin/default.nix`, and the `lastModified` of each `nix flake metadata` input for everything nixpkgs ships. A cask carries no version in the declaration -- nix-homebrew always installs the latest, so a cask upgrade is a `brew upgrade` the rebuild performs, not a version edit.

`declarative-package-guard.py` now denies the imperative form -- `npm i -g`, `pipx install`, `cargo install`, `brew install|upgrade`, `mise use -g`, `nix profile install` -- and names the file to edit instead.

## 2026-08-31 -- a clean dry-run was handed over and the real rebuild died on simple-translate

`nix build ... --dry-run` never downloads anything. It prints the plan and stops. That makes it the right tool for auditing the "will be built" list for a source compile, and completely blind to a fixed-output hash mismatch, an eval error, or a failing builder.

A dry-run was reported clean and the rebuild was handed to the user. It died on `simple-translate`, because `nix/home/darwin/programs/firefox.nix` pinned a fixed hash to the moving `addons.mozilla.org/firefox/downloads/latest/<slug>/latest.xpi` alias, and AMO had published 3.1.0 over the pinned 3.0.1.

Two consequences. First, a hand-pinned AMO addon must name an immutable `/downloads/file/<id>/<name>-<ver>.xpi` URL rather than the `latest.xpi` alias. Second, the check that catches this class of failure is the real build: `cd ~/.dotfiles/nix && nix build .#darwinConfigurations.ranolp-work-MBP-26.system --no-link`. It needs no sudo and produces the exact derivation `darwin-rebuild switch` will activate, so a green run is evidence the handed-over rebuild will work.

## espanso -- why it is fetched as a notarized release rather than built or installed as a cask

espanso is the worked example behind the GOLDEN RULE that no package may be built from source.

In nixpkgs it is source-only on darwin, so taking the nixpkgs package means compiling it. Its Homebrew cask is not an escape either: the cask's nested-dmg unpack is broken under nix-homebrew.

So `nix/home/darwin/default.nix` fetches the official upstream release, then mounts it and `ditto`s the notarized app into `~/Applications` at activation. That is a download, never a compile. The `ditto` step matters for a second reason: unlike a `7zz` unpack, it preserves the code signature. A re-packed bundle triggers a "Espanso is damaged" error at launch, and `codesign` cannot re-seal the bundle inside the nix sandbox.

## 2026-08-27 -- file-edit-guard.py was registered without being deployed and stopped every Bash call

A `PreToolUse` hook on the `Bash` matcher runs in front of every Bash call in every session on this machine, so a bad one is a total work stoppage that only a rebuild can lift.

`file-edit-guard.py` was registered in `nix/home/configs/claude/settings.json` while both its `home.file` entry in `nix/home/default.nix` and its `git add` were missing. Python exited `2` on the absent file, `PreToolUse` read exit `2` as a block, and every Bash call in every session died with `can't open file '/Users/ranolp/.claude/hooks/file-edit-guard.py'`. It stayed broken until the entry was added and the user rebuilt.

Two structural facts caused it. Nix deploys the hooks directory as one explicit entry per script, never by directory recursion, so a new script that is not listed is not deployed. And a flake reads the git tree, so a file that was never `git add`ed is invisible to the rebuild even when it exists on disk.

## The exit-code contract, and what `verify-claude-hook.sh` actually tests

Measured on python 3.14.6 (2026-08-28), a hook's exit status decides what Claude Code does with the call it guards:

- exit `1` -- an uncaught exception. Claude Code treats this as a non-blocking error, so the call proceeds **unguarded**.
- exit `2` -- what a missing script file produces. `PreToolUse` reads exit `2` as a **block**.

That second case is the work stoppage described in the 2026-08-27 incident above.

`./scripts/verify-claude-hook.sh nix/home/configs/claude/hooks/<name>.py` runs the hook against a clean `python:<host-version>-slim` container -- `--network none`, `--read-only`, the repo mounted read-only, no `~/.claude`, no site-packages -- over a battery of real stdin shapes: empty stdin, non-JSON, a JSON array, a `null` / numeric / list `command`, an unterminated heredoc, and a 1MB command.

It grades each result:

- `STOP` -- the hook blocks or hangs every matched call. This is the total work stoppage.
- `OPEN` -- the guard crashed, so the call proceeds unguarded.
- `SLOW` -- the hook is slow enough to notice.

A hook that scores any `STOP` never gets registered.
