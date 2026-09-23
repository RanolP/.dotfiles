---
name: update
description: Bump named CLI tools to their latest release by editing the pin in nix/home/mise-global.toml, then prove the flake still builds and hand the rebuild over. Use when the user says update, upgrade or bump one or more tools by name, asks what is upgradeable, or invokes /update with a tool list.
---

# update

A tool is upgraded here by editing the line that declares its version, never by running an installer on the machine. `declarative-package-guard.py` denies the imperative form and names the file to edit instead.

`mise outdated` reports "All tools are up to date" in this repository, because every entry in `nix/home/mise-global.toml` is pinned to one exact version and that pin is simultaneously the configured range. **`mise outdated --bump` is the command that sees past the pin**, and its fourth column is the version to write.

## The sequence

1. **Resolve each name to its line** in `/Users/ranolp/.dotfiles/nix/home/mise-global.toml`. A key is either bare (`codex`, `gh`, `claude`) or backend-qualified and quoted (`"npm:agent-browser"`, `"pipx:reuse"`, `"ubi:namespacelabs/foundation"`). `mise registry | grep -E "^<name>\s"` names the backend when the key is not obvious.
2. **Query the registry with the age filter off**, always: `MISE_MINIMUM_RELEASE_AGE=0 mise outdated --bump` covers the whole set in one call, and `MISE_MINIMUM_RELEASE_AGE=0 mise latest <key>` answers for one tool. Without that prefix mise withholds every release younger than `minimum_release_age`, 24 hours by default, and reports the older version with no explanation, so the bare command answers a question nobody asked. `mise ls-remote <key>` prints how many are withheld (`mise WARN  1 newer claude release hidden by minimum_release_age`).
3. **Offer the choice whenever the newest release is still inside that window**: name the withheld version, its release timestamp and the hours left, beside the newest release that has already aged out, and let the user pick one. Bump straight to the aged-out version when no release is withheld. Either branch writes one exact version into the pin, which then installs with no flag, because the age filter applies to fuzzy version requests and an exact pin leaves mise nothing to resolve.
4. **Edit the version string alone**, with the Edit tool, one line per tool. Every other line of the file keeps its current content, including changes an earlier session left uncommitted there.
5. **Read the release notes** between the pinned version and the new one when the tool is one this repository configures, and name in the report anything that changes a declaration here. For `claude` that is `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`; a new default that this repository wants off becomes a `settings.json` line in the same pass.
6. **Build for real**: `cd ~/.dotfiles/nix && nix build .#darwinConfigurations.ranolp-work-MBP-26.system --no-link`, and read its exit code. `--dry-run` is blind to a hash mismatch and a failing builder, so the real build is what proves the generation green.
7. **Report and hand the rebuild over**, once, at the end: the old and new version per tool, anything step 4 turned up, and the apply command for this host.
8. **Verify from the binary** after the user rebuilds: the tool's own `--version` is the evidence, and `mise ls <name>` shows the declared version beside the installed one. A rebuild alone leaves a tool uninstalled when mise has not fetched it yet, so `mise install` is the follow-up when the versions disagree.

## A name that lives on another surface

Three declaration surfaces carry packages here, and only the first holds a version to bump.

| Surface | File | How it upgrades |
|---|---|---|
| mise tools | `nix/home/mise-global.toml` | edit the pinned version, as above |
| Homebrew casks and formulae | `nix/darwin/default.nix` | the entry is a name with no version; the rebuild runs the `brew upgrade` |
| everything nixpkgs ships | `nix/flake.lock` | `nix flake update`, optionally `--update-input <name>` |

Name the surface a tool sits on when it is not a mise pin, and say which file's line would change, rather than editing a version that surface does not carry.

## Report what "upgradeable" means per surface

An answer to "what is upgradeable?" reads all three: `mise outdated --bump`, `brew outdated --greedy`, and the `lastModified` of each input in `nix flake metadata`.
