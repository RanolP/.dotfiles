{ pkgs, lib, ... }:
let
  # Copy local.nix.example → local.nix and fill in secrets (gpg signing key, etc.)
  # local.nix is gitignored.
  hasLocal = builtins.pathExists ./local.nix;
  local = if hasLocal then import ./local.nix else { };

  anthropicsSkills = pkgs.fetchFromGitHub {
    owner = "anthropics";
    repo = "skills";
    rev = "57546260929473d4e0d1c1bb75297be2fdfa1949";
    hash = "sha256-1D9otXxDvmKASBu/vtAEWv6kE+U+jG4OxZpRLZbGEF0=";
  };

  humanizeKorean = pkgs.fetchFromGitHub {
    owner = "epoko77-ai";
    repo = "im-not-ai";
    rev = "14aeb52d13e737beb4e999cb7cb92275d0969689";
    hash = "sha256-iadJGHavCEXPBYjeo5SyCSgn2yWIJ5YUvRG/2qbuVAY=";
  };

  # Skill for the Orca IDE's CLI (the app itself is installed in darwin/).
  # Declarative equivalent of `npx skills add stablyai/orca --skill orca-cli`.
  orcaRepo = pkgs.fetchFromGitHub {
    owner = "stablyai";
    repo = "orca";
    rev = "e60060039a7ca135c6e99574b89f4f56aebe202c";
    hash = "sha256-6/v6zs5qY2+GwxXYC41sf2gntE11h68O2b5VWoe+08o=";
  };

  # Supermemory, manual-search-only. The plugin is disabled in settings.json:
  # its SessionStart/UserPromptSubmit hooks inject recall context into every
  # request, Claude Code has no per-hook disable, and the plugin's own
  # injectProfile flag is dead config in v0.0.9. Only the search skill is
  # vendored here; auth still reads ~/.supermemory-claude/credentials.json.
  # Note: with the plugin's Stop hook gone, sessions are no longer auto-saved,
  # so search only covers memories accumulated up to the disable date.
  supermemoryPlugin = pkgs.fetchFromGitHub {
    owner = "supermemoryai";
    repo = "claude-supermemory";
    rev = "42cc164e8f8f0f8485184c0db5d8d6723ad1fac1"; # v0.0.9
    hash = "sha256-n+UjPRToN7OHWB1gXXu/+p8AuC41PkKAOTo9s5H9EA8=";
  };
  supermemorySearchSkill = pkgs.runCommand "supermemory-search-skill" { } ''
    mkdir -p $out
    sed 's|''${CLAUDE_PLUGIN_ROOT}|${supermemoryPlugin}/plugin|g' \
      ${supermemoryPlugin}/plugin/skills/supermemory-search/SKILL.md > $out/SKILL.md
  '';

  # Merge the im-not-ai agents with local agent definitions so a sibling file
  # (prose-editor) can live alongside the 12 vendored agents in ~/.claude/agents.
  # The vendored agents' long Korean descriptions are collapsed to one short
  # line: agent descriptions always load into the system prompt (there is no
  # hidden-but-spawnable mode), and these agents are only ever spawned
  # explicitly by the humanize skills, so the routing text is dead weight.
  claudeAgents = pkgs.runCommand "claude-agents" { } ''
    mkdir -p $out
    cp ${humanizeKorean}/agents/*.md $out/
    chmod +w $out/*.md
    for f in $out/*.md; do
      sed -i 's/^description: .*/description: humanize-korean pipeline worker. Never auto-delegate — spawned by name from the humanize skills only./' "$f"
    done
    cp ${./configs/claude/agents}/*.md $out/
  '';

  # herdr-browser renders a Chromium view inside a herdr pane over CDP. herdr
  # has no way to declare plugins in config.toml -- registration only happens
  # through `herdr plugin install` (git-clones into a mutable data dir) or
  # `herdr plugin link <PATH>` (registers a local dir, runs no build). The
  # manifest declares no build step and package.json has devDependencies only,
  # so a plain source fetch is enough -- nothing compiles.
  # The manifest's commands invoke bare `bun`; rewrite them to an absolute
  # store path for the same reason as nushell below -- herdr execs the binary
  # directly and bun is not on the PATH of the process that launched the
  # herdr server. Upstream tags no releases, so the rev is a pinned commit.
  herdrBrowser =
    let
      src = pkgs.fetchFromGitHub {
        owner = "ogulcancelik";
        repo = "herdr-browser";
        rev = "f05ae7a61ead89685eef5a7365f01f81110ba777";
        hash = "sha256-33/ihmGVKh/vP2/KuQ7uj5iMGuVQ0dypBf0NQ78H77A=";
      };
    in
    pkgs.runCommand "herdr-browser" { } ''
      cp -R ${src} $out
      chmod -R u+w $out
      sed -i 's|command = \["bun"|command = ["${lib.getExe pkgs.bun}"|' $out/herdr-plugin.toml
    '';

  sharedAgentRules = ./configs/.agents/AGENTS.md;
  claudeSpecificRules = ./configs/claude/CLAUDE.md;
  claudeUserRules = pkgs.writeText "CLAUDE.md" (
    (builtins.readFile sharedAgentRules) + "\n" + (builtins.readFile claudeSpecificRules)
  );

  # Skills, defined once and linked into both tools' skill trees below. Local
  # skills point at the whole directory (each holds SKILL.md plus optional
  # references/); vendored ones point into their fetched store paths.
  localSkill = name: ./configs/.agents/skills + "/${name}";
  skills = {
    handoff = localSkill "handoff";
    git-master = localSkill "git-master";
    github-master = localSkill "github-master";
    one-domain = localSkill "one-domain";
    diagnose = localSkill "diagnose";
    tdd = localSkill "tdd";
    grill-me = localSkill "grill-me";
    prototype = localSkill "prototype";
    zoom-out = localSkill "zoom-out";
    docs-write = localSkill "docs-write";
    docs-write-tutorial = localSkill "docs-write-tutorial";
    docs-write-concept = localSkill "docs-write-concept";
    docs-write-howto = localSkill "docs-write-howto";
    docs-write-reference = localSkill "docs-write-reference";
    docs-write-status = localSkill "docs-write-status";
    modularize-by-domain = localSkill "modularize-by-domain";
    slopless = localSkill "slopless";
    remove-dead-code = localSkill "remove-dead-code";
    audit-env-variables = localSkill "audit-env-variables";
    website-explainer = localSkill "website-explainer";
    constraint-evasion = localSkill "constraint-evasion";
    claude-hook-management = localSkill "claude-hook-management";
    skill-creator = "${anthropicsSkills}/skills/skill-creator";
    humanize-korean = "${humanizeKorean}/.claude/skills/humanize-korean";
    humanize = "${humanizeKorean}/.claude/skills/humanize";
    humanize-redo = "${humanizeKorean}/.claude/skills/humanize-redo";
    supermemory-search = supermemorySearchSkill;
  };

  # Link every skill into both tools' trees: Claude reads ~/.claude/skills,
  # Codex reads ~/.agents/skills (same SKILL.md format, follows symlinks).
  skillFiles = lib.foldlAttrs (
    acc: name: src:
    acc
    // {
      ".claude/skills/${name}".source = src;
      ".agents/skills/${name}".source = src;
    }
  ) { } skills;
in
{
  imports = [
    ./programs/git.nix
    ./programs/nushell.nix
    ./programs/starship.nix
    ./programs/zellij.nix
  ];

  home.username = "ranolp";
  home.stateVersion = "24.11";

  home.packages = with pkgs; [
    age
    # Runtime for the herdr-browser plugin (see herdrBrowser above).
    bun
    gnupg
    nix-your-shell
  ];

  home.file = lib.mkMerge [
    {
      ".codex/AGENTS.md".source = sharedAgentRules;
      ".claude/CLAUDE.md".source = claudeUserRules;
      ".claude/statusline.sh" = {
        source = ./configs/claude/statusline.sh;
        executable = true;
      };
      ".claude/hooks/git-push-guard.py" = {
        source = ./configs/claude/hooks/git-push-guard.py;
        executable = true;
      };
      # Hard-deny ssh: promote it to the user's own TTY via `! ssh ...`.
      ".claude/hooks/ssh-guard.py" = {
        source = ./configs/claude/hooks/ssh-guard.py;
        executable = true;
      };
      ".claude/hooks/subagent-model-guard.py" = {
        source = ./configs/claude/hooks/subagent-model-guard.py;
        executable = true;
      };
      # Unlock GPG before a signed commit so pinentry can't hijack the TTY.
      ".claude/hooks/gpg-commit-guard.py" = {
        source = ./configs/claude/hooks/gpg-commit-guard.py;
        executable = true;
      };
      # Enforce the repo's declared package manager (npm/pnpm/yarn/bun).
      ".claude/hooks/package-manager-guard.py" = {
        source = ./configs/claude/hooks/package-manager-guard.py;
        executable = true;
      };
      # Force-inject github-master guides on mutating gh pr/issue commands.
      ".claude/hooks/gh-guard.py" = {
        source = ./configs/claude/hooks/gh-guard.py;
        executable = true;
      };
      # Deny direct edits to ~/.claude/ -- the repo is the source of truth.
      ".claude/hooks/claude-dir-edit-guard.py" = {
        source = ./configs/claude/hooks/claude-dir-edit-guard.py;
        executable = true;
      };
      # Block finishing a session with unapplied nix/home/configs edits.
      ".claude/hooks/rebuild-enforcer.py" = {
        source = ./configs/claude/hooks/rebuild-enforcer.py;
        executable = true;
      };
      # Plan mode is distill-only: deny every tool except plan-file writes
      # and ExitPlanMode once permission_mode is "plan".
      ".claude/hooks/plan-mode-guard.py" = {
        source = ./configs/claude/hooks/plan-mode-guard.py;
        executable = true;
      };
      # `ask:` prompts become text-only turns: every tool call is denied.
      ".claude/hooks/ask-mode-guard.py" = {
        source = ./configs/claude/hooks/ask-mode-guard.py;
        executable = true;
      };
      # Restate the output-shape check next to generation, where it applies.
      ".claude/hooks/output-shape-reminder.py" = {
        source = ./configs/claude/hooks/output-shape-reminder.py;
        executable = true;
      };
      # On "command not found", point at mise/project shims before installs.
      ".claude/hooks/missing-tool-hint.py" = {
        source = ./configs/claude/hooks/missing-tool-hint.py;
        executable = true;
      };
      # Codex reuses the same push guard (its PreToolUse hook schema matches Claude's:
      # reads tool_input.command, denies via hookSpecificOutput.permissionDecision).
      ".codex/hooks/git-push-guard.py" = {
        source = ./configs/claude/hooks/git-push-guard.py;
        executable = true;
      };
      ".claude/agents".source = claudeAgents;
      # Pins the herdr-browser store path as a GC root: the plugin registry
      # holds a bare path in herdr's own mutable state, which nix can't see.
      ".local/share/herdr-plugins/herdr-browser".source = herdrBrowser;
      ".gnupg/gpg-agent.conf".source = ./configs/gnupg/gpg-agent.conf;
    }
    # humanize-korean vendored from epoko77-ai/im-not-ai.
    skillFiles
  ];

  # Herdr (terminal workspace manager, installed via mise) spawns new panes with
  # $SHELL, which is zsh. Point it at nushell instead -- absolute path because
  # herdr execs the binary directly, and nu is not on the PATH of the process
  # that launched the herdr server. shell_mode stays "auto" (login shell on
  # macOS); nu supports --login. Run `herdr server reload-config` after a
  # rebuild to pick up the new store path without restarting the session.
  # Tabs are turned off by unbinding every tab action ("" is accepted by
  # `herdr config check`) -- herdr 0.7.5 has no single "disable tabs" switch.
  # With no way to create a second tab, every workspace stays at one tab, so
  # hide_tab_bar_when_single_tab hides the tab row permanently. Workspaces
  # (prefix+shift+n) remain the only grouping level.
  xdg.configFile."herdr/config.toml".text = ''
    [terminal]
    default_shell = "${lib.getExe pkgs.nushell}"

    [keys]
    new_tab = ""
    rename_tab = ""
    previous_tab = ""
    next_tab = ""
    switch_tab = ""
    close_tab = ""

    [theme]
    name = "nord"

    [ui]
    hide_tab_bar_when_single_tab = true
    # "spaces" (default, grouped by space) or "priority" (attention queue).
    agent_panel_sort = "priority"
  '';

  # Claude Code rewrites ~/.claude/settings.json at runtime (model selection,
  # approved permissions), so it can't be a read-only home.file symlink: the
  # runtime write clobbers the symlink into a regular file, and the NEXT
  # activation then hits that unexpected file and silently aborts the whole
  # ~/.claude relink -- which is why edits to CLAUDE.md/agents stopped taking.
  # Generate it as a writable copy instead (same rationale as codexConfig below):
  # repo settings are the source of truth, re-asserted on every rebuild; Claude
  # owns any runtime drift (e.g. model) in between rebuilds.
  home.activation.claudeSettings = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    out="$HOME/.claude/settings.json"
    run mkdir -p "$HOME/.claude"
    run rm -f "$out"
    run install -m 0644 ${./configs/claude/settings.json} "$out"
  '';

  # The Orca app's skill panel classifies installs by topology, and only the
  # layout `npx skills add --global` produces is fully recognized: a REAL
  # canonical directory at ~/.agents/skills/<name> ('canonical-copy') with
  # per-provider symlinks pointing at it ('provider-alias'). A symlink into the
  # nix store is an unsupported 'external-link' topology, so it can't live in
  # the skills set above -- reproduce the npx layout declaratively instead.
  home.activation.orcaSkills = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    for name in orca-cli computer-use orchestration; do
      canonical="$HOME/.agents/skills/$name"
      run rm -rf "$canonical"
      run mkdir -p "$canonical"
      run cp -R "${orcaRepo}/skills/$name/." "$canonical/"
      run chmod -R u+w "$canonical"
      run mkdir -p "$HOME/.claude/skills"
      run ln -sfn "$canonical" "$HOME/.claude/skills/$name"
    done
  '';

  # Register herdr-browser (fetched above) with herdr. `plugin link` is the only
  # declarative-friendly entry point: it takes a local dir and runs no build.
  # Unlink first so a rev bump re-points the registry at the new store path
  # instead of leaving the old one behind. herdr comes from mise, not nix, so
  # skip silently when it is not installed yet (fresh machine). The registry is
  # server state -- run `herdr server reload-config` after a rebuild.
  home.activation.herdrBrowserPlugin = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    herdrBin="$HOME/.local/share/mise/shims/herdr"
    if [ -x "$herdrBin" ]; then
      "$herdrBin" plugin unlink official.browser >/dev/null 2>&1 || true
      run "$herdrBin" plugin link ${herdrBrowser} --enabled
    fi
  '';

  home.activation.nixYourShellCache = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    mkdir -p "$HOME/.cache"
    ${pkgs.nix-your-shell}/bin/nix-your-shell nu > "$HOME/.cache/nix-your-shell.nu" 2>/dev/null || touch "$HOME/.cache/nix-your-shell.nu"
  '';

  # Codex CLI config: not symlinked. Codex rewrites ~/.codex/config.toml at
  # runtime (project trust, TUI state), and trust entries are absolute paths
  # specific to this machine, so they must stay uncommitted. We generate
  # config.toml on activation = repo settings + ONLY the [projects.*] trust
  # blocks from the uncommitted ~/.codex/config.local.toml (other keys there are
  # ignored, so repo settings always win). Edit config.local.toml by hand to add
  # trusted projects; everything else in ~/.codex stays owned by Codex.
  home.activation.codexConfig = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    codexDir="$HOME/.codex"
    out="$codexDir/config.toml"
    localTrust="$codexDir/config.local.toml"
    run mkdir -p "$codexDir"
    # Drop any leftover read-only symlink from previous management.
    [ -L "$out" ] && run rm -f "$out"
    run install -m 0644 ${./configs/codex/config.toml} "$out"
    if [ -f "$localTrust" ]; then
      {
        echo ""
        ${pkgs.gawk}/bin/awk '/^\[/ { keep = ($0 ~ /^\[projects\./ || $0 ~ /^\[mcp_servers\./) } keep' "$localTrust"
      } >> "$out"
    fi
  '';

  programs.home-manager.enable = true;

  programs.mise = {
    enable = true;
    # The zsh `mise activate` hook is back: its startup deadlock was the nix
    # zsh 5.9 SIGCHLD race in $(...), gone since Apple's /bin/zsh is served
    # from the user profile (4f85605). The shims dir stays on PATH in .zshenv
    # as the tool source for NON-interactive zsh (Claude's Bash tool), which
    # skips .zshrc and never runs the hook. Nushell keeps shims only
    # (env.common.nu); its integration predates the same investigation and
    # nu's prompt already works without the hook.
    enableNushellIntegration = false;
    enableZshIntegration = true;
    # Shared tool versions live in ./mise-global.toml (single source, also read
    # by the Windows xpkg installer). Darwin-only tools are layered on here.
    globalConfig =
      let
        base = builtins.fromTOML (builtins.readFile ./mise-global.toml);
      in
      base
      // {
        tools =
          base.tools
          // lib.optionalAttrs pkgs.stdenv.isDarwin {
            herdr = "0.7.5";
            colima = "0.10.3";
            lima = "2.1.4";
            docker-cli = "29.6.0";
          };
      };
  };
}
