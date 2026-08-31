{ pkgs, lib, ... }:
{
  programs.firefox = {
    enable = true;
    # The app itself comes from the `firefox@developer-edition` Homebrew cask, so it
    # lands in /Applications and self-updates. Home Manager manages only the profile.
    package = null;
    profiles.dev-edition-default = {
      id = 0;
      isDefault = true;
      extensions.packages =
        let
          addons = pkgs.nur.repos.rycee.firefox-addons;
        in
        [
          addons.bitwarden
          addons.ublock-origin
          addons.darkreader
          addons.tampermonkey
          # These five are not in nur.repos.rycee.firefox-addons, so they are
          # pinned by hand. Each `url` names an immutable AMO file id, NOT the
          # `/downloads/latest/<slug>/latest.xpi` alias: that alias moves the
          # moment the author publishes, so the pinned hash stops matching the
          # bytes and every rebuild on every host dies with a fixed-output hash
          # mismatch. It happened on 2026-08-31, when simple-translate went
          # 3.0.1 -> 3.1.0 and the build stopped at
          # `specified: sha256-+EQulzy6XzQA/Tr4dBuGkqmLSGJArZ63AUuEYgaTyZY=`.
          #
          # To bump one: read `.current_version` from
          # https://addons.mozilla.org/api/v5/addons/addon/<slug>/ and copy its
          # `version`, `file.url`, and `file.hash` (hex -> SRI via
          # `nix hash convert --hash-algo sha256 --to sri <hex>`).
          (addons.buildFirefoxXpiAddon {
            pname = "react-devtools";
            version = "6.1.1";
            addonId = "@react-devtools";
            url = "https://addons.mozilla.org/firefox/downloads/file/4432990/react_devtools-6.1.1.xpi";
            sha256 = "sha256-staeIgQCvWuLx9gzlIkVsdbcq7RTodUIcqPbhg/ZLEY=";
            meta = { };
          })
          (addons.buildFirefoxXpiAddon {
            pname = "kagi-search";
            version = "0.7.6";
            addonId = "search@kagi.com";
            url = "https://addons.mozilla.org/firefox/downloads/file/4429158/kagi_search_for_firefox-0.7.6.xpi";
            sha256 = "sha256-UcrA8vV+PXZx1QLfZqYBmo7TooDmkCSfCdzaD7VwmQ8=";
            meta = { };
          })
          (addons.buildFirefoxXpiAddon {
            pname = "maxfocus";
            version = "0.5.8";
            addonId = "{4bda55a4-25fc-4958-aca3-4b3261605398}";
            url = "https://addons.mozilla.org/firefox/downloads/file/4463963/maxfocus_link_preview-0.5.8.xpi";
            sha256 = "sha256-cE2H29CYdIz54Ar6Ny1htThmyNrbDA0U8pOhz5eFMNI=";
            meta = { };
          })
          (addons.buildFirefoxXpiAddon {
            pname = "simple-translate";
            version = "3.1.0";
            addonId = "simple-translate@sienori";
            url = "https://addons.mozilla.org/firefox/downloads/file/4979122/simple_translate-3.1.0.xpi";
            sha256 = "sha256-wnWR6uc2P7BjXyEnesTgvFcJ5s/ymdM77E3oEGwpiVE=";
            meta = { };
          })
          (addons.buildFirefoxXpiAddon {
            pname = "multi-account-containers";
            version = "8.3.8";
            addonId = "@testpilot-containers";
            url = "https://addons.mozilla.org/firefox/downloads/file/4867303/multi_account_containers-8.3.8.xpi";
            sha256 = "sha256-MGopSEU2PxWnR46WILQ/keoXYQiHJ4COIye//xbBREc=";
            meta = { };
          })
        ];
    };
  };

  # Keep exactly one Firefox reachable: the Homebrew /Applications build.
  #
  # `package = null` stopped Home Manager from installing new nix Firefoxes, but
  # the ones it installed before are still in the nix store and still registered
  # with LaunchServices under `org.nixos.firefoxdeveloperedition`. That is how
  # two copies ended up running at once, and how the https handler stayed
  # pointed at a nix-store app. So: unregister every nix-store Firefox first,
  # then claim the handler.
  #
  # macOS refuses a third-party setter for https -- `duti -s
  # org.mozilla.firefoxdeveloperedition https` fails with error -54 (permErr) --
  # so the browser itself has to ask, via Firefox's own `-setDefaultBrowser`.
  home.activation.firefoxDefaultBrowser = lib.hm.dag.entryAfter [ "writeBoundary" ] ''
    ffBin="/Applications/Firefox Developer Edition.app/Contents/MacOS/firefox"
    lsregister=/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister

    for app in /nix/store/*-firefox*/Applications/*.app; do
      [ -d "$app" ] || continue
      echo "unregistering stale Firefox copy: $app"
      $DRY_RUN_CMD "$lsregister" -u "$app" || true
    done

    current="$(/usr/bin/defaults read com.apple.LaunchServices/com.apple.launchservices.secure 2>/dev/null \
      | /usr/bin/grep -B4 'LSHandlerURLScheme = https;' \
      | /usr/bin/sed -n 's/.*LSHandlerRoleAll = "\(.*\)";/\1/p' | /usr/bin/tail -1)"
    [ -n "$current" ] || current=none
    if [ "$current" != "org.mozilla.firefoxdeveloperedition" ]; then
      if [ -x "$ffBin" ]; then
        echo "default browser: $current -> org.mozilla.firefoxdeveloperedition"
        $DRY_RUN_CMD "$ffBin" -setDefaultBrowser
      else
        echo "default browser: left at $current; $ffBin is missing (brew cask firefox@developer-edition)" >&2
      fi
    fi
  '';

}
