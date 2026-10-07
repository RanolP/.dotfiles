# Firefox

Firefox Developer Edition browser.

**Managed by:** the `firefox@developer-edition` Homebrew cask in `nix/darwin/default.nix` installs the app; `nix/home/darwin/programs/firefox.nix` declares the default profile and add-ons.

## What firefox.nix does

Home Manager's `programs.firefox` module manages the profile, not the app: `package = null` leaves installation to the Homebrew cask.

The activation script unregisters stale nix-store Firefox copies and asks the Homebrew app to become the default HTTPS handler with Firefox's `-setDefaultBrowser` option.

The profile gets Bitwarden, uBlock Origin, Dark Reader, and Tampermonkey from NUR. It also pins `react-devtools`, `kagi-search`, `maxfocus`, `simple-translate`, and `multi-account-containers` to immutable AMO file URLs and hashes in `nix/home/darwin/programs/firefox.nix`.

## Why Firefox Developer Edition

We use [Firefox Developer Edition](https://www.firefox.com/channel/desktop/developer). Here is why.

- We reject Chromium-based browsers to help against browser-engine monopoly. <br />
  Rejected: Google Chrome, Microsoft Edge, Ungoogled Chromium, Arc from The Browser Company, Dia from The Browser Company, Opera, Vivaldi, Naver Whale
- Browser extensions must be free to use. In particular, uBlock Origin must be usable.
- We reject Safari. <br />
  Rejected: Apple Safari
- We don't obsess over anonymity beyond what's needed. <br />
  Rejected: Tor Browser
- We need confidence that the browser will keep being maintained. <br />
  Rejected: LibreWolf
- DRM playback must work, for services like Laftel and Netflix. <br />
  Rejected: Zen Browser, Pale Moon
- The browser must embrace diversity. <br />
  Rejected: Brave [[2014 Apr]](https://mashable.com/archive/mozilla-interim-ceo)

### Alternatives considered

Opera Neon, Zen, Arc, Dia: interesting new-style browsers, but judged too risky to use as a daily driver.

## Other platforms

Windows installs the `Mozilla.Firefox.DeveloperEdition` winget package declared in `xpkg/windows/default.toml`. WSL skips Firefox entirely.
