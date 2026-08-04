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
      # Workaround for a fortify false positive that kills nixpkgs git on macOS.
      # git's `dirent_prec_psx.d_name` is `char[NAME_MAX+1]` used as a flexible
      # array: precompose_utf8_readdir() xreallocs the struct for a longer name,
      # raises max_name_len past 256, then calls strlcpy() with that bound. The
      # heap block is big enough, but the compiler still sees a 256-byte field,
      # so the fortified build traps in __strlcpy_chk (SIGTRAP, exit 133).
      # nixpkgs builds git with -D_FORTIFY_SOURCE; Apple's /usr/bin/git does not,
      # which is why only the nix binary dies on the same directory.
      # Reached only when readdir returns a name whose NFD form is >255 bytes
      # (on APFS: non-ASCII, e.g. 43+ Korean syllables) AND the iconv branch is
      # skipped. Forcing precomposition on keeps that branch alive for repos
      # whose own config never got the setting. Drop this once git declares
      # d_name FLEX_ARRAY. Does not cover names with invalid UTF-8.
      core.precomposeunicode = true;
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
