{ pkgs, ... }:
let
  # The script, its vendored ADF schema, and its self-check fixture ship as one
  # store directory: jira.py resolves both siblings from realpath(__file__), so
  # linking the three files separately would scatter them across three paths.
  src = ../configs/jira-cli;

  # uv comes from mise (nix/home/mise-global.toml), not from nixpkgs, so it is
  # resolved off the caller's PATH rather than baked in.
  jira = pkgs.writeShellScriptBin "jira" ''
    if ! command -v uv > /dev/null 2>&1; then
      echo "jira needs uv on PATH — mise installs it: mise install uv" >&2
      exit 1
    fi
    exec uv run --script ${src}/jira.py "$@"
  '';
in
{
  home.packages = [ jira ];
}
