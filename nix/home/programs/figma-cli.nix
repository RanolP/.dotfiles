{ pkgs, ... }:
let
  src = ../configs/figma-cli;

  # uv comes from mise (nix/home/mise-global.toml), not from nixpkgs, so it is
  # resolved off the caller's PATH rather than baked in.
  figma = pkgs.writeShellScriptBin "figma-cli" ''
    if ! command -v uv > /dev/null 2>&1; then
      echo "figma-cli needs uv on PATH — mise installs it: mise install uv" >&2
      exit 1
    fi
    exec uv run --script ${src}/figma.py "$@"
  '';
in
{
  home.packages = [ figma ];
}
