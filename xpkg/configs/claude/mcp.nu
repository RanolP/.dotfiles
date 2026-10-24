#!/usr/bin/env nu

# ~/.claude.json is Claude Code's mutable runtime state (projects, tokens,
# caches), so unlike the other configs it is MERGED, never copied: only the
# declared mcpServers keys are set, and every other key stays as found.
let home = $nu.home-path
let target = $'($home)/.claude.json'
let backup = $'($target).xpkg.backup'
let tmp = $'($target).xpkg.tmp'
let declared = (open --raw $'($home)/.dotfiles/nix/home/configs/claude/mcp.json' | from json | get mcpServers)

if not ($target | path exists) {
    error make --unspanned { msg: $'($target) is missing; start Claude Code once to create it' }
}
let state = try { open --raw $target | from json } catch {|e|
    error make --unspanned { msg: $'($target) is not valid JSON, left untouched: ($e.msg)' }
}

echo $"     (ansi blue)Merge(ansi reset) mcpServers \(($declared | columns | str join ', ')\) into ~/.claude.json"
if not ($backup | path exists) { cp $target $backup }
let current = ($state | get --optional mcpServers | default {})
let merged = ($state | upsert mcpServers ($current | merge $declared))
$merged | to json --indent 2 | save -f $tmp
mv --force $tmp $target
