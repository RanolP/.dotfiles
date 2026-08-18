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
          (addons.buildFirefoxXpiAddon {
            pname = "react-devtools";
            version = "6.1.1";
            addonId = "@react-devtools";
            url = "https://addons.mozilla.org/firefox/downloads/latest/react-devtools/latest.xpi";
            sha256 = "0iicv47qdnx3f84db8aknjmxrmmi2n4r8cyqqy5npg820hi9xmmj";
            meta = { };
          })
          (addons.buildFirefoxXpiAddon {
            pname = "kagi-search";
            version = "0.7.6";
            addonId = "search@kagi.com";
            url = "https://addons.mozilla.org/firefox/downloads/latest/kagi-search-for-firefox/latest.xpi";
            sha256 = "03wrf2shznnw16gj9476h2id73ls06k6dpq2smqpcgbyyprc1jji";
            meta = { };
          })
          (addons.buildFirefoxXpiAddon {
            pname = "maxfocus";
            version = "1";
            addonId = "{4bda55a4-25fc-4958-aca3-4b3261605398}";
            url = "https://addons.mozilla.org/firefox/downloads/latest/maxfocus-link-preview/latest.xpi";
            sha256 = "1lihhnbwz8cky8a0s36vvb46cf5mc4nkgyhaw3wqqx4qs3dqfkbh";
            meta = { };
          })
          (addons.buildFirefoxXpiAddon {
            pname = "simple-translate";
            version = "3.0.1";
            addonId = "simple-translate@sienori";
            url = "https://addons.mozilla.org/firefox/downloads/latest/simple-translate/latest.xpi";
            sha256 = "15n9jc36512b06vrxba0c948pacjhqdp9y1szl038pxs7jbjwi7q";
            meta = { };
          })
          (addons.buildFirefoxXpiAddon {
            pname = "multi-account-containers";
            version = "8.3.8";
            addonId = "@testpilot-containers";
            url = "https://addons.mozilla.org/firefox/downloads/latest/multi-account-containers/latest.xpi";
            sha256 = "0is4q4bgzgr74f7809w711higsli7ys215lf8ykiagrn8m42jsih";
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
