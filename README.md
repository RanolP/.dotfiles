# .dotfiles

## Installation

### Windows CMD

Requirements:

- Windows CMD
- curl executable
- Winget executable (>= v1.6, follow instruction from [winget repository](https://github.com/microsoft/winget-cli#installing-the-client) if you don't have or have a lower version)

```cmd
curl -L dotfiles.ranolp.dev/setup | cmd /Q
:: or directly
curl -L dotfiles.ranolp.dev/setup-scripts/batch.bat | cmd /Q
```

### Windows PowerShell

Requirements:

- Windows PowerShell
- Winget executable (>= v1.6, follow instruction from [winget repository](https://github.com/microsoft/winget-cli#installing-the-client) if you don't have or have a lower version)

```powershell
curl dotfiles.ranolp.dev/setup | iex
# or directly
curl dotfiles.ranolp.dev/setup-scripts/powershell.ps1 | iex
```

### Windows ArchWSL

Requirements:

- ArchWSL Bash
- curl executable

```bash
curl -L dotfiles.ranolp.dev/setup | sh
# or directly
curl -L dotfiles.ranolp.dev/setup-scripts/bash.sh | sh
```

### macOS

Requirements:

- macOS zsh
- curl executable

```bash
curl -L dotfiles.ranolp.dev/setup | sh
# or directly
curl -L dotfiles.ranolp.dev/setup-scripts/bash.sh | sh
```


