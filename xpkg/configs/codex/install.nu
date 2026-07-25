#!/usr/bin/env nu

let home = $nu.home-path
let nix = $'($home)/.dotfiles/nix/home/configs'

do -i { mkdir $'($home)/.codex/hooks' }

echo $"     (ansi blue)Symlink(ansi reset) AGENTS.md \(shared with Claude\)"
do -i { ln -s -f $'($nix)/.agents/AGENTS.md' $'($home)/.codex/AGENTS.md' }

echo $"     (ansi blue)Symlink(ansi reset) hooks/git-push-guard.py \(shared with Claude\)"
do -i { ln -s -f $'($nix)/claude/hooks/git-push-guard.py' $'($home)/.codex/hooks/git-push-guard.py' }

# Codex rewrites config.toml at runtime (project trust, TUI state), and trust
# entries are machine-specific absolute paths, so they can't live in the repo.
# Generate config.toml = repo settings + only the [projects.*]/[mcp_servers.*]
# blocks from the uncommitted ~/.codex/config.local.toml, re-asserted here.
echo $"     (ansi blue)Generate(ansi reset) config.toml"
let localTrust = $'($home)/.codex/config.local.toml'
mut out = (open $'($nix)/codex/config.toml' --raw)
if ($localTrust | path exists) {
    mut keep = false
    mut kept = []
    for line in (open $localTrust --raw | lines) {
        if ($line | str starts-with '[') {
            $keep = (($line | str starts-with '[projects.') or ($line | str starts-with '[mcp_servers.'))
        }
        if $keep {
            $kept = ($kept | append $line)
        }
    }
    if ($kept | length) > 0 {
        $out = $out + "\n\n" + ($kept | str join "\n")
    }
}
$out | save -f $'($home)/.codex/config.toml'
