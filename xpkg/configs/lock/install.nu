#!/usr/bin/env nu

# No automatic lock: waking from sleep or a display timeout returns straight to
# the desktop. CONSOLELOCK is the "require sign-in when the PC wakes" setting
# behind Settings > Accounts > Sign-in options, and a secure screen saver would
# lock on its own timeout. The display-off and sleep timeouts stay as they
# are; only the sign-in they would demand is removed. Win+L still locks.
if $nu.os-info.name != windows {
    return
}

^powercfg /setacvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
^powercfg /setdcvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
^powercfg /setactive SCHEME_CURRENT

^reg add 'HKCU\Control Panel\Desktop' /v ScreenSaverIsSecure /t REG_SZ /d 0 /f | ignore
