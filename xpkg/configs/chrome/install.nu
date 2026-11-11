#!/usr/bin/env nu

# Mirrors the macOS policy in nix/darwin/default.nix: force-install extension
# fcoeoabgfenejglbffodgkkbkcdhcgfn. Chrome reads policies from HKLM, so this
# step needs admin (configs/install.nu runs elevated; standalone, use
# `gsudo nu <this file>`).
if $nu.os-info.name != windows {
    return
}

^reg add 'HKLM\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist' /v 1 /t REG_SZ /d 'fcoeoabgfenejglbffodgkkbkcdhcgfn;https://clients2.google.com/service/update2/crx' /f | ignore
