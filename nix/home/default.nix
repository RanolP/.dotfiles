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

  # Merge the im-not-ai agents with local agent definitions so a sibling file
  # (prose-editor) can live alongside the 12 vendored agents in ~/.claude/agents.
  claudeAgents = pkgs.runCommand "claude-agents" { } ''
    mkdir -p $out
    cp ${humanizeKorean}/agents/*.md $out/
    cp ${./configs/claude/agents}/*.md $out/
  '';
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
    gnupg
    nix-your-shell
  ];

  home.file.".claude/CLAUDE.md".source = ./configs/claude/CLAUDE.md;
  home.file.".claude/statusline.sh" = {
    source = ./configs/claude/statusline.sh;
    executable = true;
  };
  home.file.".claude/hooks/git-push-guard.py" = {
    source = ./configs/claude/hooks/git-push-guard.py;
    executable = true;
  };
  # Codex reuses the same push guard (its PreToolUse hook schema matches Claude's:
  # reads tool_input.command, denies via hookSpecificOutput.permissionDecision).
  home.file.".codex/hooks/git-push-guard.py" = {
    source = ./configs/claude/hooks/git-push-guard.py;
    executable = true;
  };
  home.file.".claude/skills/handoff/SKILL.md".source = ./configs/claude/skills/handoff/SKILL.md;
  home.file.".claude/skills/decompose/SKILL.md".source = ./configs/claude/skills/decompose/SKILL.md;
  home.file.".claude/skills/one-domain/SKILL.md".source = ./configs/claude/skills/one-domain/SKILL.md;
  home.file.".claude/skills/codex-edit/SKILL.md".source = ./configs/claude/skills/codex-edit/SKILL.md;
  home.file.".claude/skills/diagnose/SKILL.md".source = ./configs/claude/skills/diagnose/SKILL.md;
  home.file.".claude/skills/tdd/SKILL.md".source = ./configs/claude/skills/tdd/SKILL.md;
  home.file.".claude/skills/grill-me/SKILL.md".source = ./configs/claude/skills/grill-me/SKILL.md;
  home.file.".claude/skills/prototype/SKILL.md".source = ./configs/claude/skills/prototype/SKILL.md;
  home.file.".claude/skills/zoom-out/SKILL.md".source = ./configs/claude/skills/zoom-out/SKILL.md;
  home.file.".claude/skills/technical-writing/SKILL.md".source =
    ./configs/claude/skills/technical-writing/SKILL.md;
  home.file.".claude/skills/slopless/SKILL.md".source = ./configs/claude/skills/slopless/SKILL.md;
  home.file.".claude/skills/remove-dead-code".source = ./configs/claude/skills/remove-dead-code;
  home.file.".claude/skills/audit-env-variables".source = ./configs/claude/skills/audit-env-variables;
  home.file.".claude/skills/skill-creator".source = "${anthropicsSkills}/skills/skill-creator";
  # Humanize KR (epoko77-ai/im-not-ai): rewrites AI-sounding Korean to read human.
  home.file.".claude/skills/humanize-korean".source =
    "${humanizeKorean}/.claude/skills/humanize-korean";
  home.file.".claude/skills/humanize".source = "${humanizeKorean}/.claude/skills/humanize";
  home.file.".claude/skills/humanize-redo".source = "${humanizeKorean}/.claude/skills/humanize-redo";
  home.file.".claude/agents".source = claudeAgents;
  home.file.".claude/settings.json".source = ./configs/claude/settings.json;

  home.file.".gnupg/gpg-agent.conf".source = ./configs/gnupg/gpg-agent.conf;

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
        ${pkgs.gawk}/bin/awk '/^\[/ { keep = ($0 ~ /^\[projects\./) } keep' "$localTrust"
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
        node = "24.17.0";
        python = "3.14.6";
        uv = "0.11.24";
        fzf = "0.73.1";
        bat = "0.26.1";
        eza = "0.23.4";
        ripgrep = "15.1.0";
        fd = "10.4.2";
        jq = "1.8.2";
        gh = "2.95.0";
        delta = "0.19.2";
        claude = "2.1.187";
        "npm:@mariozechner/pi-coding-agent" = "0.73.1";
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
