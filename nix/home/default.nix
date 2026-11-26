{
  pkgs,
  lib,
  config,
  ...
}:
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

  # Official Notion agent skills; only notion-cli exists so far. Declarative
  # equivalent of `npx skills add makenotion/skills --skill notion-cli`.
  notionSkills = pkgs.fetchFromGitHub {
    owner = "makenotion";
    repo = "skills";
    rev = "423af2bf546cd0354e5cc871017251945d9ad14f";
    hash = "sha256-rzT+jXI+hwoXvqS/ln6PT2juxzFsDoKGIOygkJWCM94=";
  };

  # TypeSafe (Jev) agent skill. Declarative equivalent of
  # `npx skills add typesafe-ai/skills --skill typesafe-ai`.
  typesafeSkills = pkgs.fetchFromGitHub {
    owner = "typesafe-ai";
    repo = "skills";
    rev = "65a39f393687675ce170e6094757de20370365b9";
    hash = "sha256-Lh2Y90TFv+njKqo/g5WXEHw0Rk1jQSH5POqKtrvy5kM=";
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
  # The CLI is the mise-pinned `npm:modern-web-guidance`; upstream SKILL.md runs
  # it through `npx ... @latest`, so rewrite those calls to the pinned binary.
  # The greps fail the build if an upstream rewording slips past the sed.
  modernWebGuidance = pkgs.fetchFromGitHub {
    owner = "GoogleChrome";
    repo = "modern-web-guidance";
    rev = "v0.0.196";
    hash = "sha256-9m+BsqvNv0InwgxdaJVQxMYb2JnUN3Q/8VsH+QPk8tg=";
  };
  modernWebGuidanceSkill = pkgs.runCommand "modern-web-guidance-skill" { } ''
    cp -r ${modernWebGuidance}/skills/modern-web-guidance $out
    chmod -R u+w $out
    sed -i \
      -e 's|npx -y modern-web-guidance@latest |modern-web-guidance |g' \
      -e 's| directly with `npx` using| using|' \
      -e '/^## Using npx/,/^- If the command hangs/c\
    ## Using the CLI\
    \
    - `modern-web-guidance` is a pinned binary on PATH (mise); run it directly by that name.' \
      $out/SKILL.md
    if grep -nE 'npx|pnpx|@latest' $out/SKILL.md; then echo "modern-web-guidance: unpatched launcher left in SKILL.md" >&2; exit 1; fi
    grep -q '^modern-web-guidance search ' $out/SKILL.md
    grep -q '^modern-web-guidance retrieve ' $out/SKILL.md
  '';
  supermemorySearchSkill = pkgs.runCommand "supermemory-search-skill" { } ''
    mkdir -p $out
    sed 's|''${CLAUDE_PLUGIN_ROOT}|${supermemoryPlugin}/plugin|g' \
      ${supermemoryPlugin}/plugin/skills/supermemory-search/SKILL.md > $out/SKILL.md
  '';

  # The vendored choco-pi tree, deployed to ~/.pi/agent/vendor/choco-pi where
  # configs/pi/settings.json points its relative `packages` entries (the review
  # extension writes its data under ~/.pi/agent/choco-pi, so the tree stays out
  # of that path). Pi never npm-installs a local package, so the two dirs with
  # third-party dependencies get node_modules from their committed pnpm
  # lockfiles -- the macOS twin of xpkg/configs/pi/install.nu. fetchPnpmDeps
  # only downloads registry tarballs and the install runs offline with
  # --ignore-scripts, so nothing compiles. Each lockfile has its own
  # fixed-output hash: after a lockfile change, set it to lib.fakeHash, build,
  # and copy the `got: sha256-...` value back.
  piVendor =
    let
      src = ./configs/pi/choco-pi;
      pnpm = pkgs.pnpm_11;
      nodeModules =
        name: dir: hash:
        pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
          pname = "choco-pi-${name}-node-modules";
          version = "0";
          src = dir;
          pnpmDeps = pkgs.fetchPnpmDeps {
            inherit (finalAttrs) pname version src;
            inherit pnpm hash;
            fetcherVersion = 4;
          };
          nativeBuildInputs = [
            pnpm
            pkgs.pnpmConfigHook
          ];
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            if [ ! -d node_modules ]; then
              echo "piVendor: pnpm install in ${name} left no node_modules" >&2
              exit 1
            fi
            cp -R node_modules $out
            runHook postInstall
          '';
        });
      webAccessModules =
        nodeModules "web-access" ./configs/pi/choco-pi/packages/choco-pi-web-access
          "sha256-Mc/ZxWUKA5MljxxzoPEZfty7JgyMEJB4wYNgzcWW6ew=";
      extensionsModules =
        nodeModules "extensions" ./configs/pi/choco-pi/extensions
          "sha256-z2Uea2EpZNimbzxVhEmQUeYo/3eYaTrN/6rLCzLI9XI=";
    in
    pkgs.runCommand "choco-pi-vendor" { } ''
      cp -R ${src} $out
      chmod -R u+w $out
      cp -R ${webAccessModules} $out/packages/choco-pi-web-access/node_modules
      cp -R ${extensionsModules} $out/extensions/node_modules
      for dir in packages/choco-pi-web-access extensions; do
        if [ ! -d "$out/$dir/node_modules" ]; then
          echo "piVendor: $out/$dir/node_modules is missing after the copy" >&2
          exit 1
        fi
      done
    '';

  sharedAgentRules = ./configs/.agents/AGENTS.md;
  claudeSpecificRules = ./configs/claude/CLAUDE.md;
  # Claude Code warns once ~/.claude/CLAUDE.md passes 40.0k chars, and every
  # byte here is paid on every prompt. stringLength counts bytes, which is >=
  # chars, so the check errs on the safe side.
  claudeUserRulesText =
    (builtins.readFile sharedAgentRules) + "\n" + (builtins.readFile claudeSpecificRules);
  claudeUserRulesLimit = 40000;
  # The mod's test runtime cannot read files, so this build step is the guard
  # that agents/*.md still match TYPES in hooks/register.ts.
  heteroSubagentsMod =
    pkgs.runCommand "hetero-subagents-mod" { nativeBuildInputs = [ pkgs.python3 ]; }
      ''
        python3 ${../../scripts/hetero-agents-check.py} ${./configs/claude/mods/hetero-subagents}
        cp -r ${./configs/claude/mods/hetero-subagents} $out
      '';
  claudeUserRules =
    let
      size = builtins.stringLength claudeUserRulesText;
    in
    if size > claudeUserRulesLimit then
      throw "~/.claude/CLAUDE.md would be ${toString size} bytes, over the ${toString claudeUserRulesLimit}-byte limit (Claude Code warns at 40.0k chars). Shrink nix/home/configs/.agents/AGENTS.md + nix/home/configs/claude/CLAUDE.md: move skill-scoped detail into its skill and incident narrative into docs/src/agent-incidents.md (see the repo AGENTS.md rule on the two always-loaded rules files)."
    else
      pkgs.writeText "CLAUDE.md" claudeUserRulesText;

  # Response-shape rules, held apart from the rules files because the two tools
  # consume them differently. Claude has an output style layer whose whole body
  # is inserted into the system prompt and which wins over general formatting
  # guidance; Codex has no such layer, so the same body is appended to its
  # AGENTS.md. Editing this one file moves both. Its plain-reporting rules
  # merge the `claude` 2.1.280 builtin Concise style, the default prompt's
  # flag-gated "Communicating with the user" (`basalt_cove`) and "Writing for
  # the user" (`tengu_willow_tern`) sections, and the responsive-mode phrase
  # ban, extended to Korean.
  outputManner = ./configs/.agents/output-manner.md;
  claudeOutputStyle = pkgs.writeText "concise-adhd-korean.md" (
    ''
      ---
      name: concise-adhd-korean
      description: ADHD 독자에 맞춘 한국어 문체와 간결한 보고 규칙을 합친 출력 스타일이다. 코딩 지침을 유지한다.
      keep-coding-instructions: true
      ---

    ''
    + builtins.readFile outputManner
  );
  codexAgentRules = pkgs.writeText "AGENTS.md" (
    (builtins.readFile sharedAgentRules)
    + "\n"
    + (builtins.readFile ./configs/codex/AGENTS.md)
    + "\n"
    + (builtins.readFile outputManner)
  );
  codexConfig = pkgs.writeText "codex-config.toml" (
    builtins.replaceStrings
      [ "@codexConfig@" "@dotfilesConfig@" ]
      [
        "${config.home.homeDirectory}/.codex/config.toml"
        "${config.home.homeDirectory}/.dotfiles/.codex/config.toml"
      ]
      (builtins.readFile ./configs/codex/config.toml)
  );

  # Skills, defined once and linked into both tools' skill trees below. Local
  # skills point at the whole directory (each holds SKILL.md plus optional
  # references/); vendored ones point into their fetched store paths.
  # Every local skill is a subdirectory of ONE store copy of the skills tree,
  # so a script that imports a sibling skill by relative path
  # (design-review -> ../artificier-comparison) resolves after node follows
  # the ~/.claude/skills symlink to its real path, exactly as it does in the repo.
  localSkill = name: "${./configs/.agents/skills}/${name}";
  skills = {
    git-master = localSkill "git-master";
    copy-sync = localSkill "copy-sync";
    ship = localSkill "ship";
    update = localSkill "update";
    github-master = localSkill "github-master";
    jira-master = localSkill "jira-master";
    jira-qa-batch = localSkill "jira-qa-batch";
    component-pixel-review = localSkill "component-pixel-review";
    design-review = localSkill "design-review";
    artificier-comparison = localSkill "artificier-comparison";
    reverse-engineer-anything = localSkill "reverse-engineer-anything";
    slack-messaging = localSkill "slack-messaging";
    worktree-cleanup = localSkill "worktree-cleanup";
    want-exit = localSkill "want-exit";
    parallel-worktree-workflow = localSkill "parallel-worktree-workflow";
    one-domain = localSkill "one-domain";
    diagnose = localSkill "diagnose";
    tdd = localSkill "tdd";
    grill-me = localSkill "grill-me";
    prototype = localSkill "prototype";
    zoom-out = localSkill "zoom-out";
    docs-write = localSkill "docs-write";
    modularize-by-domain = localSkill "modularize-by-domain";
    slopless = localSkill "slopless";
    remove-dead-code = localSkill "remove-dead-code";
    audit-env-variables = localSkill "audit-env-variables";
    website-explainer = localSkill "website-explainer";
    visual-explainer = localSkill "visual-explainer";
    patch-review = localSkill "patch-review";
    constraint-evasion = localSkill "constraint-evasion";
    claude-hook-management = localSkill "claude-hook-management";
    memory-review = localSkill "memory-review";
    correct = localSkill "correct";
    create-verification-skill = localSkill "create-verification-skill";
    # Nix store path names reject `:`, so the source directory is
    # `dotfiles-evolve` while the link the user types carries the colon.
    "dotfiles:evolve" = localSkill "dotfiles-evolve";
    prompt-authoring = localSkill "prompt-authoring";
    rule-write = localSkill "rule-write";
    ui-automation = localSkill "ui-automation";
    record-replay = localSkill "record-replay";
    metro-wait = localSkill "metro-wait";
    quint-verify = localSkill "quint-verify";
    evidence-store = localSkill "evidence-store";
    teardown = localSkill "teardown";
    hillclimb = localSkill "hillclimb";
    typescript-types = localSkill "typescript-types";
    reframe = localSkill "reframe";
    why = localSkill "why";
    apology = localSkill "apology";
    # Same skill under the name the user actually types. Slash-command
    # resolution uses the linked directory name, so the alias is a second link
    # to one source, not a copy.
    "시말서" = localSkill "apology";
    skill-creator = "${anthropicsSkills}/skills/skill-creator";
    notion-cli = "${notionSkills}/skills/notion-cli";
    typesafe-ai = "${typesafeSkills}/skills/typesafe-ai";
    supermemory-search = supermemorySearchSkill;
    modern-web-guidance = modernWebGuidanceSkill;
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
    ./programs/figma-cli.nix
    ./programs/git.nix
    ./programs/jira-cli.nix
    ./programs/nushell.nix
    ./programs/starship.nix
    ./programs/telemetry.nix
    ./programs/zellij.nix
  ];

  home.username = "ranolp";
  home.stateVersion = "24.11";

  home.packages = with pkgs; [
    age
    # Composes the QA review videos built by the jira-qa-batch skill.
    ffmpeg
    gnupg
    nix-your-shell
  ];

  home.file = lib.mkMerge [
    {
      ".codex/AGENTS.md".source = codexAgentRules;
      ".codex/agents/code-reviewer.toml".source = ./configs/codex/agents/code-reviewer.toml;
      ".codex/agents/prose-editor.toml".source = ./configs/codex/agents/prose-editor.toml;
      ".codex/agents/oracle.toml".source = ./configs/codex/agents/oracle.toml;
      # Claude gets this skill from its frontend-design plugin.
      ".agents/skills/frontend-design".source = "${anthropicsSkills}/skills/frontend-design";
      ".profile".text = ''
        export PATH="$HOME/.local/bin:$HOME/.local/share/mise/shims:$PATH"
        # Rex opens each pane in the login shell (/bin/sh, see
        # nix/darwin/default.nix) and has no setting for another one, so an
        # interactive Rex pane hands itself to nushell. `rex run -- cmd` and
        # other non-interactive logins stay in sh.
        case $- in *i*)
          if [ -n "''${REX_SESSION-}" ]; then exec ${lib.getExe pkgs.nushell} --login; fi ;;
        esac
      '';
      # Tokens come from the environment (~/.secrets.env, gh auth token), so no
      # secret lands in the store. pnpm >= 10.34.2 expands ${...} only in this
      # user-level file, not in a repository's .npmrc.
      ".npmrc".text = ''
        //registry.npmjs.org/:_authToken=''${NPM_TOKEN}
        //npm.pkg.github.com/:_authToken=''${GITHUB_TOKEN}
      '';
      ".claude/CLAUDE.md".source = claudeUserRules;
      ".claude/statusline.sh" = {
        source = ./configs/claude/statusline.sh;
        executable = true;
      };
      ".claude/hooks/git-push-guard.py" = {
        source = ./configs/claude/hooks/git-push-guard.py;
        executable = true;
      };
      ".claude/hooks/command_cwd.py".source = ./configs/claude/hooks/command_cwd.py;
      # This machine's package set is declared (mise-global.toml, homebrew
      # lists, the flake). An imperative install lands outside all three, so
      # the guard denies one and names the file to edit instead.
      ".claude/hooks/declarative-package-guard.py" = {
        source = ./configs/claude/hooks/declarative-package-guard.py;
        executable = true;
      };
      # A flake reads the git tree, so a new file that was never staged is
      # invisible to the rebuild. Stage the untracked ones before it runs.
      # Commit b28bf99 shipped declarative-package-guard.py without its
      # settings.json registration, leaving it deployed-but-inert for weeks. The
      # guard denies a commit whose edited files never had their check run.
      ".claude/hooks/commit-check-guard.py" = {
        source = ./configs/claude/hooks/commit-check-guard.py;
        executable = true;
      };
      # Denies a commit to a github.com/RanolP/ repo whose staged diff adds a
      # secret or a denylisted private identifier.
      ".claude/hooks/leak-guard.py" = {
        source = ./configs/claude/hooks/leak-guard.py;
        executable = true;
      };
      # Nothing triggered the memory-review skill, so promotion candidates piled
      # up unread. This nudges once the pile grows.
      ".claude/hooks/memory-review-nudge.py" = {
        source = ./configs/claude/hooks/memory-review-nudge.py;
        executable = true;
      };
      ".claude/hooks/flake-stage-guard.py" = {
        source = ./configs/claude/hooks/flake-stage-guard.py;
        executable = true;
      };
      # Deny --no-verify and force-push. Separate from git-push-guard because
      # that hook's .nanno-workers.json bypass must not reach these two.
      ".claude/hooks/git-integrity-guard.py" = {
        source = ./configs/claude/hooks/git-integrity-guard.py;
        executable = true;
      };
      ".claude/hooks/nsc-guard.py" = {
        source = ./configs/claude/hooks/nsc-guard.py;
        executable = true;
      };
      # A registry publish is irreversible: the user runs it as `! <command>`.
      ".claude/hooks/publish-guard.py" = {
        source = ./configs/claude/hooks/publish-guard.py;
        executable = true;
      };
      ".claude/hooks/gui-launch-guard.py" = {
        source = ./configs/claude/hooks/gui-launch-guard.py;
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
      # The positive-form authoring rules arrive when behavior text is edited,
      # not in every session's CLAUDE.md.
      ".claude/hooks/prompt-authoring-guard.py" = {
        source = ./configs/claude/hooks/prompt-authoring-guard.py;
        executable = true;
      };
      # Point a reader-facing Markdown/HTML edit at the prose-editor subagent,
      # once per file per session, without denying the edit.
      ".claude/hooks/prose-review-nudge.py" = {
        source = ./configs/claude/hooks/prose-review-nudge.py;
        executable = true;
      };
      # The Fable-only rules load at SessionStart when the model is Fable, so a
      # non-Fable session does not carry them in CLAUDE.md.
      ".claude/hooks/architect-rules.py" = {
        source = ./configs/claude/hooks/architect-rules.py;
        executable = true;
      };
      # Enforce the repo's declared package manager (npm/pnpm/yarn/bun).
      ".claude/hooks/package-manager-guard.py" = {
        source = ./configs/claude/hooks/package-manager-guard.py;
        executable = true;
      };
      # Nudge UI automation toward agent-browser / agent-device: one prompt
      # per session per family, then out of the way.
      ".claude/hooks/agent-tooling-guard.py" = {
        source = ./configs/claude/hooks/agent-tooling-guard.py;
        executable = true;
      };
      # Force-inject github-master guides on mutating gh pr/issue commands.
      ".claude/hooks/gh-guard.py" = {
        source = ./configs/claude/hooks/gh-guard.py;
        executable = true;
      };
      # Force-inject the jira-master skill on mutating `jira edit` commands.
      ".claude/hooks/jira-guard.py" = {
        source = ./configs/claude/hooks/jira-guard.py;
        executable = true;
      };
      # Keep a PR body from losing remote lines or shipping a broken mermaid fence.
      ".claude/hooks/pr-body-guard.py" = {
        source = ./configs/claude/hooks/pr-body-guard.py;
        executable = true;
      };
      # Keep 시말서 records in .apologies/ from reaching any outbound channel.
      ".claude/hooks/apology-leak-guard.py" = {
        source = ./configs/claude/hooks/apology-leak-guard.py;
        executable = true;
      };
      # Route a single-file shell edit back to Edit/Write, which skip the
      # ~2s approval step a write-shaped shell command pays.
      ".claude/hooks/file-edit-guard.py" = {
        source = ./configs/claude/hooks/file-edit-guard.py;
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
      # Snapshot MCP token health before the session connects, so an "it logged
      # out again" report separates an expired token from a failed refresh.
      ".claude/hooks/mcp-auth-log.py" = {
        source = ./configs/claude/hooks/mcp-auth-log.py;
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
      # A prompt complaining of a repeated mistake gets a nudge to turn the
      # class into a mechanism (skill `correct` / `rule-write`).
      ".claude/hooks/repeat-correction-nudge.py" = {
        source = ./configs/claude/hooks/repeat-correction-nudge.py;
        executable = true;
      };
      # Block a "done" reply when nothing ran after the turn's last code edit.
      ".claude/hooks/done-claim-guard.py" = {
        source = ./configs/claude/hooks/done-claim-guard.py;
        executable = true;
      };
      # Block a mostly-English reply when the output style requires Korean.
      ".claude/hooks/korean-reply-guard.py" = {
        source = ./configs/claude/hooks/korean-reply-guard.py;
        executable = true;
      };
      # Keep Claude Code's Rex pane tinted for the cwd or file it just touched.
      ".claude/hooks/rex-project-theme.py" = {
        source = ./configs/claude/hooks/rex-project-theme.py;
        executable = true;
      };
      # clm replaces compaction: at turn end it folds older turns into a
      # ledger. CLAUDE_CODE_PLUGIN_DIRS in settings.json loads it. The whole
      # directory is linked as one store path because Claude Code rejects a
      # hook module whose realpath escapes the plugin directory.
      ".claude/mods/clm".source = ./configs/claude/mods/clm;
      # wayseeker keeps the user's instructions as a logic ledger per session;
      # independent of clm, which only reads it through $.wayseeker.instructions.
      ".claude/mods/wayseeker".source = ./configs/claude/mods/wayseeker;
      # resources tracks owned processes and cross-session mutexes per session.
      ".claude/mods/resources".source = ./configs/claude/mods/resources;
      # hetero-subagents runs subagent types through Codex or Antigravity;
      # its hook starts the bridge as `node <root>/daemon/codex-bridge.mjs`.
      ".claude/mods/hetero-subagents".source = heteroSubagentsMod;
      # time-budget gates every tool on an estimate and stops the work at the
      # budget: checkpoint reports at 1/3, 1/2, 2/3, 5/6, then abort past 6/6.
      ".claude/mods/time-budget".source = ./configs/claude/mods/time-budget;
      # summation-panel: one auto-opened pane of usage, subagents, dotfiles version, and clm/wayseeker state read from disk.
      ".claude/mods/summation-panel".source = ./configs/claude/mods/summation-panel;
      # ask-later: a non-blocking AskUserQuestion; the model queues questions
      # and keeps working, and /answers walks them when the user chooses.
      ".claude/mods/ask-later".source = ./configs/claude/mods/ask-later;
      # request: escalate a Bash call the auto-mode classifier denied; on the
      # user's /approvals approval the mod itself runs the exact command once.
      ".claude/mods/request".source = ./configs/claude/mods/request;
      # bg-compact: pre-compute a summary before the auto-compact limit so compaction is that summary plus the later messages
      ".claude/mods/bg-compact".source = ./configs/claude/mods/bg-compact;
      # On "command not found", point at mise/project shims before installs.
      ".claude/hooks/missing-tool-hint.py" = {
        source = ./configs/claude/hooks/missing-tool-hint.py;
        executable = true;
      };
      ".claude/hooks/bare-sleep-hint.py" = {
        source = ./configs/claude/hooks/bare-sleep-hint.py;
        executable = true;
      };
      # Reuse the Claude policy scripts; the Codex adapter translates tool payloads.
      ".codex/hooks/claude-hook-adapter.py" = {
        source = ./configs/codex/hooks/claude-hook-adapter.py;
        executable = true;
      };
      ".codex/hooks/command_cwd.py".source = ./configs/claude/hooks/command_cwd.py;
      ".codex/hooks/git-push-guard.py" = {
        source = ./configs/claude/hooks/git-push-guard.py;
        executable = true;
      };
      ".codex/hooks/git-integrity-guard.py" = {
        source = ./configs/claude/hooks/git-integrity-guard.py;
        executable = true;
      };
      ".codex/hooks/flake-stage-guard.py" = {
        source = ./configs/claude/hooks/flake-stage-guard.py;
        executable = true;
      };
      ".codex/hooks/ssh-guard.py" = {
        source = ./configs/claude/hooks/ssh-guard.py;
        executable = true;
      };
      ".codex/hooks/package-manager-guard.py" = {
        source = ./configs/claude/hooks/package-manager-guard.py;
        executable = true;
      };
      ".codex/hooks/declarative-package-guard.py" = {
        source = ./configs/claude/hooks/declarative-package-guard.py;
        executable = true;
      };
      ".codex/hooks/gh-guard.py" = {
        source = ./configs/claude/hooks/gh-guard.py;
        executable = true;
      };
      ".codex/hooks/jira-guard.py" = {
        source = ./configs/claude/hooks/jira-guard.py;
        executable = true;
      };
      ".codex/hooks/pr-body-guard.py" = {
        source = ./configs/claude/hooks/pr-body-guard.py;
        executable = true;
      };
      ".codex/hooks/file-edit-guard.py" = {
        source = ./configs/claude/hooks/file-edit-guard.py;
        executable = true;
      };
      ".codex/hooks/agent-tooling-guard.py" = {
        source = ./configs/claude/hooks/agent-tooling-guard.py;
        executable = true;
      };
      ".codex/hooks/prompt-authoring-guard.py" = {
        source = ./configs/claude/hooks/prompt-authoring-guard.py;
        executable = true;
      };
      ".codex/hooks/claude-dir-edit-guard.py" = {
        source = ./configs/claude/hooks/claude-dir-edit-guard.py;
        executable = true;
      };
      ".codex/hooks/rebuild-enforcer.py" = {
        source = ./configs/claude/hooks/rebuild-enforcer.py;
        executable = true;
      };
      ".codex/hooks/missing-tool-hint.py" = {
        source = ./configs/claude/hooks/missing-tool-hint.py;
        executable = true;
      };
      ".codex/hooks/output-shape-reminder.py" = {
        source = ./configs/claude/hooks/output-shape-reminder.py;
        executable = true;
      };
      # The three-day transcript audit behind file-edit-guard.py counted 414
      # throwaway python3 file edits at a 2.45s median against 88 Edit calls at
      # a 0.11s median. Where the work genuinely has to stay in the shell, this
      # gives it an edit primitive with the safety properties of the Edit tool
      # -- exactly one match or a loud refusal, an atomic write, and a diff of
      # what changed -- computed locally, with no model call, no network, and
      # no file contents leaving the machine.
      ".local/bin/fast-apply" = {
        source = ./configs/bin/fast-apply;
        executable = true;
      };
      # Checks hand-synced copies across repos that deliberately share no package.
      ".local/bin/copy-sync-check" = {
        source = ./configs/bin/copy-sync-check;
        executable = true;
      };
      ".local/bin/rex-project-theme" = {
        source = ./configs/bin/rex-project-theme;
        executable = true;
      };
      # Agent descriptions always load into the system prompt -- there is no
      # hidden-but-spawnable mode -- so only agents that actually get spawned
      # are deployed here. The 12 vendored im-not-ai humanize workers were
      # dropped in 2026-09: 0 spawns and 0 humanize skill invocations across
      # 437 recorded sessions, at ~360 tokens of every session's first request.
      ".claude/agents".source = ./configs/claude/agents;
      # The owner's style rubric as one text for grader and implementer:
      # code-reviewer reads it at this path, and hetero-subagents copies it into
      # every Codex implementer's developer instructions. It sits outside
      # agents/ because every .md there is read as an agent definition.
      ".claude/shared/style-rules.md".source = ./configs/claude/shared/style-rules.md;
      # The agent-agnostic rules alone, without the Claude-only appendix: codex
      # runs in an isolated CODEX_HOME where ~/.codex/AGENTS.md never loads, so
      # hetero-subagents copies this into every implementer's instructions.
      ".claude/shared/agent-rules.md".source = sharedAgentRules;
      # One explicit entry per style, never directory recursion: every file here
      # shows up in the /config picker, and settings.json's "outputStyle" names
      # the one whose body goes resident.
      ".claude/output-styles/concise-adhd-korean.md".source = claudeOutputStyle;
      ".pi/agent/vendor/choco-pi".source = piVendor;
      ".gnupg/gpg-agent.conf".source = ./configs/gnupg/gpg-agent.conf;
    }
    skillFiles
  ];

  # opencode's shared config; its rea MCP server resolves `rea` from the mise
  # shims on PATH.
  xdg.configFile."opencode/opencode.jsonc".source = ./configs/opencode/opencode.jsonc;
  xdg.configFile."rex/init.lua".source = ./configs/rex/init.lua;

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
    priv="$HOME/.claude-personal/settings.private.json"
    run mkdir -p "$HOME/.claude"
    run rm -f "$out"
    run install -m 0644 ${./configs/claude/settings.json} "$out"
    # This repo is public, so employer-internal names (plugin ids, marketplace
    # ids) stay out of it and live in the private overlay instead. Recursive
    # merge, overlay wins, so it adds keys without restating the repo's.
    if [ -f "$priv" ]; then
      run sh -c '${pkgs.jq}/bin/jq -s ".[0] * .[1]" "$0" "$1" > "$0.merged" && mv "$0.merged" "$0"' "$out" "$priv"
    fi
    # Same public-repo rationale for patches that can't be expressed as settings
    # keys: this repo stays generic and the host-private script names the
    # internal plugins it touches. Optional -- absent on hosts that need none.
    # Activation runs with a bare PATH that carries no python3 or jq, so the
    # interpreters the script may need are handed to it explicitly rather than
    # left for it to find (`python3: command not found`, 2026-09-01).
    if [ -x "$HOME/.claude-personal/post-activate.sh" ]; then
      run env PATH="${pkgs.python3}/bin:${pkgs.jq}/bin:$PATH" \
        "$HOME/.claude-personal/post-activate.sh"
    fi
  '';

  # claude comes from mise's aqua backend (mise-global.toml), so an npm-global
  # copy under node/<ver>/lib/node_modules is always undeclared -- and harmful,
  # because mise orders node/<ver>/bin ahead of mise/shims and the copy wins the
  # bare name. DISABLE_AUTOUPDATER (zsh .zshenv, nushell env, ~/.local/bin/claude)
  # stops anything from writing one; this sweep clears what a stray `npm i -g` or
  # a pre-fix process already left, on every rebuild.
  home.activation.pruneNpmGlobalClaude = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    for pkgdir in "$HOME"/.local/share/mise/installs/node/*/lib/node_modules/@anthropic-ai/claude-code; do
      [ -e "$pkgdir" ] || continue
      nodedir="''${pkgdir%/lib/node_modules/@anthropic-ai/claude-code}"
      run rm -rf "$pkgdir"
      if [ -L "$nodedir/bin/claude" ]; then
        run rm -f "$nodedir/bin/claude"
      fi
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
    run install -m 0644 ${codexConfig} "$out"
    if [ -f "$localTrust" ]; then
      {
        echo ""
        ${pkgs.gawk}/bin/awk '/^\[/ { keep = ($0 ~ /^\[projects\./ || $0 ~ /^\[mcp_servers\./) } keep' "$localTrust"
      } >> "$out"
    fi
  '';

  # Pi rewrites ~/.pi/agent/settings.json in place at runtime, so it is neither
  # a read-only link nor a full overwrite: keep every key Pi wrote and put the
  # repo keys on top (shallow merge, repo wins), the same as install.nu does on
  # Windows. The merged file is written beside the live one and moved over it,
  # so a failed merge leaves the live file untouched.
  home.activation.piSettings = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    piDir="$HOME/.pi/agent"
    out="$piDir/settings.json"
    repo=${./configs/pi/settings.json}
    run mkdir -p "$piDir"
    live="$out"
    [ -f "$live" ] || live=${pkgs.writeText "pi-settings-empty.json" "{}"}
    if ! run sh -c '${pkgs.jq}/bin/jq -s ".[0] + .[1]" "$1" "$2" > "$0.merged" && chmod 0644 "$0.merged" && mv "$0.merged" "$0"' "$out" "$live" "$repo"; then
      echo "piSettings: jq merge of $live (live) with $repo (repo) into $out failed; see the jq error above. $out is unchanged." >&2
      rm -f "$out.merged"
      exit 1
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
          // lib.optionalAttrs pkgs.stdenv.hostPlatform.isDarwin {
            colima = "0.10.3";
            lima = "2.1.4";
            docker-cli = "29.6.0";
          };
      };
  };
}
