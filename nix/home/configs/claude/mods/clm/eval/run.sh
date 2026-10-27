#!/bin/sh
# SPDX-FileCopyrightText: 2026 clm eval contributors
# SPDX-License-Identifier: MIT
set -u

case "${1-}" in
  --stub) mode=stub ;;
  --real) mode=real ;;
  *) printf '%s\n' 'usage: sh eval/run.sh --stub|--real' >&2; exit 2 ;;
esac

eval_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
mod_dir=$(CDPATH= cd -- "$eval_dir/.." && pwd)
output=$(mktemp "$eval_dir/.run.XXXXXXXX")
trap 'rm -f "$output"' EXIT HUP INT TERM

sync_bundle() {
  python3 - "$eval_dir" <<'PY'
import json, pathlib, sys
root = pathlib.Path(sys.argv[1])
ids = ['f757aaf2', 'release', 'auth', 'migration']
fixtures = {name: json.loads((root / 'fixtures' / f'{name}.json').read_text()) for name in ids}
replies = {name: json.loads((root / 'recorded' / f'{name}.json').read_text()) for name in ids}
probes = json.loads((root / 'probes.json').read_text())
(root / 'data.ts').write_text(
    '// Immutable inputs and replies bundled as TypeScript because the plugin test loader imports code files only.\n'
    + 'export const fixtures = ' + json.dumps(fixtures, separators=(',', ':'), ensure_ascii=False) + ' as const\n'
    + 'export const replies = ' + json.dumps(replies, separators=(',', ':'), ensure_ascii=False) + ' as const\n'
    + 'export const probes = ' + json.dumps(probes, separators=(',', ':'), ensure_ascii=False) + ' as const\n'
)
PY
}

sync_bundle
CLM_EVAL_MODE=$mode claude plugin test "$mod_dir" >"$output" 2>&1
status=$?

if [ "$mode" = real ]; then
  python3 - "$eval_dir" "$output" <<'PY'
import json, pathlib, sys
root, output = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
lines = output.read_text().splitlines()
visible = []
for line in lines:
    prefix = 'CLM_EVAL_RECORD '
    if not line.startswith(prefix):
        visible.append(line)
        continue
    record = json.loads(line[len(prefix):])
    if record.get('fixture') not in {'f757aaf2', 'release', 'auth', 'migration'} or not isinstance(record.get('reply'), str):
        raise SystemExit('invalid CLM_EVAL_RECORD output')
    (root / 'recorded' / f"{record['fixture']}.json").write_text(json.dumps(record, indent=2, ensure_ascii=False) + '\n')
output.write_text('\n'.join(visible) + '\n')
PY
  sync_bundle
fi

python3 - "$output" <<'PY'
import pathlib, re, sys
path = pathlib.Path(sys.argv[1])
lines = path.read_text().splitlines()
end = next((i for i in range(len(lines) - 1, -1, -1) if lines[i] == 'by kind'), None)
if end is None:
    raise SystemExit(0)
start = end - 19
probe = re.compile(r'^(?:PASS|FAIL) (?:release|auth|migration)-[a-z0-9-]+ (?:instruction|decision|focus|fact|stack)$')
if start < 0 or lines[end - 1] != '' or not all(probe.fullmatch(line) for line in lines[start:end - 1]):
    raise SystemExit(0)
table = lines[end + 1:end + 6]
if len(table) != 5 or not all(re.fullmatch(r'(?:instruction|decision|focus|fact|stack)\s+[0-9]+/[0-9]+', line) for line in table):
    raise SystemExit(0)
path.write_text('\n'.join(lines[start:end + 6]) + '\n')
PY

cat "$output"
if grep -q '^by kind$' "$output"; then
  if grep -q '^FAIL ' "$output"; then exit 1; fi
  exit 0
fi
exit "$status"
