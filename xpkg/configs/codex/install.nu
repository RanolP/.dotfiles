#!/usr/bin/env nu

let home = $nu.home-dir
let nix = $'($home)/.dotfiles/nix/home/configs'

do -i { mkdir $'($home)/.codex/hooks' }

# Copies, not symlinks (see claude/install.nu). A leftover symlink from the old
# setup is removed first so the save cannot write through it into the repo.
do -i { mkdir $'($home)/.codex/agents' }

# Mirrors codexAgentRules in nix/home/default.nix.
echo $"     (ansi blue)Merge(ansi reset) AGENTS.md from shared rules + codex-specific rules + output-manner"
let merged = (open --raw $'($nix)/.agents/AGENTS.md') + "
" + (open --raw $'($nix)/codex/AGENTS.md') + "
" + (open --raw $'($nix)/.agents/output-manner.md')
do -i { rm -f $'($home)/.codex/AGENTS.md' }
$merged | save -f $'($home)/.codex/AGENTS.md'

# Every script config.toml calls: the codex adapter plus the shared Claude guards.
echo $"     (ansi blue)Copy(ansi reset) hooks"
let hooks = (open $'($nix)/codex/config.toml' --raw | parse --regex 'hooks/([\w.-]+\.py)' | get capture0 | uniq)
for name in $hooks {
    let src = if $name == 'claude-hook-adapter.py' { $'($nix)/codex/hooks/($name)' } else { $'($nix)/claude/hooks/($name)' }
    do -i { rm -f $'($home)/.codex/hooks/($name)' }
    cp --force $src $'($home)/.codex/hooks/($name)'
}

echo $"     (ansi blue)Copy(ansi reset) agents"
for agent in (ls ($'($nix)/codex/agents/*.toml' | into glob)) {
    let name = ($agent.name | path basename)
    do -i { cp --force $agent.name $'($home)/.codex/agents/($name)' }
}

# Codex rewrites config.toml at runtime (project trust, TUI state), and trust
# entries are machine-specific absolute paths, so they can't live in the repo.
# Generate config.toml = repo settings + only the [projects.*]/[mcp_servers.*]
# blocks from the uncommitted ~/.codex/config.local.toml, re-asserted here.
echo $"     (ansi blue)Generate(ansi reset) config.toml"
let localTrust = $'($home)/.codex/config.local.toml'
let home_fwd = ($home | str replace --all '\' '/')
mut out = (open $'($nix)/codex/config.toml' --raw
    | str replace --all '@codexConfig@' $'($home_fwd)/.codex/config.toml'
    | str replace --all '@dotfilesConfig@' $'($home_fwd)/.dotfiles/.codex/config.toml'
    | str replace --all 'python3 ' 'python ')
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
