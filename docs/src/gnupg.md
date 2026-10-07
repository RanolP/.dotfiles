# GnuPG

GPG toolchain for commit signing.

**Managed by:** `nix/home/default.nix`, `nix/home/darwin/default.nix`, and `nix/home/linux/default.nix`

## Packages

| Package | Purpose |
|---------|---------|
| gnupg | Core GPG toolchain |
| pinentry_mac | Passphrase dialog on macOS |
| pinentry-tty | TTY pinentry on macOS |
| pinentry-curses | Pinentry on Linux |

## gpg-agent.conf

`nix/home/configs/gnupg/gpg-agent.conf` is linked by Home Manager. The gpg-agent restarts automatically (`gpgconf --kill gpg-agent`) when the file changes.

The signing key used for git commits is `BB9C29B5FA1C8305` — see [Git](./git.md).
