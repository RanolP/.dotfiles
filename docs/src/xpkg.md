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
| `[wsl.<distro>]` | a `wsl --list --online` distro name and its `user` | `wsl --install <distro> --no-launch`, then first-boot setup |

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

A distro that already exists is skipped entirely, so the first-boot script never re-runs on it. Inside the distro, the `ranolp-archwsl` home-manager config takes over.
