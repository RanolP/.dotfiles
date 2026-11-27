// Pure helpers that tie a Bash call to the shell Claude Code forked for it, by the line fork-tracker.py wrote while that
// shell ran. The shell is its own process-group leader and a detached job keeps that group after the shell exits
// (measured 2026-11-27: shell 48496 -> orphan sleep ppid 1 pgid 48496), so pgid -> agent is the whole attribution.

export type ForkLine = { pid: number; pgid: number; argv: string[]; t: number }
export type Flight = { agentId?: string; command: string; startedAt: number; endedAt?: number }

// Hook clock and tracker clock are both wall milliseconds; the slack absorbs their jitter, not a window of guesses.
const SLACK_MS = 250

// Claude Code runs a call as `zsh -c "source <snapshot> ... && eval '<command>' < /dev/null && pwd -P ..."`, each ' of the command
// written as '"'"' (read from the shell's own ps line, 2026-11-27).
export const evalNeedle = (command: string) => `eval '${command.replaceAll("'", `'"'"'`)}'`

export const parseForkLines = (text: string): ForkLine[] => {
  const lines: ForkLine[] = []
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue
    try {
      const v: unknown = JSON.parse(raw)
      if (typeof v === 'object' && v !== null) {
        const { pid, pgid, argv, t } = v as Record<string, unknown>
        if (typeof pid === 'number' && typeof pgid === 'number' && typeof t === 'number' && Array.isArray(argv) && argv.every(a => typeof a === 'string')) lines.push({ pid, pgid, argv: argv as string[], t })
      }
    } catch { /* a torn last line is rewritten whole by the next append */ }
  }
  return lines
}

// Gives each flight, in the order the calls started, the earliest unclaimed shell line whose argv carries its command and whose
// time falls in its window; two identical commands in flight at once therefore pair by start order. `claimed` collects `pid@t`.
export const matchFlights = (flights: readonly Flight[], lines: readonly ForkLine[], claimed: Set<string>) => {
  const byTime = [...lines].sort((a, b) => a.t - b.t)
  const pairs: { flight: Flight; line: ForkLine }[] = []
  for (const flight of [...flights].sort((a, b) => a.startedAt - b.startedAt)) {
    const needle = evalNeedle(flight.command)
    const line = byTime.find(l => !claimed.has(`${l.pid}@${l.t}`)
      && l.t >= flight.startedAt - SLACK_MS && (flight.endedAt === undefined || l.t <= flight.endedAt + SLACK_MS)
      && l.argv.some(part => part.includes(needle)))
    if (!line) continue
    claimed.add(`${line.pid}@${line.t}`)
    pairs.push({ flight, line })
  }
  return pairs
}

export type PgidRow = { pgid: number; command: string }
// `ps -axwwo pid=,pgid=,command=`
export const parsePgidRows = (output: string) => {
  const rows = new Map<number, PgidRow>()
  for (const line of output.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s*(.*)$/)
    if (m) rows.set(Number(m[1]), { pgid: Number(m[2]), command: m[3] ?? '' })
  }
  return rows
}
