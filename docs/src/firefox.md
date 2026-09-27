# Firefox

Firefox Developer Edition browser.

**Managed by:** the `firefox@developer-edition` Homebrew cask in `nix/darwin/default.nix` installs the app itself, so it lands in `/Applications` and self-updates through Homebrew.
The profile and addons are declared separately in `nix/home/darwin/programs/firefox.nix`.

## What firefox.nix does

Home Manager's `programs.firefox` module manages the profile, not the app: `package = null` stops it from installing its own nix-store Firefox, since the Homebrew cask already owns that job.

Because Home Manager used to install Firefox from the nix store before this switch, old copies stayed behind in the store and registered with macOS LaunchServices. An activation script unregisters every stale nix-store Firefox copy, then makes the Homebrew build the default HTTPS handler by invoking Firefox's own `-setDefaultBrowser` (macOS refuses a third-party `duti` setter for https).

The default profile pulls most addons (Bitwarden, uBlock Origin, Dark Reader, Tampermonkey) from `nur.repos.rycee.firefox-addons`. Five more (`react-devtools`, `kagi-search`, `maxfocus`, `simple-translate`, `multi-account-containers`) aren't in that NUR set, so they're pinned by hand to an immutable AMO file URL and hash rather than the moving `latest.xpi` alias, which breaks the build the moment the author publishes a new version.

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

Windows uses winget `Mozilla.Firefox.DeveloperEdition` (manual install, not managed in this repo). WSL skips Firefox entirely.
