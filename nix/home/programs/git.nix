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
      # Apple's CLT helper, not nix's: nix/brew builds are ad-hoc signed, so their
      # designated requirement is a bare cdhash that rotates on every rebuild and
      # invalidates the "always allow" Keychain ACL. Apple's DR is
      # `identifier "com.apple.git-credential-osxkeychain" and anchor apple` --
      # no cdhash, so the grant survives updates.
      # The leading "" resets the helper list: nix git's own etc/gitconfig sets
      # `helper = osxkeychain`, which would otherwise run first.
      # Absolute path also covers nix-homebrew, which runs brew with a scrubbed
      # PATH and a helper-less git-minimal.
      credential.helper = [
        ""
        "/Library/Developer/CommandLineTools/usr/libexec/git-core/git-credential-osxkeychain"
      ];
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
