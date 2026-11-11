#!/usr/bin/env nu

# Shared config content is the single source of truth in the nix tree; Windows
# COPIES it into ~/.claude. Symlinks need elevation / Developer Mode on Windows
# and fail silently (do -i), which leaves stale files behind -- that is how the
# old blanket-deny claude-dir-edit-guard kept coming back and killing the memory
# and plan tools. Copying is reliable; re-run this after editing the nix sources.
# Only the OS-specific bits (statusline.js, the rewritten settings.json
# tokens) are xpkg-local.
let home = $nu.home-dir
let nix = $'($home)/.dotfiles/nix/home/configs'
let local = $env.FILE_PWD

do -i { mkdir $'($home)/.claude/hooks' }
do -i { mkdir $'($home)/.claude/agents' }
do -i { mkdir $'($home)/.claude/rules' }
do -i { mkdir $'($home)/.claude/skills' }
do -i { mkdir $'($home)/.claude/mods' }

echo $"     (ansi blue)Merge(ansi reset) CLAUDE.md from shared AGENTS.md + claude-specific rules"
let merged = (open --raw $'($nix)/.agents/AGENTS.md') + "\n" + (open --raw $'($nix)/claude/CLAUDE.md')
$merged | save -f $'($home)/.claude/CLAUDE.md'

# Claude Code rewrites settings.json at runtime, so a symlink would get
# clobbered into a regular file on the next write -- keep a plain copy. The nix
# source targets Unix (python3, a bare statusline.sh); rewrite those two tokens
# for Windows (python, node statusline.js) as it is copied.
#
# CLAUDE_CODE_PLUGIN_DIRS is split on the platform PATH delimiter (`;` here,
# `:` in the nix source) and each entry must be absolute or start with ~, so
# the list is rebuilt with `;` and absolute forward-slash paths. Mods in
# $skipped_mods stay out of it: codex-subagent and tool-compose run their
# daemons on a Unix-domain socket file, and tool-compose's exec refuses any OS
# but darwin, so neither works on native Windows.
let skipped_mods = [codex-subagent tool-compose]
let home_fwd = ($home | str replace --all '\' '/')
let plugin_dirs_src = (open $'($nix)/claude/settings.json' | get env.CLAUDE_CODE_PLUGIN_DIRS)
let mods = ($plugin_dirs_src | split row ':' | each {|d| $d | path basename } | where {|m| $m not-in $skipped_mods })
let plugin_dirs_win = ($mods | each {|m| $'($home_fwd)/.claude/mods/($m)' } | str join ';')

echo $"     (ansi blue)Generate(ansi reset) settings.json \(Windows-adapted from nix source\)"
(open $'($nix)/claude/settings.json' --raw
    | str replace --all 'python3 ' 'python '
    | str replace --all '~/.claude/statusline.sh' 'node ~/.claude/statusline.js'
    | str replace $'"($plugin_dirs_src)"' $'"($plugin_dirs_win)"'
) | save -f $'($home)/.claude/settings.json'

# Mirrors claudeOutputStyle in nix/home/default.nix: same frontmatter, then the
# shared output-manner body. settings.json's "outputStyle" names this file, and
# a missing file silently falls back to the default style.
echo $"     (ansi blue)Generate(ansi reset) output style concise-adhd-korean"
do -i { mkdir $'($home)/.claude/output-styles' }
let style_header = "---
name: concise-adhd-korean
description: ADHD 독자에 맞춘 한국어 문체와 간결한 보고 규칙을 합친 출력 스타일이다. 코딩 지침을 유지한다.
keep-coding-instructions: true
---

"
($style_header + (open $'($nix)/.agents/output-manner.md' --raw)) | save -f $'($home)/.claude/output-styles/concise-adhd-korean.md'

echo $"     (ansi blue)Copy(ansi reset) statusline.js"
do -i { cp --force $'($local)/statusline.js' $'($home)/.claude/statusline.js' }

# Each mod is copied whole: Claude Code rejects a hook module whose realpath
# escapes the plugin directory, and the mods import their sibling files.
echo $"     (ansi blue)Copy(ansi reset) mods \(($mods | str join ', ')\)"
for m in $mods {
    let dest = $'($home)/.claude/mods/($m)'
    do -i { rm -rf $dest }
    cp --recursive $'($nix)/claude/mods/($m)' $dest
}

nu $'($local)/mcp.nu'

# nix/home/default.nix puts these two under ~/.claude/shared: code-reviewer
# reads style-rules.md, and codex-subagent copies agent-rules.md (the shared
# AGENTS.md alone, without the Claude-only appendix) into implementer prompts.
echo $"     (ansi blue)Copy(ansi reset) shared style-rules.md and agent-rules.md"
do -i { mkdir $'($home)/.claude/shared' }
cp --force $'($nix)/claude/shared/style-rules.md' $'($home)/.claude/shared/style-rules.md'
cp --force $'($nix)/.agents/AGENTS.md' $'($home)/.claude/shared/agent-rules.md'

echo $"     (ansi blue)Copy(ansi reset) hooks"
for hook in (ls ($'($nix)/claude/hooks/*.py' | into glob)) {
    let name = ($hook.name | path basename)
    do -i { cp --force $hook.name $'($home)/.claude/hooks/($name)' }
}

echo $"     (ansi blue)Copy(ansi reset) agents"
for agent in (ls ($'($nix)/claude/agents/*.md' | into glob)) {
    let name = ($agent.name | path basename)
    do -i { cp --force $agent.name $'($home)/.claude/agents/($name)' }
}

# Local skills: each is a directory under the shared .agents/skills tree.
# The vendored ones (skill-creator, notion-cli, ...) are fetched below.
echo $"     (ansi blue)Copy(ansi reset) skills"
for skill in (ls ($'($nix)/.agents/skills/*' | into glob) | where type == dir) {
    let name = ($skill.name | path basename)
    let dest = $'($home)/.claude/skills/($name)'
    do -i { rm -rf $dest }
    do -i { cp --recursive $skill.name $dest }
}
# nix/home/default.nix links apology a second time under the name the user
# types. Its `dotfiles:evolve` link keeps the source name here, since `:` is
# not a valid character in a Windows file name.
do -i { rm -rf $'($home)/.claude/skills/시말서' }
do -i { cp --recursive $'($nix)/.agents/skills/apology' $'($home)/.claude/skills/시말서' }

# Vendored skills: nix/home/default.nix fetches each with pkgs.fetchFromGitHub
# at a pinned rev (there is no flake input behind them). The pin is read from
# that file so a rev bump there re-downloads here. The cache is keyed by rev, so
# an unchanged rev skips the download.
let cache_root = $'($local)/.skills-cache'
let nix_src = (open --raw $'($nix)/../default.nix')
let pins = ($nix_src | parse --regex 'fetchFromGitHub\s*\{\s*owner\s*=\s*"(?<owner>[^"]+)";\s*repo\s*=\s*"(?<repo>[^"]+)";\s*rev\s*=\s*"(?<rev>[^"]+)"')
def fetch-repo [owner: string, repo: string] {
    let pin = ($pins | where owner == $owner and repo == $repo | first)
    let dir = $'($cache_root)/($owner)-($repo)-($pin.rev)'
    let tree = $'($dir)/tree'
    if ($'($dir)/ok' | path exists) {
        print $"       (ansi black)Cache hit(ansi reset) ($owner)/($repo)@($pin.rev | str substring 0..7)"
    } else {
        print $"       Download ($owner)/($repo)@($pin.rev | str substring 0..7)"
        rm -rf $dir
        mkdir $dir
        ^curl -fsSLo $'($dir)/src.zip' $'https://codeload.github.com/($owner)/($repo)/zip/($pin.rev)'
        ^7z x $'($dir)/src.zip' $'-o($tree)' -y | ignore
        '' | save -f $'($dir)/ok'
    }
    # The archive holds one top directory, <repo>-<rev>.
    ls $tree | where type == dir | first | get name | str replace --all '\' '/'
}
def put-skill [name: string, src: string] {
    let dest = $'($home)/.claude/skills/($name)'
    do -i { rm -rf $dest }
    cp --recursive $src $dest
    $dest
}
def must-contain [file: string, needle: string] {
    if not ((open --raw $file) | str contains $needle) { error make { msg: $'($file): patch left no "($needle)"' } }
}
print $"     (ansi blue)Fetch(ansi reset) vendored skills"
let anthropics = (fetch-repo anthropics skills)
put-skill skill-creator $'($anthropics)/skills/skill-creator'
let notion = (fetch-repo makenotion skills)
put-skill notion-cli $'($notion)/skills/notion-cli'
let typesafe = (fetch-repo typesafe-ai skills)
put-skill typesafe-ai $'($typesafe)/skills/typesafe-ai'

# nix: sed 's|${CLAUDE_PLUGIN_ROOT}|<store>/plugin|g' on the plugin's search
# SKILL.md. The store path becomes the cached checkout's plugin directory.
let supermemory = (fetch-repo supermemoryai claude-supermemory)
let sm_dest = (put-skill supermemory-search $'($supermemory)/plugin/skills/supermemory-search')
let sm_file = $'($sm_dest)/SKILL.md'
(open --raw $sm_file | str replace --all '${CLAUDE_PLUGIN_ROOT}' $'($supermemory)/plugin') | save -f $sm_file
must-contain $sm_file $'($supermemory)/plugin'

# nix: sed on SKILL.md so the CLI runs as the mise-pinned binary, not npx.
let mwg = (fetch-repo GoogleChrome modern-web-guidance)
let mwg_dest = (put-skill modern-web-guidance $'($mwg)/skills/modern-web-guidance')
let mwg_file = $'($mwg_dest)/SKILL.md'
let replacement = ["## Using the CLI" "" '- `modern-web-guidance` is a pinned binary on PATH (mise); run it directly by that name.']
let patched = (open --raw $mwg_file | str replace --all 'npx -y modern-web-guidance@latest ' 'modern-web-guidance ' | str replace --all ' directly with `npx` using' ' using' | lines)
# sed `/^## Using npx/,/^- If the command hangs/c` swaps that whole range for the text.
let start = ($patched | enumerate | where {|r| $r.item =~ '^## Using npx' } | get index | first)
let end = ($patched | enumerate | where {|r| $r.index >= $start and $r.item =~ '^- If the command hangs' } | get index | first)
(($patched | take $start | append $replacement | append ($patched | skip ($end + 1)) | str join "\n") + "\n") | save -f $mwg_file
if (open --raw $mwg_file) =~ 'npx|pnpx|@latest' { error make { msg: 'modern-web-guidance: unpatched launcher left in SKILL.md' } }
must-contain $mwg_file "\nmodern-web-guidance search "
must-contain $mwg_file "\nmodern-web-guidance retrieve "

# Home-manager drops a link once its source leaves the repo; a copy stays
# behind. Remove each copy whose source git history shows as deleted and the
# repo no longer has (the handoff skill, time-budget.py, ...), and leave every
# other file in these directories alone.
def retired [repo_dir: string] {
    git -C ($nu.home-dir | path join '.dotfiles') log --format= --name-only --diff-filter=D -- $repo_dir
    | lines
    | where {|l| $l starts-with $'($repo_dir)/' }
    | each {|l| $l | str substring (($repo_dir | str length) + 1).. | split row '/' | first }
    | uniq
    | where {|n| not ($nu.home-dir | path join '.dotfiles' $repo_dir $n | path exists) }
}
echo $"     (ansi blue)Remove(ansi reset) retired hooks, agents and skills"
for r in [
    [repo_dir dest];
    ['nix/home/configs/claude/hooks' 'hooks']
    ['nix/home/configs/claude/agents' 'agents']
    ['nix/home/configs/.agents/skills' 'skills']
] {
    for n in (retired $r.repo_dir) {
        let target = $'($home)/.claude/($r.dest)/($n)'
        if ($target | path exists) {
            echo $"       ($r.dest)/($n)"
            rm -rf $target
        }
    }
}
