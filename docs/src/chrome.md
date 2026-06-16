# Chrome

Google Chrome browser.

**Managed by:** Homebrew cask

## Enterprise Policy: Bitwarden Extension

Bitwarden is force-installed via managed Chrome policy so it's always present regardless of profile sync state.

Policy file: `/Library/Google/Chrome/policies/managed/extensions.json`

```json
{
  "ExtensionInstallForcelist": [
    "fcoeoabgfenejglbffodgkkbkcdhcgfn;https://clients2.google.com/service/update2/crx"
  ]
}
```

Written by the darwin activation script in `nix/darwin/default.nix`.
