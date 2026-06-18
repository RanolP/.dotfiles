#!/bin/bash
input=$(cat)

# Colors
G=$'\033[32m'
Y=$'\033[33m'
O=$'\033[38;5;208m'
R=$'\033[31m'
C=$'\033[36m'
W=$'\033[97m'
GR=$'\033[90m'
RS=$'\033[0m'

# Parse JSON
MODEL=$(echo "$input" | jq -r '.model.display_name')
EFFORT=$(echo "$input" | jq -r '.effort.level // empty')
THINKING=$(echo "$input" | jq -r '.thinking.enabled // false')
DIR=$(echo "$input" | jq -r '.workspace.current_dir')
SESSION_ID=$(echo "$input" | jq -r '.session_id')
PCT=$(echo "$input" | jq -r '.context_window.used_percentage // 0' | cut -d. -f1)
COST=$(echo "$input" | jq -r '.cost.total_cost_usd // 0')
DURATION_MS=$(echo "$input" | jq -r '.cost.total_duration_ms // 0')
LINES_ADDED=$(echo "$input" | jq -r '.cost.total_lines_added // 0')
LINES_REMOVED=$(echo "$input" | jq -r '.cost.total_lines_removed // 0')
FIVE_H=$(echo "$input" | jq -r '.rate_limits.five_hour.used_percentage // empty')
FIVE_H_RESET=$(echo "$input" | jq -r '.rate_limits.five_hour.resets_at // empty')
WEEK=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')
WEEK_RESET=$(echo "$input" | jq -r '.rate_limits.seven_day.resets_at // empty')
PR_NUM=$(echo "$input" | jq -r '.pr.number // empty')
PR_STATE=$(echo "$input" | jq -r '.pr.review_state // empty')

# Git info — cached per session to avoid lag on large repos
CACHE_FILE="/tmp/claude-sl-git-${SESSION_ID}"
cache_stale() {
    [ ! -f "$CACHE_FILE" ] && return 0
    local mtime
    mtime=$(stat -f %m "$CACHE_FILE" 2>/dev/null || stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0)
    [ $(( $(date +%s) - mtime )) -gt 5 ]
}

if cache_stale; then
    if git -C "$DIR" rev-parse --git-dir > /dev/null 2>&1; then
        BR=$(git -C "$DIR" branch --show-current 2>/dev/null)
        ST=$(git -C "$DIR" diff --cached --numstat 2>/dev/null | wc -l | tr -d ' ')
        MD=$(git -C "$DIR" diff --numstat 2>/dev/null | wc -l | tr -d ' ')
        printf '%s\t%s\t%s' "$BR" "$ST" "$MD" > "$CACHE_FILE"
    else
        printf '\t0\t0' > "$CACHE_FILE"
    fi
fi
# Read the whole cache line without IFS trimming — a leading empty branch
# field (no branch / detached HEAD) must stay empty so the segment hides.
IFS= read -rd '' GIT_CACHE < "$CACHE_FILE"
GIT_BR="${GIT_CACHE%%$'\t'*}"
GIT_REST="${GIT_CACHE#*$'\t'}"
GIT_ST="${GIT_REST%%$'\t'*}"
GIT_MD="${GIT_REST##*$'\t'}"
GIT_ST=${GIT_ST:-0}
GIT_MD=${GIT_MD:-0}

_real_cols() {
    local pid=$$ tty dev cols
    while [ "$pid" -gt 1 ]; do
        tty=$(ps -p "$pid" -o tty= 2>/dev/null | tr -d ' ')
        if [ -n "$tty" ] && [ "$tty" != "??" ]; then
            dev="/dev/tty${tty}"
            [ -c "$dev" ] && cols=$(stty size < "$dev" 2>/dev/null | awk '{print $2}')
            [ -n "$cols" ] && [ "$cols" -gt 0 ] && { echo "$cols"; return; }
        fi
        pid=$(ps -p "$pid" -o ppid= 2>/dev/null | tr -d ' ')
    done
    echo 80
}
COLS=$(_real_cols)

# ── LINE 1 ────────────────────────────────────────────────────────────────────

FOLDER="${DIR##*/}"

# Left: folder  branch +staged ~modified  #PR state
L1L="${C}${FOLDER}${RS}"
L1L_W=${#FOLDER}

if [ -n "$GIT_BR" ]; then
    L1L+=" on $(printf '\xee\x82\xa0') ${GIT_BR}"
    L1L_W=$((L1L_W + 6 + ${#GIT_BR}))
    if [ "$GIT_ST" -gt 0 ]; then
        L1L+=" ${G}+${GIT_ST}${RS}"
        L1L_W=$((L1L_W + 2 + ${#GIT_ST}))
    fi
    if [ "$GIT_MD" -gt 0 ]; then
        L1L+=" ${Y}-${GIT_MD}${RS}"
        L1L_W=$((L1L_W + 2 + ${#GIT_MD}))
    fi
fi

if [ -n "$PR_NUM" ]; then
    case "$PR_STATE" in
        approved)          PC="$G" ;;
        pending)           PC="$Y" ;;
        changes_requested) PC="$R" ;;
        draft)             PC="$GR" ;;
        *)                 PC="$W" ;;
    esac
    if [ -n "$PR_STATE" ]; then
        PR_TXT="#${PR_NUM} ${PR_STATE}"
    else
        PR_TXT="#${PR_NUM}"
    fi
    L1L+=" ${PC}${PR_TXT}${RS}"
    L1L_W=$((L1L_W + 1 + ${#PR_TXT}))
fi

# Right: 🧠 model effort
L1R=""
L1R_W=0
L1R+="using ${W}${MODEL}${RS}"
L1R_W=$((L1R_W + 6 + ${#MODEL}))
if [ -n "$EFFORT" ]; then
    L1R+=" ${GR}${EFFORT}${RS}"
    L1R_W=$((L1R_W + 1 + ${#EFFORT}))
fi
if [ "$THINKING" = "true" ]; then
    L1R+=" 🧠"
    L1R_W=$((L1R_W + 3))
fi

GAP1=$((COLS - L1L_W - L1R_W))
[ "$GAP1" -lt 1 ] && GAP1=1
printf -v PAD1 '%*s' "$GAP1" ''
printf '%s%s%s\n' "$L1L" "$PAD1" "$L1R"

# ── LINE 2 ────────────────────────────────────────────────────────────────────

[ -z "$PCT" ] && PCT=0

if [ "$PCT" -ge 80 ]; then BAR_C="$R"
elif [ "$PCT" -ge 60 ]; then BAR_C="$O"
elif [ "$PCT" -ge 40 ]; then BAR_C="$Y"
else BAR_C="$G"
fi

COST_FMT=$(printf '$%.2f' "$COST")
RL_ICON=$(printf '\xf3\xb0\x91\x90')

# Left: used $cost with N% contexts
L2L="${GR}used ${RS}${Y}${COST_FMT}${RS}${GR} with ${RS}${BAR_C}${PCT}%${RS}${GR} contexts${RS}"
L2L_W=$((5 + ${#COST_FMT} + 6 + ${#PCT} + 10))

# Right: +added -removed  Xm Ys
DUR_SEC=$((DURATION_MS / 1000))
MINS=$((DUR_SEC / 60))
SECS=$((DUR_SEC % 60))
DUR="${MINS}m ${SECS}s"
ADDED_STR="+${LINES_ADDED}"
REMOVED_STR="-${LINES_REMOVED}"
L2R="${G}${ADDED_STR}${RS} ${R}${REMOVED_STR}${RS} ${GR}${DUR}${RS}"
L2R_W=$((${#ADDED_STR} + 1 + ${#REMOVED_STR} + 1 + ${#DUR}))

GAP2=$((COLS - L2L_W - L2R_W))
[ "$GAP2" -lt 1 ] && GAP2=1
printf -v PAD2 '%*s' "$GAP2" ''
printf '%s%s%s\n' "$L2L" "$PAD2" "$L2R"

# ── LINE 3 ────────────────────────────────────────────────────────────────────

# 5h rate limit
if [ -n "$FIVE_H" ]; then
    FH=$(printf '%.0f' "$FIVE_H")
    TIME_UNTIL=""
    if [ -n "$FIVE_H_RESET" ]; then
        NOW_TS=$(date +%s)
        DIFF_SEC=$((FIVE_H_RESET - NOW_TS))
        if [ "$DIFF_SEC" -le 0 ]; then
            TIME_UNTIL="now"
        elif [ "$DIFF_SEC" -lt 3600 ]; then
            DIFF_M=$((DIFF_SEC / 60))
            TIME_UNTIL="${DIFF_M}m"
        else
            DIFF_H=$((DIFF_SEC / 3600))
            DIFF_M=$(((DIFF_SEC % 3600) / 60))
            if [ "$DIFF_M" -gt 0 ]; then
                TIME_UNTIL="${DIFF_H}h${DIFF_M}m"
            else
                TIME_UNTIL="${DIFF_H}h"
            fi
        fi
    fi
    FH_STR="${GR}5h ${RS}${W}${FH}%${RS}${GR} ${RL_ICON}${RS}"
    if [ -n "$TIME_UNTIL" ]; then
        FH_STR+="${GR} in ${RS}${W}${TIME_UNTIL}${RS}"
    fi
else
    FH_STR="${GR}5h ${RS}${W}unknown${RS}"
fi

# Weekly rate limit
if [ -n "$WEEK" ]; then
    WK=$(printf '%.0f' "$WEEK")
    WEEK_RESET_FMT=""
    if [ -n "$WEEK_RESET" ]; then
        read -r WK_DOW WK_HR WK_MIN <<< "$(date -r "$WEEK_RESET" "+%a %H %M" 2>/dev/null)"
        if [ -n "$WK_DOW" ]; then
            WEEK_RESET_FMT="$WK_DOW $((10#$WK_HR)):$WK_MIN"
        fi
    fi
    WK_STR="${GR}weekly ${RS}${W}${WK}%${RS}${GR} ${RL_ICON}${RS}"
    if [ -n "$WEEK_RESET_FMT" ]; then
        WK_STR+="${GR} at ${RS}${W}${WEEK_RESET_FMT}${RS}"
    fi
else
    WK_STR="${GR}weekly ${RS}${W}unknown${RS}"
fi

if [ -n "$FH_STR" ]; then
    L3="${FH_STR}${GR}  ${RS}${WK_STR}"
else
    L3="${WK_STR}"
fi
printf '%s\n' "$L3"
