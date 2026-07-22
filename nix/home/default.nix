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
    decompose = localSkill "decompose";
    one-domain = localSkill "one-domain";
    diagnose = localSkill "diagnose";
    tdd = localSkill "tdd";
    grill-me = localSkill "grill-me";
    prototype = localSkill "prototype";
    zoom-out = localSkill "zoom-out";
    technical-writing = localSkill "technical-writing";
    slopless = localSkill "slopless";
    remove-dead-code = localSkill "remove-dead-code";
    audit-env-variables = localSkill "audit-env-variables";
    website-explainer = localSkill "website-explainer";
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
      # `ask:` prompts become text-only turns: every tool call is denied.
      ".claude/hooks/ask-mode-guard.py" = {
        source = ./configs/claude/hooks/ask-mode-guard.py;
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
      ".gnupg/gpg-agent.conf".source = ./configs/gnupg/gpg-agent.conf;
    }
    # humanize-korean vendored from epoko77-ai/im-not-ai.
    skillFiles
  ];

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

  # argent's self-update rewrites ~/.claude/rules/argent.md at runtime (same
  # problem as settings.json above: a rewrite would clobber a read-only symlink
  # and abort the next ~/.claude relink), so install a writable copy. The repo
  # version path-scopes the rule (paths: frontmatter) so its ~4.6k tokens load
  # only in mobile projects; re-asserted over any argent drift on each rebuild.
  home.activation.claudeRules = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    out="$HOME/.claude/rules/argent.md"
    run mkdir -p "$HOME/.claude/rules"
    run rm -f "$out"
    run install -m 0644 ${./configs/claude/rules/argent.md} "$out"
  '';

  # The Orca app's skill panel classifies installs by topology, and only the
  # layout `npx skills add --global` produces is fully recognized: a REAL
  # canonical directory at ~/.agents/skills/<name> ('canonical-copy') with
  # per-provider symlinks pointing at it ('provider-alias'). A symlink into the
  # nix store is an unsupported 'external-link' topology, so it can't live in
  # the skills set above -- reproduce the npx layout declaratively instead.
  home.activation.orcaSkills = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    for name in orca-cli computer-use; do
      canonical="$HOME/.agents/skills/$name"
      run rm -rf "$canonical"
      run mkdir -p "$canonical"
      run cp -R "${orcaRepo}/skills/$name/." "$canonical/"
      run chmod -R u+w "$canonical"
      run mkdir -p "$HOME/.claude/skills"
      run ln -sfn "$canonical" "$HOME/.claude/skills/$name"
    done
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
    # No `mise activate` hook in either shell: it deadlocks zsh at startup
    # (blocks on a state lock). Tools resolve through the mise shims dir, which
    # is already on PATH in both shells (.zshenv for zsh, env.common.nu for nu).
    enableNushellIntegration = false;
    enableZshIntegration = false;
    globalConfig = {
      settings = {
        experimental = true;
        pipx.uvx = true;
      };
      tools = {
        node = "24.18.0";
        python = "3.14.6";
        rust = "1.96.1";
        uv = "0.11.26";
        fzf = "0.73.1";
        bat = "0.26.1";
        eza = "0.23.4";
        ripgrep = "15.1.0";
        fd = "10.4.2";
        jq = "1.8.2";
        duckdb = "1.5.4";
        gh = "2.95.0";
        delta = "0.19.2";
        claude = "2.1.215";
        "npm:@earendil-works/pi-coding-agent" = "0.80.3";
        "npm:@getgrit/cli" = "0.1.0-alpha.1743007075";
        "npm:@openai/codex" = "0.144.2";
        # Argent: agentic toolkit / MCP server for iOS simulators, Android
        # emulators, TV and Electron targets (argent.swmansion.com).
        "npm:@swmansion/argent" = "0.16.0";
        "npm:slopless" = "0.2.23";
        "pipx:reuse" = "6.2.0";
      }
      // lib.optionalAttrs pkgs.stdenv.isDarwin {
        colima = "0.10.3";
        lima = "2.1.3";
        docker-cli = "29.6.0";
      };
    };
  };
}
