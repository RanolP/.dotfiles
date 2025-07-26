#!/usr/bin/env sh
echo Installing essential packages...
echo You may interfered with several popups.

if ! command -v brew >/dev/null; then
    echo "There is no Homebrew yet; install now..."
    # ref: https://brew.sh/
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
fi

echo "$ brew install git"
brew install git
echo "$ brew install nushell"
brew install nushell

nu -c "nu -c (http get https://dotfiles.ranolp.dev/setup-scripts/nu.nu)"
