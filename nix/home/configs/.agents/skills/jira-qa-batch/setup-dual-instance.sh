#!/usr/bin/env bash
# Brings up the two app instances the QA batch compares side by side:
#
#   as-is  = Android user 0,  runs the bundle baked into the debug APK
#   to-be  = Android user 95, runs the QA Metro over "adb reverse"
#
# Both processes stay alive at the same time, so a timing-sensitive screen is
# captured under the same device conditions instead of two sequential runs.
#
#   setup-dual-instance.sh            bring the pair up
#   setup-dual-instance.sh --restore  put the device back the way it was
set -euo pipefail

SKILL_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"

# APP_REPO, PKG and SERIAL name a specific checkout, application id and
# phone, so this public file carries no defaults for them. Set them in the
# environment, or in the untracked file sourced here.
if [ -r "$HOME/.claude-personal/jira-qa-batch.env" ]; then
  set -a
  . "$HOME/.claude-personal/jira-qa-batch.env"
  set +a
fi

APP_REPO="${APP_REPO:?set APP_REPO to the app repo checkout}"
PKG="${PKG:?set PKG to the Android application id}"
QA_USER="${QA_USER:-95}"
SERIAL="${SERIAL:?set SERIAL to the adb device serial}"
# Port the app dials on the device; "adb reverse" forwards it to the Mac.
DEVICE_METRO_PORT="${DEVICE_METRO_PORT:-8082}"
# Port the QA Metro listens on, on the Mac. 8081 usually belongs to another
# worktree's Metro, so the default deliberately sits elsewhere.
QA_METRO_PORT="${QA_METRO_PORT:-8083}"
STATE_DIR="${STATE_DIR:-$HOME/.cache/jira-qa-batch}"
PREFS_BACKUP="$STATE_DIR/user0-prefs.xml"
PREFS_FILE="shared_prefs/${PKG}_preferences.xml"

export ANDROID_SERIAL="$SERIAL"

die() { printf 'setup-dual-instance: %s\n' "$*" >&2; exit 1; }
note() { printf '  %s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }

read_prefs() { # read_prefs <user>
  # adb shell turns every LF into CRLF, so the CRs come back off again.
  adb shell run-as "$PKG" --user "$1" cat "$PREFS_FILE" 2>/dev/null | tr -d '\r' || true
}

write_prefs() { # write_prefs <user>  (xml on stdin; the app must be stopped)
  # The whole remote command is one argument on purpose: adb joins its
  # arguments with spaces and the device's own shell parses the result, so an
  # unquoted "> path" would redirect in that shell (cwd /) instead of inside
  # run-as, and fail with "No such file or directory".
  adb shell "run-as $PKG --user $1 sh -c 'cat > $PREFS_FILE'"
}

# Sets, or with no value removes, one string key in a SharedPreferences file.
edit_prefs() { # edit_prefs <user> <key> [value]
  local user=$1 key=$2 value=${3-}
  local xml
  xml="$(read_prefs "$user")"
  [ -n "$xml" ] || die "user $user has no $PREFS_FILE yet — launch the app once first"
  printf '%s' "$xml" | KEY="$key" VALUE="$value" HAS_VALUE="${3+yes}" python3 -c '
import os, sys, xml.etree.ElementTree as ET
key, value, has_value = os.environ["KEY"], os.environ["VALUE"], os.environ.get("HAS_VALUE")
root = ET.fromstring(sys.stdin.read())
for node in root.findall("string"):
    if node.get("name") == key:
        root.remove(node)
if has_value:
    ET.SubElement(root, "string", {"name": key}).text = value
q = chr(39)
sys.stdout.write(f"<?xml version={q}1.0{q} encoding={q}utf-8{q} standalone={q}yes{q} ?>\n")
sys.stdout.write(ET.tostring(root, encoding="unicode"))
' | write_prefs "$user"
}

stop_both() {
  adb shell am force-stop --user 0 "$PKG" || true
  adb shell am force-stop --user "$QA_USER" "$PKG" || true
}

if [ "${1-}" = "--restore" ]; then
  step "Stopping both instances"
  stop_both
  step "Restoring the user 0 preferences"
  if [ -f "$PREFS_BACKUP" ]; then
    write_prefs 0 <"$PREFS_BACKUP"
    note "restored from $PREFS_BACKUP"
  else
    note "no backup at $PREFS_BACKUP — user 0 left as it is"
  fi
  step "Removing the reverse tunnel"
  adb reverse --remove "tcp:$DEVICE_METRO_PORT" 2>/dev/null || note "no tunnel on tcp:$DEVICE_METRO_PORT"
  step "Local edits left in $APP_REPO"
  git -C "$APP_REPO" status --short -- android/app/build.gradle
  note 'these stay in the working tree — do not commit them'
  exit 0
fi

step "Device"
adb devices -l | grep -q "^$SERIAL" || die "$SERIAL is not attached (adb devices)"
note "$SERIAL"
adb shell pm list users | grep -q "{$QA_USER:" || die "Android user $QA_USER does not exist on this device"
note "Android user $QA_USER present"

step "Local build.gradle patch (never committed)"
if grep -q 'debuggableVariants' "$APP_REPO/android/app/build.gradle"; then
  note 'already applied'
else
  git -C "$APP_REPO" apply "$SKILL_DIR/debuggable-variants.patch"
  note 'applied debuggable-variants.patch'
fi
note 'the as-is side needs the debug APK to carry its own bundle;'
note 'leave this edit in the working tree and never commit it'

if [ "${SKIP_BUILD:-}" = "1" ]; then
  step "Build skipped (SKIP_BUILD=1)"
else
  step "Building and installing the debug APK for user 0"
  (cd "$APP_REPO/android" && mise exec -- ./gradlew :app:installDebug)
fi

step "Cloning the install into user $QA_USER"
adb shell cmd package install-existing --user "$QA_USER" "$PKG"

step "Pre-installing the agent-device snapshot helper into both users"
# Two reasons this happens here rather than being left to agent-device:
#  - a fresh "adb install --user N" of this helper takes ~30s on this device and
#    agent-device gives up at 30s;
#  - the helper needs its runtime permissions granted per profile ("-g"). A
#    profile that has it without them crashes inside UiAutomation
#    ("Cannot call disconnect() while connecting"), so every gesture comes back
#    as "Android automation helper output could not be parsed" while a plain
#    screenshot still works.
helper_apk="$(ls -1 "$(mise where npm:agent-device)"/lib/node_modules/agent-device/android/snapshot-helper/dist/*.apk 2>/dev/null | head -1 || true)"
if [ -z "$helper_apk" ]; then
  note 'helper APK not found under `mise where npm:agent-device` — skipping'
else
  for u in 0 "$QA_USER"; do
    note "installing $(basename "$helper_apk") into user $u (~30s)"
    adb install --user "$u" -r -t -g "$helper_apk"
  done
fi

step "Stopping both instances before touching their preferences"
stop_both

step "Backing up the user 0 preferences"
mkdir -p "$STATE_DIR"
read_prefs 0 >"$PREFS_BACKUP"
[ -s "$PREFS_BACKUP" ] || die "could not read the user 0 preferences — is the app installed for user 0?"
note "$PREFS_BACKUP"

step "Pointing each instance at its bundle source"
# user 0 keeps no dev server, so it always falls back to the APK's own bundle.
edit_prefs 0 debug_http_host
note "user 0      -> bundle inside the APK"
edit_prefs "$QA_USER" debug_http_host "localhost:$DEVICE_METRO_PORT"
note "user $QA_USER     -> localhost:$DEVICE_METRO_PORT"

step "Reverse tunnel"
adb reverse "tcp:$DEVICE_METRO_PORT" "tcp:$QA_METRO_PORT"
adb reverse --list

step "Launching both instances"
adb shell am start --user 0 -n "$PKG/.MainActivity" >/dev/null
adb shell am start --user "$QA_USER" -n "$PKG/.MainActivity" >/dev/null
sleep 3
adb shell ps -A | grep "$PKG" || die "neither instance came up"

cat <<EOF

Both instances are up. Drive them with two agent-device sessions:

  export ANDROID_SDK_ROOT=$SKILL_DIR/adb-user-shim
  export ANDROID_HOME=\$ANDROID_SDK_ROOT
  export AGENT_DEVICE_REAL_ADB=\$(which adb)

  # as-is (user 0)
  AGENT_DEVICE_ANDROID_USER=0 \\
  AGENT_DEVICE_STATE_DIR=$STATE_DIR/asis AGENT_DEVICE_CLAIMS_DIR=$STATE_DIR/asis/claims \\
  AGENT_DEVICE_SESSION=qa-asis agent-device open $PKG --serial $SERIAL

  # to-be (user $QA_USER)
  AGENT_DEVICE_ANDROID_USER=$QA_USER \\
  AGENT_DEVICE_STATE_DIR=$STATE_DIR/tobe AGENT_DEVICE_CLAIMS_DIR=$STATE_DIR/tobe/claims \\
  AGENT_DEVICE_SESSION=qa-tobe agent-device open $PKG --serial $SERIAL

The QA Metro must be serving the to-be branch on 127.0.0.1:$QA_METRO_PORT.
Tear down with: $0 --restore
EOF
