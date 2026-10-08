#!/bin/sh
# One tick of org.ranolp.claude-awake (launchd, every 60 s, as root): keep the
# Mac awake with the lid closed while the deadline that time-budget's
# stay_awake tool writes is in the future and the battery can afford it.
# PMSET, UNTIL_FILE and NOW are overridable so the logic tests without root.
PMSET=${PMSET:-/usr/bin/pmset}
UNTIL_FILE=${UNTIL_FILE:-/Users/ranolp/.local/state/claude-awake/until}
NOW=${NOW:-$(/bin/date +%s)}
MAX_AHEAD=$((12 * 3600))
MIN_BATTERY=20

until_ts=$(/usr/bin/head -c 32 "$UNTIL_FILE" 2>/dev/null | /usr/bin/tr -d '[:space:]')
case "$until_ts" in
  '' | *[!0-9]*) until_ts=0 ;;
esac
# A deadline far ahead is a bug or a stale clock; never trust more than 12 h.
[ "$until_ts" -gt $((NOW + MAX_AHEAD)) ] && until_ts=$((NOW + MAX_AHEAD))

batt=$("$PMSET" -g batt)
on_ac=0
case "$batt" in *"'AC Power'"*) on_ac=1 ;; esac
pct=$(printf '%s\n' "$batt" | /usr/bin/sed -n 's/.*[^0-9]\([0-9][0-9]*\)%.*/\1/p' | /usr/bin/head -n 1)
[ -n "$pct" ] || pct=0

want=0
reason="deadline $until_ts passed (now $NOW)"
if [ "$NOW" -lt "$until_ts" ]; then
  if [ "$on_ac" = 1 ] || [ "$pct" -ge "$MIN_BATTERY" ]; then
    want=1
    reason="awake until $until_ts (now $NOW, ac=$on_ac, battery=$pct%)"
  else
    reason="battery $pct% below $MIN_BATTERY% on battery power"
  fi
fi

# `pmset -g` omits the SleepDisabled row when it is 0.
cur=$("$PMSET" -g | /usr/bin/awk '/SleepDisabled/ { print $2 }')
[ -n "$cur" ] || cur=0

if [ "$cur" != "$want" ]; then
  "$PMSET" -a disablesleep "$want"
  rc=$?
  stamp=$(/bin/date '+%F %T')
  if [ "$rc" -ne 0 ]; then
    echo "$stamp pmset -a disablesleep $want failed (exit $rc): $reason" >&2
    exit 1
  fi
  echo "$stamp disablesleep $cur -> $want: $reason"
fi
