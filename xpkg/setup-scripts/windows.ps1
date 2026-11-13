# First-install setup for Windows, reached from every branch of the root `setup`
# polyglot (PowerShell, cmd, Git Bash). Windows PowerShell 5.1 compatible.
#
#   irm https://dotfiles.ranolp.dev/xpkg/setup-scripts/windows.ps1 | iex
#
# Each step prints one status line: `==` already done, `++` changed, `!!` failed.
# A failure throws instead of calling `exit`, because `irm | iex` runs in the
# caller's own session and `exit` would close their window; under
# `powershell -Command` an uncaught throw still exits non-zero.
& {
    $ErrorActionPreference = 'Stop'

    function ok($msg) { Write-Host "     == $msg" }
    function changed($msg) { Write-Host "     ++ $msg" }
    function fail($msg) {
        Write-Host "     !! $msg" -ForegroundColor Red
        throw $msg
    }

    if ($env:OS -ne 'Windows_NT') {
        fail 'windows.ps1 runs on Windows only; on Arch Linux use: curl -fsSL https://dotfiles.ranolp.dev/setup | sh'
    }
    if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        fail 'winget not found; install App Installer from the Microsoft Store, then rerun'
    }

    foreach ($id in 'Git.Git', 'Nushell.Nushell') {
        winget list --exact --id $id --accept-source-agreements | Out-Null
        if ($LASTEXITCODE -eq 0) {
            ok "winget $id"
            continue
        }
        changed "winget install $id"
        winget install --exact --id $id --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) { fail "winget install $id exited $LASTEXITCODE" }
    }

    # winget updates the registry Path, not this process's copy.
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' +
        [Environment]::GetEnvironmentVariable('Path', 'User')
    foreach ($exe in 'git', 'nu') {
        if (-not (Get-Command $exe -ErrorAction SilentlyContinue)) {
            fail "$exe not on Path after install; open a new terminal and rerun"
        }
    }

    $repo = Join-Path $HOME '.dotfiles'
    if (Test-Path -LiteralPath $repo) {
        ok "$repo present (left untouched)"
    } else {
        changed "git clone $repo"
        git clone https://github.com/RanolP/.dotfiles.git $repo
        if ($LASTEXITCODE -ne 0) { fail "git clone exited $LASTEXITCODE" }
    }

    # Same entry as the `rebuild` alias; install.nu elevates itself.
    changed "nu $repo\xpkg\install.nu"
    nu "$repo\xpkg\install.nu"
    if ($LASTEXITCODE -ne 0) { fail "install.nu exited $LASTEXITCODE" }
}
