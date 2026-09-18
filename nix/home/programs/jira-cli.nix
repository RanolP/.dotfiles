{ pkgs, ... }:
let
  # The entry script, its `jira_cli/` package, the vendored ADF schema, and the
  # self-check fixture ship as one store directory: `uv run --script` puts the
  # script's directory on sys.path, and the package resolves the schema and the
  # fixture from realpath(__file__), so linking the files separately would
  # scatter them across several paths.
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
