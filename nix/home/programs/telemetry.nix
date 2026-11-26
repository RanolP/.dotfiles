{ lib, ... }:
let
  # Per-tool telemetry opt-outs, set in every shell: zsh via home.sessionVariables,
  # nushell via environmentVariables (Home Manager's nushell module does not read
  # sessionVariables), and the /bin/sh login shell via ~/.profile.
  #
  # DO_NOT_TRACK and DISABLE_TELEMETRY stay unset on purpose: Claude Code 2.1.327
  # treats either one as "no-telemetry" and turns off its feature-flag
  # evaluation, which disables Remote Control and the remote model and
  # auto-mode config. Each tool below gets its own switch instead.
  vars = {
    HOMEBREW_NO_ANALYTICS = "1";
    GH_TELEMETRY = "false";
    LIGHTPANDA_DISABLE_TELEMETRY = "true";
    PI_TELEMETRY = "0";
    NEXT_TELEMETRY_DISABLED = "1";
    TURBO_TELEMETRY_DISABLED = "1";
    ASTRO_TELEMETRY_DISABLED = "1";
    STORYBOOK_DISABLE_TELEMETRY = "1";
    EXPO_NO_TELEMETRY = "1";
    WRANGLER_SEND_METRICS = "false";
    YARN_ENABLE_TELEMETRY = "0";
    HF_HUB_DISABLE_TELEMETRY = "1";
    STREAMLIT_BROWSER_GATHER_USAGE_STATS = "false";
  };
in
{
  home.sessionVariables = vars;
  programs.nushell.environmentVariables = vars;
  # mkBefore: the exports must precede .profile's `exec nushell` for Rex panes.
  home.file.".profile".text = lib.mkBefore (
    lib.concatLines (lib.mapAttrsToList (k: v: "export ${k}=${lib.escapeShellArg v}") vars)
  );
}
