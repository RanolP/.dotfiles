# GnuPG

GPG toolchain for commit signing.

**Managed by:** `nix/home/default.nix` (packages + home.file)

## Packages

| Package | Purpose |
|---------|---------|
| gnupg | Core GPG toolchain |
| pinentry_mac | Passphrase dialog (macOS native) |
| pinentry-tty | Passphrase prompt (TTY fallback) |

## gpg-agent.conf

Managed via `home.file` at `~/.gnupg/gpg-agent.conf`. The gpg-agent is restarted automatically (`gpgconf --kill gpg-agent`) whenever the file changes.

The signing key used for git commits is `BB9C29B5FA1C8305` — see [Git](./git.md).
