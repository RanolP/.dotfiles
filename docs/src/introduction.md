# Introduction

macOS dotfiles managed with [nix-darwin](https://github.com/LnL7/nix-darwin) + [home-manager](https://github.com/nix-community/home-manager). GUI apps via Homebrew casks, CLI tools via [mise](https://mise.jdx.dev/).

## Applying

```sh
sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26
```

Or with the shell alias:

```sh
rebuild
```
