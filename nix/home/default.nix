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
    codex-edit = localSkill "codex-edit";
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
      ".claude/hooks/subagent-model-guard.py" = {
        source = ./configs/claude/hooks/subagent-model-guard.py;
        executable = true;
      };
      # Codex reuses the same push guard (its PreToolUse hook schema matches Claude's:
      # reads tool_input.command, denies via hookSpecificOutput.permissionDecision).
      ".codex/hooks/git-push-guard.py" = {
        source = ./configs/claude/hooks/git-push-guard.py;
        executable = true;
      };
      ".claude/agents".source = claudeAgents;
      ".claude/settings.json".source = ./configs/claude/settings.json;
      ".gnupg/gpg-agent.conf".source = ./configs/gnupg/gpg-agent.conf;
    }
    # humanize-korean vendored from epoko77-ai/im-not-ai.
    skillFiles
  ];

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
    enableNushellIntegration = true;
    globalConfig = {
      settings = {
        experimental = true;
        pipx.uvx = true;
      };
      tools = {
        node = "24.18.0";
        python = "3.14.6";
        rust = "1.96.1";
        uv = "0.11.24";
        fzf = "0.73.1";
        bat = "0.26.1";
        eza = "0.23.4";
        ripgrep = "15.1.0";
        fd = "10.4.2";
        jq = "1.8.2";
        duckdb = "1.5.4";
        gh = "2.95.0";
        delta = "0.19.2";
        claude = "2.1.187";
        "npm:@earendil-works/pi-coding-agent" = "0.80.3";
        "npm:@getgrit/cli" = "0.1.0-alpha.1743007075";
        "npm:@openai/codex" = "0.142.0";
        "npm:slopless" = "0.2.22";
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
