# VS Code

**Managed by:** `nix/home/darwin/programs/vscode.nix` via `programs.vscode` (home-manager)

`mutableExtensionsDir = false` — extensions are fully declarative; manually installed extensions are removed on rebuild.

## Extensions

| Extension | Purpose |
|-----------|---------|
| dbaeumer.vscode-eslint | ESLint integration |
| esbenp.prettier-vscode | Prettier formatter |
| arcticicestudio.nord-visual-studio-code | Nord color theme |
| vscode-icons-team.vscode-icons | File icon theme |
| eamodio.gitlens | Git history / blame |
| github.copilot | AI completions |
| github.copilot-chat | AI chat |
| github.vscode-pull-request-github | GitHub pull requests |
| thenuprojectcontributors.vscode-nushell-lang | Nushell language support |
| shd101wyy.markdown-preview-enhanced 0.8.25 | Enhanced markdown preview |

## Undeclared Extensions (installed manually)

These are present but not yet declared in nix — they get wiped on rebuild:
- `anthropic.claude-code`
- `mermaidchart.vscode-mermaid-chart`
- `terrastruct.d2`
- `tintinweb.graphviz-interactive-preview`

## Settings

| Setting | Value |
|---------|-------|
| editor.fontFamily | Iosevka Nerd Font Mono, Pretendard |
| editor.fontSize | 14 |
| editor.fontLigatures | true |
| editor.formatOnSave | true |
| editor.minimap.enabled | true |
| workbench.colorTheme | Nord |
| workbench.iconTheme | vscode-icons |
| update.mode | none |
| extensions.autoUpdate | off |
| extensions.autoCheckUpdates | false |
| files.autoSave | onFocusChange |
| diffEditor.hideUnchangedRegions.enabled | true |
| scm.defaultViewMode | tree |
| terminal.integrated.defaultProfile.osx | nu |
| terminal.integrated.profiles.osx.nu.path | Home Manager profile's `nu` executable |
| git.autofetch | all, every 60 seconds |

## Keybinds

| Binding | Action |
|---------|--------|
| Cmd+D | Split focused terminal |
| Cmd+Shift+D | Split focused terminal |
