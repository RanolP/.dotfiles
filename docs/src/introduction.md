# Introduction

macOS dotfiles managed with [nix-darwin](https://github.com/LnL7/nix-darwin) and [home-manager](https://github.com/nix-community/home-manager). Homebrew provides GUI apps; CLI tools are declared across Nix and [mise](https://mise.jdx.dev/).

## Applying

```sh
sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26
```

Or with the shell alias:

```sh
rebuild
```

## Secrets

Copy `nix/home/local.nix.example` to `nix/home/local.nix` and fill in private values (GPG signing key); `local.nix` is gitignored.
