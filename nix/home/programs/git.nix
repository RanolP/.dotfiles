{ ... }:
{
  programs.git = {
    enable = true;
    # Global excludes (core.excludesFile) -- ignored in every repo.
    ignores = [
      ".nanno-workers.json"
      ".slopless/"
    ];
    signing.format = null;
    settings = {
      user.name = "RanolP";
      user.email = "me@ranolp.dev";
      # Absolute path: nix-homebrew runs brew with a scrubbed PATH and a
      # helper-less git-minimal, so a bare "osxkeychain" never resolves there.
      credential.helper = "/etc/profiles/per-user/ranolp/bin/git-credential-osxkeychain";
      init.defaultBranch = "main";
      push.autoSetupRemote = true;
      pull.rebase = true;
      merge.conflictstyle = "zdiff3";
      rerere.enabled = true;
      commit.gpgSign = true;
      user.signingKey = "BB9C29B5FA1C8305";
      core.pager = "delta";
      interactive.diffFilter = "delta --color-only";
      delta.navigate = true;
      delta.side-by-side = false;
      diff.colorMoved = "default";
      diff.algorithm = "histogram";
    };
  };
}
