#!/usr/bin/env bash
# Read-only worktree audit. Classifies every linked worktree of a repo by size,
# age, merge state, uncommitted work, remote and PR state, and the newest Claude
# Code transcript that touched it, then suggests a bucket. It deletes nothing;
# removal stays the user-confirmed step in SKILL.md.
#
# Usage: worktree-audit.sh [-b|--base <ref>] [repo-path]
#   repo-path defaults to the current repo.
#   -b sets the ref MERGED checks against (e.g. origin/develop). Without it the
#   base is origin/HEAD, then origin/main, then origin/master. origin/HEAD is
#   the remote's default branch, which is not always the branch PRs merge into;
#   pass -b when they differ.
#
# MERGED is "ancestor" when HEAD is reachable from the base (fast-forward or
# rebase merge), "squash" when the branch's PR is MERGED and the PR's head
# commit equals this HEAD (squash merge: the commits never reach the base, so
# merge-base alone reports them unmerged), else "no".
set -u

base=""
while [ $# -gt 0 ]; do
    case "$1" in
    -b|--base) [ $# -ge 2 ] || { echo "error: $1 needs a ref" >&2; exit 2; }; base="$2"; shift 2 ;;
    -h|--help) sed -n '2,/^set -u/p' "$0" | sed '$d; s/^# \{0,1\}//'; exit 0 ;;
    -*) echo "error: unknown option: $1" >&2; exit 2 ;;
    *) break ;;
    esac
done

repo="${1:-$(git rev-parse --show-toplevel 2>/dev/null)}"
[ -z "$repo" ] && { echo "error: not in a git repo; pass a repo path" >&2; exit 1; }
cd "$repo" || exit 1
git rev-parse --git-dir >/dev/null 2>&1 || { echo "error: not a git repo: $repo" >&2; exit 1; }

# The first entry is the main worktree, which is never a candidate.
main_wt=$(git worktree list --porcelain | awk '/^worktree /{sub(/^worktree /, ""); print; exit}')

if [ -z "$base" ]; then
    for cand in "$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null)" origin/main origin/master; do
        [ -n "$cand" ] && git rev-parse --verify --quiet "$cand^{commit}" >/dev/null && { base="$cand"; break; }
    done
    [ -z "$base" ] && { echo "error: no base ref (origin/HEAD, origin/main, origin/master all missing); pass -b <ref>" >&2; exit 1; }
    echo "warn: no -b given; MERGED checks against $base" >&2
fi

# Best-effort fetch of the base before the check, since -b may name a branch
# not fetched yet; the explicit refspec creates it even in a single-branch clone.
case "$base" in
origin/*) git fetch origin "+refs/heads/${base#origin/}:refs/remotes/$base" --quiet 2>/dev/null \
    || echo "warn: could not fetch $base; MERGED may be stale" >&2 ;;
esac
git rev-parse --verify --quiet "$base^{commit}" >/dev/null 2>&1 || { echo "error: base ref not found: $base" >&2; exit 1; }

# GNU coreutils reads BSD 'stat -f' as file-system status, so pick flags once.
if stat -c %Y / >/dev/null 2>&1; then
    stat_fmt=(-c '%Y %n'); fmt_day() { date -d "@$1" '+%Y-%m-%d'; }
else
    stat_fmt=(-f '%m %N'); fmt_day() { date -r "$1" '+%Y-%m-%d'; }
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Every PR of this repo, fetched once as [{number, state, head, oid}] with a
# lowercase state; an open draft shows as "draft". Empty when gh cannot read the
# repo, in which case squash merges go undetected and the warning says so.
prs="$tmp/prs.json"
if raw=$(gh pr list --state all --limit 1000 --json number,state,isDraft,headRefName,headRefOid 2>/dev/null); then
    printf '%s' "$raw" | jq '[.[] | {number, head: .headRefName, oid: .headRefOid,
        state: (if .isDraft and .state == "OPEN" then "draft" else (.state | ascii_downcase) end)}]' > "$prs" 2>/dev/null
fi
[ -s "$prs" ] || { echo "[]" > "$prs"; echo "warn: gh pr list failed; PR column is empty and squash merges show as MERGED=no" >&2; }

# Claude Code transcripts touched in the last $window days, across every
# project dir: a session started inside a worktree gets its own project slug,
# so the main repo's slug alone would miss it.
window=14
transcripts="$tmp/transcripts"
find -L "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects" -name '*.jsonl' -mtime "-$window" 2>/dev/null > "$transcripts"
now=$(date +%s)

echo "# base: $base"
echo "# LAST_CHAT scans transcripts modified within ${window}d; '-' means none in that window"
printf "SIZE\tAGE\tMERGED\tDIRTY\tREMOTE\tPR\tLAST_CHAT\tBUCKET\tWORKTREE\n"

git worktree list --porcelain | awk '/^worktree /{sub(/^worktree /, ""); print}' | while IFS= read -r wt; do
    [ "$wt" = "$main_wt" ] && continue
    if [ ! -d "$wt" ]; then
        printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" 0 "?" "?" "?" "?" "-" "-" prunable "$wt"
        continue
    fi

    size=$(du -sh "$wt" 2>/dev/null | awk '{print $1}')
    head=$(git -C "$wt" rev-parse HEAD 2>/dev/null)
    head_ts=$(git -C "$wt" log -1 --format='%ct' HEAD 2>/dev/null || echo 0)
    age=$([ "$head_ts" -gt 0 ] 2>/dev/null && echo "$(( (now - head_ts) / 86400 ))d" || echo "?")
    branch=$(git -C "$wt" symbolic-ref --quiet --short HEAD 2>/dev/null || echo "")

    pr_row=$([ -n "$branch" ] && jq -r --arg b "$branch" \
        'map(select(.head==$b)) | sort_by(.number) | last // empty | "\(.number)\t\(.state)\t\(.oid)"' "$prs" 2>/dev/null)
    pr="-"; pr_state=""; pr_oid=""
    [ -n "$pr_row" ] && IFS=$'\t' read -r pr_num pr_state pr_oid <<<"$pr_row" && pr="#$pr_num/$pr_state"

    if git merge-base --is-ancestor "$head" "$base" 2>/dev/null; then merged=ancestor
    elif [ "$pr_state" = merged ] && [ "$pr_oid" = "$head" ]; then merged=squash
    else merged=no; fi

    # Tracked edits (wip) are unrecoverable once removed; untracked files
    # (scratch) are usually throwaway but still make 'git worktree remove' refuse.
    porcelain=$(git -C "$wt" status --porcelain 2>/dev/null)
    if [ -z "$porcelain" ]; then dirty=clean
    elif printf '%s\n' "$porcelain" | grep -qv '^??'; then
        dirty="wip:$(printf '%s\n' "$porcelain" | grep -cv '^??')"
    else dirty="scratch:$(printf '%s\n' "$porcelain" | grep -c '^??')"; fi

    if [ -z "$branch" ]; then remote=detached
    elif git -C "$wt" show-ref --verify --quiet "refs/remotes/origin/$branch"; then
        [ "$(git -C "$wt" rev-parse "origin/$branch" 2>/dev/null)" = "$head" ] \
            && remote=pushed \
            || remote="ahead$(git -C "$wt" rev-list --count "origin/$branch..HEAD" 2>/dev/null)"
    elif git -C "$wt" config --get "branch.$branch.merge" >/dev/null 2>&1; then remote=gone
    else remote=no-remote; fi

    # Match the path followed by "/" or a quote so wt-482 does not match wt-482-r37.
    last="-"; last_ts=0
    if [ -s "$transcripts" ]; then
        f=$(tr '\n' '\0' < "$transcripts" | xargs -0 rg -l -F -e "${wt}/" -e "${wt}\"" 2>/dev/null \
            | tr '\n' '\0' | xargs -0 stat "${stat_fmt[@]}" 2>/dev/null | sort -rn | head -1)
        if [ -n "$f" ]; then last_ts=${f%% *}; last=$(fmt_day "$last_ts" 2>/dev/null); fi
    fi
    recent=no
    [ "$last_ts" -gt 0 ] && [ $(( (now - last_ts) / 86400 )) -le 4 ] && recent=yes

    case "$dirty" in wip:*) bucket=hold-wip ;; *)
        case "$pr_state" in open|draft) bucket=hold-open-pr ;; *)
            if [ "$recent" = yes ]; then bucket=verify-recent-chat
            elif [ "$merged" != no ] && [ "$dirty" = clean ]; then bucket=safe
            elif [ "$merged" != no ]; then bucket=safe-after-scratch
            else bucket=review; fi ;;
        esac ;;
    esac

    printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
        "$size" "$age" "$merged" "$dirty" "$remote" "$pr" "$last" "$bucket" "$wt"
done | sort -t$'\t' -k1,1 -rh
