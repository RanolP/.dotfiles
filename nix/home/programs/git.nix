{ ... }:
{
  programs.git = {
    enable = true;
    signing.format = null;
    settings = {
      user.name = "RanolP";
      user.email = "me@ranolp.dev";
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
