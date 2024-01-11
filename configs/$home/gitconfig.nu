#!/usr/bin/env nu

# no CRLF at all
git config --global core.eol lf

# default branch must be main
git config --global init.defaultBranch main

# auto remote
git config --global push.autoSetupRemote true
