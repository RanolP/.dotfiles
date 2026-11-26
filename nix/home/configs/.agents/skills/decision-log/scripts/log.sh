#!/usr/bin/env bash
# Append one row to a decision log (TSV) for skill decision-log.
# Usage: log.sh <logfile> <phase> <decision> <why> <evidence> <result>
#
# Stamps ts in UTC, writes the header when the file is empty or missing,
# flattens tabs, CR and LF inside a cell to spaces so every row stays one
# line with six columns, and prefixes a cell starting with = + - @ with a
# single quote so text copied from untrusted sources (PR titles, Slack
# messages, file names) cannot run as a spreadsheet formula when the log is
# opened in one.
set -euo pipefail

if [ "$#" -ne 6 ]; then
	printf 'usage: log.sh <logfile> <phase> <decision> <why> <evidence> <result>\n' >&2
	exit 2
fi

logfile="$1"
shift
mkdir -p "$(dirname "$logfile")"

# Append with >> even for the header: when the emptiness test misreads an
# existing log (a network mount), the cost is one stray header line rather
# than every row written so far.
if [ ! -s "$logfile" ]; then
	printf 'ts\tphase\tdecision\twhy\tevidence\tresult\n' >>"$logfile"
fi

clean() {
	local v
	v=$(printf '%s' "$1" | tr '\t\r\n' '   ')
	case "$v" in
	[=+@-]*) printf "'%s" "$v" ;;
	*) printf '%s' "$v" ;;
	esac
}

printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
	"$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
	"$(clean "$1")" "$(clean "$2")" "$(clean "$3")" "$(clean "$4")" "$(clean "$5")" \
	>>"$logfile"
