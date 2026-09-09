#!/usr/bin/env bash
# Builds the side-by-side review out of the two recordings the QA batch made.
#
# The device has one physical display, so as-is and to-be are recorded
# separately and joined here: each side's chunks are concatenated, the pair is
# stacked left/right, and the result is written next to a review.html that
# names each step.
#
#   compose-review.sh --asis <dir> --tobe <dir> --out <dir> \
#                     [--steps steps.tsv] [--idle-speed 10] [--title "KEY summary"]
#
# --asis / --tobe take the directory the run recorded into; every *.mp4 and
# *.webm inside is concatenated in filename order (agent-device writes mp4 and
# splits a recording longer than 180s into chunks; agent-browser writes webm).
#
# steps.tsv is optional and has one row per step, tab separated:
#   start_seconds<TAB>end_seconds<TAB>label<TAB>differs(0|1)
# Rows with differs=0 play at --idle-speed; rows with differs=1 play at 1x and
# hold their last frame for a beat so the difference is readable.
set -euo pipefail

ASIS_DIR="" TOBE_DIR="" OUT_DIR="" STEPS="" IDLE_SPEED=10 TITLE="QA review"

while [ $# -gt 0 ]; do
  case "$1" in
    --asis) ASIS_DIR=$2; shift 2 ;;
    --tobe) TOBE_DIR=$2; shift 2 ;;
    --out) OUT_DIR=$2; shift 2 ;;
    --steps) STEPS=$2; shift 2 ;;
    --idle-speed) IDLE_SPEED=$2; shift 2 ;;
    --title) TITLE=$2; shift 2 ;;
    *) printf 'compose-review: unknown option %s\n' "$1" >&2; exit 2 ;;
  esac
done

[ -d "${ASIS_DIR:-}" ] || { echo 'compose-review: --asis <dir> is required' >&2; exit 2; }
[ -d "${TOBE_DIR:-}" ] || { echo 'compose-review: --tobe <dir> is required' >&2; exit 2; }
[ -n "${OUT_DIR:-}" ] || { echo 'compose-review: --out <dir> is required' >&2; exit 2; }
command -v ffmpeg >/dev/null || { echo 'compose-review: ffmpeg is not on PATH' >&2; exit 127; }

mkdir -p "$OUT_DIR"
WORK="$(mktemp -d -t qa-compose)"
trap 'rm -rf "$WORK"' EXIT

concat_side() { # concat_side <dir> <out.mp4>
  # Split across two statements on purpose: a single "local" expands every word
  # before it assigns any of them, so "$out" would still be unset in "list".
  local dir=$1 out=$2 n
  local list="$WORK/$(basename "$out").txt"
  : >"$list"
  # agent-device writes mp4, agent-browser writes webm; a run may hold either.
  for f in "$dir"/*.mp4 "$dir"/*.webm; do
    [ -e "$f" ] || continue
    printf "file '%s'\n" "$f" >>"$list"
  done
  n=$(wc -l <"$list" | tr -d ' ')
  [ "$n" -gt 0 ] || { echo "compose-review: no mp4 in $dir" >&2; exit 1; }
  ffmpeg -nostdin -y -loglevel error -f concat -safe 0 -i "$list" -c copy "$out"
  printf '  %s: %s chunk(s)\n' "$(basename "$dir")" "$n"
}

echo '== Concatenating each side'
# Matroska on the way through: it carries H.264 and VP8/VP9 alike, so the
# concat stays a stream copy whichever tool produced the clips.
concat_side "$ASIS_DIR" "$WORK/asis.mkv"
concat_side "$TOBE_DIR" "$WORK/tobe.mkv"

# Compresses the idle stretches and holds the differing ones, per steps.tsv.
retime() { # retime <in.mp4> <out.mp4>
  local in=$1 out=$2
  if [ -z "$STEPS" ] || [ ! -s "$STEPS" ]; then
    cp "$in" "$out"
    return
  fi
  local filter parts=() labels=() i=0 start end label differs
  while IFS=$'\t' read -r start end label differs; do
    case "$start" in ''|'#'*) continue ;; esac
    if [ "${differs:-0}" = "1" ]; then
      parts+=("[0:v]trim=$start:$end,setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=1.5[v$i]")
    else
      parts+=("[0:v]trim=$start:$end,setpts=(PTS-STARTPTS)/$IDLE_SPEED[v$i]")
    fi
    labels+=("[v$i]")
    i=$((i + 1))
  done <"$STEPS"
  [ "$i" -gt 0 ] || { cp "$in" "$out"; return; }
  filter="$(IFS=';'; echo "${parts[*]}");$(IFS=''; echo "${labels[*]}")concat=n=$i:v=1:a=0[out]"
  ffmpeg -nostdin -y -loglevel error -i "$in" -filter_complex "$filter" -map '[out]' -an "$out"
}

echo '== Retiming'
retime "$WORK/asis.mkv" "$WORK/asis-timed.mkv"
retime "$WORK/tobe.mkv" "$WORK/tobe-timed.mkv"

echo '== Stacking as-is | to-be'
REVIEW_MP4="$OUT_DIR/review.mp4"
# This ffmpeg carries no fontconfig configuration, so drawtext is given the font
# file outright; without it every label falls back to "Cannot load default
# config file" and renders nothing.
FONT="${QA_REVIEW_FONT:-/System/Library/Fonts/Supplemental/Arial.ttf}"
[ -f "$FONT" ] || FONT=/System/Library/Fonts/Helvetica.ttc
ffmpeg -nostdin -y -loglevel error \
  -i "$WORK/asis-timed.mkv" -i "$WORK/tobe-timed.mkv" \
  -filter_complex "\
[0:v]scale=-2:960,pad=iw:ih+72:0:72:black,drawtext=fontfile='$FONT':text='AS-IS':fontcolor=white:fontsize=44:x=(w-tw)/2:y=14[l];\
[1:v]scale=-2:960,pad=iw:ih+72:0:72:black,drawtext=fontfile='$FONT':text='TO-BE':fontcolor=white:fontsize=44:x=(w-tw)/2:y=14[r];\
[l][r]hstack=inputs=2[out]" \
  -map '[out]' -an -pix_fmt yuv420p "$REVIEW_MP4"

echo '== Writing review.html'
TITLE="$TITLE" STEPS="$STEPS" OUT_DIR="$OUT_DIR" python3 <<'PY'
import html, os, pathlib

out = pathlib.Path(os.environ["OUT_DIR"])
title = os.environ["TITLE"]
steps_path = os.environ.get("STEPS") or ""

rows = []
if steps_path and os.path.exists(steps_path):
    for line in open(steps_path):
        line = line.rstrip("\n")
        if not line or line.startswith("#"):
            continue
        cols = line.split("\t")
        while len(cols) < 4:
            cols.append("")
        rows.append(cols[:4])

def row_html(start, end, label, differs):
    mark = "차이" if differs == "1" else "동일"
    cls = "differs" if differs == "1" else "same"
    return (f'<tr class="{cls}"><td>{html.escape(start)}s–{html.escape(end)}s</td>'
            f'<td>{html.escape(label)}</td><td>{mark}</td></tr>')

table = "".join(row_html(*r) for r in rows) or '<tr><td colspan="3">스텝 표가 없습니다.</td></tr>'
shots = sorted(p.name for p in out.glob("*.png"))
gallery = "".join(f'<figure><img src="{html.escape(n)}" alt="{html.escape(n)}"><figcaption>{html.escape(n)}</figcaption></figure>' for n in shots)

(out / "review.html").write_text(f"""<!doctype html>
<html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{html.escape(title)}</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{ font: 16px/1.6 system-ui, sans-serif; margin: 0 auto; padding: 2rem; max-width: 1100px; }}
  video {{ width: 100%; border-radius: 8px; background: #000; }}
  table {{ border-collapse: collapse; width: 100%; margin-top: 1rem; }}
  th, td {{ border-bottom: 1px solid #8884; padding: .5rem .6rem; text-align: left; }}
  tr.differs {{ font-weight: 600; }}
  tr.same {{ opacity: .65; }}
  .gallery {{ display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 1rem; }}
  figure {{ margin: 0; }}
  figure img {{ width: 100%; border: 1px solid #8884; border-radius: 6px; }}
  figcaption {{ font-size: .8rem; opacity: .7; }}
</style></head>
<body>
<h1>{html.escape(title)}</h1>
<p>왼쪽이 as-is(Android user 0, APK 내장 번들), 오른쪽이 to-be(Android user 95, QA Metro)입니다. 두 인스턴스는 같은 기기에서 동시에 실행되었습니다.</p>
<video src="review.mp4" controls playsinline></video>
<h2>스텝</h2>
<table><thead><tr><th>구간</th><th>스텝</th><th>판정</th></tr></thead><tbody>{table}</tbody></table>
<h2>스크린샷</h2>
<div class="gallery">{gallery or '<p>스크린샷이 없습니다.</p>'}</div>
</body></html>
""", encoding="utf-8")
PY

printf '\nreview: %s\n        %s\n' "$REVIEW_MP4" "$OUT_DIR/review.html"
