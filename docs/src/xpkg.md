# xpkg

The Windows counterpart to nix: one command installs every declared package, font and config on a Windows machine.

**Managed by:** `xpkg/install.nu`, run through the `rebuild` alias.

## `rebuild` is the apply command on every host

Every host has a `rebuild` shell alias that runs that host's apply command. When the user says "I ran rebuild", that command ran.

| Host | `rebuild` runs | Declared in |
| --- | --- | --- |
| Windows (nushell) | `nu ~/.dotfiles/xpkg/install.nu` | `xpkg/configs/nushell/config.nu` |
| macOS | `sudo darwin-rebuild switch --flake ~/.dotfiles/nix#ranolp-work-MBP-26` | `nix/home/darwin/default.nix` |
| Arch Linux on WSL | `home-manager switch --flake ~/.dotfiles/nix#ranolp-archwsl -b before-hm` | `nix/home/linux/default.nix` |

## How an agent installs something on Windows

The user asks for "install X" or "upgrade X". The agent's whole job is the declaration:

1. Add X to `xpkg/windows/default.toml` in the section that fits (table below).
2. If the installer code cannot express it yet, extend `xpkg/windows/install.nu`.
3. Verify without installing: `nu-check --debug xpkg/windows/install.nu` prints `true`, and `open xpkg/windows/default.toml | get <section>` shows the new entry.
4. Commit on `main` and hand over `rebuild`.

The user downloads and installs X by running `rebuild`. The agent never runs `winget install`, `wsl --install`, or a function from `install.nu` itself, even when the user said "install". On 2026-11-13 an agent ran `wsl --install archlinux` and a Build Tools install by hand instead of declaring them, and the user had to stop it.

## What `rebuild` does on Windows

`xpkg/install.nu` relaunches itself elevated through gsudo once when it is not admin; every later step inherits that elevation. It then runs its units concurrently wherever one does not need another's result:

1. **Settings, in the background** -- `xpkg/configs/install.nu --system` starts as a background job and runs the units that only write the registry or powercfg, all at the same time: keyboard, lock, explorer, theme, chrome, audio, littlebigmouse, bin.
2. **Packages, in the foreground** -- `xpkg/windows/install.nu` applies `xpkg/windows/default.toml` while the settings run. It keeps the terminal because the WSL `passwd` prompt needs it; each winget or direct install prints its result line when it finishes. A Packages failure is recorded rather than aborting, so the settings output still prints and `rebuild` exits non-zero at the end.
3. **Refresh `PATH`** from the registry, so tools a package just installed are found by the later steps.
4. **Settings output** -- the captured output of step 1 prints under `== Settings`.
5. **Configs and Fonts** -- `xpkg/configs/install.nu --rebuild` renders the nushell and mise configs from the shared `nix/home/configs` sources and runs `mise install`, one after the other. Then it runs every remaining unit at the same time: gitconfig, gnupg, espanso, firefox, terminal, prismlauncher, vscode, claude, codex, opencode, pi, and Fonts (`xpkg/apps/@fonts/install.nu`, which downloads every font in `fonts.toml` and installs it for the current user). vscode, claude, codex, pi and opencode run only when that tool is installed.

gitconfig stays one unit, because concurrent `git config` writers collide on `.gitconfig.lock`. prismlauncher needs the JDK, pi needs pnpm, and Fonts needs uv on a cache miss; all three come from `mise install`, which is why that step finishes first.

Each unit is a `nu <script>` child whose stdout and stderr are captured together (`xpkg/utils/parallel.nu`). When a unit finishes, one block prints: `ok <name>  1.2s` in green or `!! <name>  exit N` in red, then the unit's output indented 6 spaces. Blocks appear in finishing order and never interleave. Colours the unit script prints itself survive the capture; an external tool it runs sees a pipe instead of a terminal and may print without colour. The last line is `== rebuild done in <N>s`, the wall time of the elevated run. When Packages, Settings or Configs and Fonts failed, a red `!! failed: <groups>` line follows it and `rebuild` exits 1.

Run on its own, `xpkg/configs/install.nu` relaunches itself elevated when needed and applies every config, the settings units included, in one parallel group after `mise install`. It does not install fonts.

Inside Packages, winget and msiexec installs stay serial, because Windows Installer allows one MSI install at a time. An install that exits with 0x8A150102 (winget) or 1618 (msiexec), both meaning another install is running, is retried up to 10 times, 15 s apart. `[direct.*]` installers download in parallel, then install one at a time.

## `xpkg/windows/default.toml`

The packages step reads `winget list` once, skips everything already installed, installs the rest, and never uninstalls anything except ids listed in `remove`.

| Section | Holds | Installed with |
| --- | --- | --- |
| `[winget] packages` | winget ids for every Windows machine | `winget install -eh --id <id>` |
| `[profiles.<hostname>] packages` | winget ids for one machine only | same |
| `[winget.override]` | `"<id>" = "<installer args>"` for an id whose default install is not what is wanted | `winget install ... --override "<args>"` |
| `skip_dependencies` | ids installed with `--skip-dependencies` | |
| `remove` | ids to uninstall when present | `winget uninstall` |
| `[direct."<name>"]` | software not on winget: `url`, silent `args`, optional zip `member`; `<name>` is the start of its installed DisplayName | download, then run the installer or `msiexec` |
| `[wsl.<distro>]` | a `wsl --list --online` distro name and its `user`; optional `sparse = true`, `home-manager = true` | `wsl --install <distro> --no-launch`, then first-boot setup; `sparse` runs `wsl --manage <distro> --set-sparse true --allow-unsafe` on an existing distro; `home-manager` runs `xpkg/setup-scripts/linux/arch.sh` in the distro on every rebuild |

A winget package installed but not declared is reported as a warning only.

### Overrides apply on first install only

An installed package is skipped, so changing its `[winget.override]` line does nothing on a machine that already has it. Change the installed components by hand (for Visual Studio, the Visual Studio Installer's Modify), or uninstall it and run `rebuild`.

`Microsoft.VisualStudio.BuildTools` is the current override. Its bare install has no compiler, so the override adds the C++ build tools workload, MSVC x64/x86 and the Windows 11 SDK 10.0.26100.

### WSL distros

For each `[wsl.<distro>]` missing from `wsl -l -q`, while the registry key `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending` exists, the distro is skipped with a "reboot, then rebuild" notice. Otherwise:

1. `wsl --install <distro> --no-launch`.
2. If the distro still does not exist, the machine lacked the Virtual Machine Platform feature: `wsl --install` only turned it on and exited 0. `rebuild` prints `reboot Windows, then run rebuild again` and stops for that distro.
3. `xpkg/windows/wsl-first-boot.sh` runs as root: it initialises the pacman keyring, installs sudo, creates `user` in `wheel`, and writes `/etc/wsl.conf` with systemd on and `user` as the default.
4. `passwd <user>` asks the user for a password in the terminal.
5. `wsl --terminate <distro>` so `wsl.conf` takes effect.

A distro that already exists is skipped, so the first-boot script never re-runs on it, except for `sparse = true`: when `fsutil sparse queryflag` on `<BasePath>\ext4.vhdx` (`BasePath` from the distro's `HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss` key) says the file is not sparse, `rebuild` runs `wsl --terminate <distro>` then `wsl --manage <distro> --set-sparse true --allow-unsafe` and prints a `!!` line on failure. `--allow-unsafe` is required because Microsoft disabled sparse VHD in WSL 2.7 citing potential data corruption, so the key is opt-in. An already-sparse distro prints `==`.

With `home-manager = true`, every `rebuild` (on an existing distro, and right after a successful first boot) pipes `xpkg/setup-scripts/linux/arch.sh` into the distro twice: `wsl -d <distro> -u root -- bash -s -- system`, then `wsl -d <distro> -- bash -s -- home` as the default user. The `system` phase runs `pacman -S --needed git nix`, enables `nix-daemon.socket` (systemd must be on, which the first-boot `wsl.conf` does), writes `experimental-features = nix-command flakes` into `/etc/nix/nix.conf` and runs `systemctl try-restart nix-daemon.service` only when that line changed, then creates `/nix/store` with `nix store info` if missing: the Arch `nix` package does not create it, and a user `nix run` fails with `error: opening file "/nix/store": No such file or directory` until it exists. The `home` phase clones `https://github.com/RanolP/.dotfiles.git` to `~/.dotfiles` only when that path is missing, never touching an existing checkout, then runs `nix run home-manager/master -- switch --flake ~/.dotfiles/nix#ranolp-archwsl -b before-hm`. Each step prints `==` (already done) or `++` (changed); `rebuild` relays those lines and, on a non-zero exit, prints a `!!` line with the last three output lines. After that, `rebuild` inside the distro is `home-manager switch` directly.

The script also runs standalone on any Arch machine, as the normal user: `bash xpkg/setup-scripts/linux/arch.sh` with no argument runs the `system` phase through `sudo` and then the `home` phase. `system` or `home` as the argument runs that phase alone.

### First install: the `setup` entry

The root `setup` file, served at `https://dotfiles.ranolp.dev/setup`, is one file that is valid POSIX sh, cmd batch and PowerShell at once, so the same URL bootstraps from any of the three shells:

- sh (Arch Linux, or Git Bash on Windows): `curl -fsSL https://dotfiles.ranolp.dev/setup | sh`
- PowerShell: `irm https://dotfiles.ranolp.dev/setup | iex`
- cmd: `curl -fsSL https://dotfiles.ranolp.dev/setup -o %TEMP%\setup.cmd && %TEMP%\setup.cmd`

Each shell reads past the other two branches: sh sees line 1 as an `echo` to `/dev/null` and exits on line 3, cmd sees lines 2 and 3 as labels and stops at `@exit /b`, and PowerShell sees lines 1 to 6 as a here-string piped to `Out-Null`. Under cmd the first line echoes `echo @'` and `@'` before anything runs; that noise is harmless. The file stays LF: cmd runs it correctly with LF line endings, while CRLF would break the sh branch.

The sh branch runs `xpkg/setup-scripts/sh.sh`, which pipes `linux/arch.sh` into `bash` on Arch (detected from `/etc/os-release`), hands Git Bash (`uname -s` starting `MINGW` or `MSYS`) to the PowerShell script below, and exits 1 on anything else. The cmd and PowerShell branches both run `xpkg/setup-scripts/windows.ps1` (Windows PowerShell 5.1 compatible), which installs `Git.Git` and `Nushell.Nushell` through winget only when `winget list --exact --id <id>` reports them absent, reloads `Path` from the registry, clones `https://github.com/RanolP/.dotfiles.git` to `~\.dotfiles` only when that path is missing (an existing checkout is never touched), then runs `nu ~\.dotfiles\xpkg\install.nu`, the same entry as `rebuild`. Each step prints `==`, `++` or `!!` like `arch.sh`; a failed step throws rather than calling `exit`, so `irm | iex` does not close the caller's window.
