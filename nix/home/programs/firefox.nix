{ pkgs, ... }:
{
  programs.firefox = {
    enable = true;
    package = pkgs.firefox-devedition;
    profiles.dev-edition-default = {
      id = 0;
      isDefault = true;
      extensions.packages = let
        addons = pkgs.nur.repos.rycee.firefox-addons;
      in [
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
          meta = {};
        })
        (addons.buildFirefoxXpiAddon {
          pname = "kagi-search";
          version = "0.7.6";
          addonId = "search@kagi.com";
          url = "https://addons.mozilla.org/firefox/downloads/latest/kagi-search-for-firefox/latest.xpi";
          sha256 = "03wrf2shznnw16gj9476h2id73ls06k6dpq2smqpcgbyyprc1jji";
          meta = {};
        })
        (addons.buildFirefoxXpiAddon {
          pname = "maxfocus";
          version = "1";
          addonId = "{4bda55a4-25fc-4958-aca3-4b3261605398}";
          url = "https://addons.mozilla.org/firefox/downloads/latest/maxfocus-link-preview/latest.xpi";
          sha256 = "1lihhnbwz8cky8a0s36vvb46cf5mc4nkgyhaw3wqqx4qs3dqfkbh";
          meta = {};
        })
        (addons.buildFirefoxXpiAddon {
          pname = "simple-translate";
          version = "3.0.1";
          addonId = "simple-translate@sienori";
          url = "https://addons.mozilla.org/firefox/downloads/latest/simple-translate/latest.xpi";
          sha256 = "15n9jc36512b06vrxba0c948pacjhqdp9y1szl038pxs7jbjwi7q";
          meta = {};
        })
        (addons.buildFirefoxXpiAddon {
          pname = "multi-account-containers";
          version = "8.3.7";
          addonId = "@testpilot-containers";
          url = "https://addons.mozilla.org/firefox/downloads/latest/multi-account-containers/latest.xpi";
          sha256 = "0rai82dlwfbqkydzwlhq9dw7zl3540xfbifjk4dkvlq6n7vmwvvz";
          meta = {};
        })
      ];
    };
  };
}
