#!/usr/bin/env bash
# Self-check for the adb shim: every rewrite it performs, plus the commands it
# must leave alone. Runs against a stub adb, so no device is needed.
set -uo pipefail

SHIM="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)/platform-tools/adb"
STUB="$(mktemp -t adb-stub)"
cat >"$STUB" <<'EOF'
#!/bin/sh
printf '%s\n' "$@" | tr '\n' ' '
EOF
chmod +x "$STUB"
trap 'rm -f "$STUB"' EXIT

export AGENT_DEVICE_REAL_ADB="$STUB"
fails=0

expect() { # expect <description> <expected> -- <argv...>
  local desc=$1 want=$2
  shift 3
  local got
  got="$("$SHIM" "$@")"
  if [ "$got" = "$want " ]; then
    printf 'ok   %s\n' "$desc"
  else
    printf 'FAIL %s\n       want: %s\n       got:  %s\n' "$desc" "$want" "$got"
    fails=$((fails + 1))
  fi
}

export AGENT_DEVICE_ANDROID_USER=95

expect 'am start'          '-s S1 shell am start --user 95 -n a/.B'   -- -s S1 shell am start -n a/.B
expect 'am start joined'   '-s S1 shell am start --user 95 -n a/.B'   -- -s S1 shell 'am start -n a/.B'
expect 'am force-stop'     'shell am force-stop --user 95 a'          -- shell am force-stop a
expect 'am instrument'     'shell am instrument --user 95 -w a/.T'    -- shell am instrument -w a/.T
expect 'am broadcast'      'shell am broadcast --user 95 -a X'        -- shell am broadcast -a X
expect 'pm list packages'  'shell pm list packages --user 95'         -- shell pm list packages
expect 'pm path'           'shell pm path --user 95 a'                -- shell pm path a
expect 'cmd package'       'shell cmd package install-existing --user 95 a' -- shell cmd package install-existing a
# The helper-version probe agent-device runs; "list" takes the flag after the
# object, and the wrong position makes the device answer "unknown list type".
expect 'cmd package list'  'shell cmd package list packages --user 95 --show-versioncode p' -- shell cmd package list packages --show-versioncode p
expect 'install apk'       '-s S1 install --user 95 -r -g /tmp/x.apk' -- -s S1 install -r -g /tmp/x.apk

# Untouched: these sub-commands reject --user, and an explicit --user wins.
expect 'input'             'shell input tap 1 2'                      -- shell input tap 1 2
expect 'screenrecord'      'shell screenrecord /sdcard/a.mp4'         -- shell screenrecord /sdcard/a.mp4
expect 'logcat'            'logcat -d'                                -- logcat -d
expect 'devices'           'devices -l'                               -- devices -l
expect 'explicit --user'   'install --user 0 /tmp/x.apk'              -- install --user 0 /tmp/x.apk

AGENT_DEVICE_ANDROID_USER='' expect 'no profile pinned' '-s S1 shell am start -n a/.B' -- -s S1 shell am start -n a/.B

[ "$fails" -eq 0 ] || { printf '\n%d check(s) failed\n' "$fails"; exit 1; }
printf '\nall checks passed\n'
