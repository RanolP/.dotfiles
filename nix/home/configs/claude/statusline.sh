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
WEEK=$(echo "$input" | jq -r '.rate_limits.seven_day.used_percentage // empty')
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
IFS=$'\t' read -r GIT_BR GIT_ST GIT_MD < "$CACHE_FILE"
GIT_ST=${GIT_ST:-0}
GIT_MD=${GIT_MD:-0}

COLS=${COLUMNS:-80}

# ── LINE 1 ────────────────────────────────────────────────────────────────────

FOLDER="${DIR##*/}"

# Left: folder  branch +staged ~modified  #PR state
L1L="${C}${FOLDER}${RS}"
L1L_W=${#FOLDER}

if [ -n "$GIT_BR" ]; then
    L1L+=" ${GIT_BR}"
    L1L_W=$((L1L_W + 1 + ${#GIT_BR}))
    if [ "$GIT_ST" -gt 0 ]; then
        L1L+=" ${G}+${GIT_ST}${RS}"
        L1L_W=$((L1L_W + 2 + ${#GIT_ST}))
    fi
    if [ "$GIT_MD" -gt 0 ]; then
        L1L+=" ${Y}~${GIT_MD}${RS}"
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

if [ "$THINKING" = "true" ]; then
    L1R+="🧠 "
    L1R_W=$((L1R_W + 3))  # emoji=2 display cols + space=1
fi

L1R+="${W}${MODEL}${RS}"
L1R_W=$((L1R_W + ${#MODEL}))

if [ -n "$EFFORT" ]; then
    L1R+=" ${GR}${EFFORT}${RS}"
    L1R_W=$((L1R_W + 1 + ${#EFFORT}))
fi

GAP1=$((COLS - L1L_W - L1R_W))
[ "$GAP1" -lt 1 ] && GAP1=1
printf -v PAD1 '%*s' "$GAP1" ''
printf '%s%s%s\n' "$L1L" "$PAD1" "$L1R"

# ── LINE 2 ────────────────────────────────────────────────────────────────────

# Context bar (10 wide, threshold-colored)
BAR_W=10
[ -z "$PCT" ] && PCT=0
FILLED=$((PCT * BAR_W / 100))
[ "$FILLED" -gt "$BAR_W" ] && FILLED=$BAR_W
[ "$FILLED" -lt 0 ] && FILLED=0
EMPTY=$((BAR_W - FILLED))

if [ "$PCT" -ge 80 ]; then BAR_C="$R"
elif [ "$PCT" -ge 60 ]; then BAR_C="$O"
elif [ "$PCT" -ge 40 ]; then BAR_C="$Y"
else BAR_C="$G"
fi

BAR=""
if [ "$FILLED" -gt 0 ]; then printf -v F '%*s' "$FILLED" ''; BAR="${F// /▓}"; fi
if [ "$EMPTY" -gt 0 ]; then printf -v E '%*s' "$EMPTY" ''; BAR="${BAR}${E// /░}"; fi

COST_FMT=$(printf '$%.2f' "$COST")

# Left: cost  [bar] pct%  5h:X%  7d:X%
L2L="${Y}${COST_FMT}${RS} ${BAR_C}${BAR}${RS} ${PCT}%"
L2L_W=$((${#COST_FMT} + 1 + BAR_W + 1 + ${#PCT} + 1))

if [ -n "$FIVE_H" ]; then
    FH=$(printf '%.0f' "$FIVE_H")
    L2L+=" 5h:${FH}%"
    L2L_W=$((L2L_W + 1 + 3 + ${#FH} + 1))
fi
if [ -n "$WEEK" ]; then
    WK=$(printf '%.0f' "$WEEK")
    L2L+=" 7d:${WK}%"
    L2L_W=$((L2L_W + 1 + 3 + ${#WK} + 1))
fi

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
