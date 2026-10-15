import { isRecord } from './tracker'

type AddressRow = { raw: string; uuid: string; parentUuid?: string; role?: string; text: string }

function transcriptRowText(value: Record<string, unknown>): string {
  const message = isRecord(value.message) ? value.message : value
  const content = message.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.flatMap(block => {
    if (!isRecord(block)) return []
    if (block.type === 'text' && typeof block.text === 'string') return [block.text]
    if (block.type === 'tool_use' && typeof block.name === 'string') return [`${block.name} ${JSON.stringify(block.input ?? {})}`]
    if (block.type === 'tool_result' && typeof block.content === 'string') return [block.content]
    return []
  }).join('\n')
}

export function parseTranscriptRows(text: string): AddressRow[] {
  return text.split('\n').flatMap(raw => {
    if (!raw.trim()) return []
    try {
      const value: unknown = JSON.parse(raw)
      if (!isRecord(value) || typeof value.uuid !== 'string' || !value.uuid) return []
      const message = isRecord(value.message) ? value.message : value
      const role = typeof message.role === 'string' ? message.role : typeof value.type === 'string' ? value.type : undefined
      return [{ raw, uuid: value.uuid, ...(typeof value.parentUuid === 'string' ? { parentUuid: value.parentUuid } : {}), role, text: transcriptRowText(value) }]
    } catch { return [] }
  })
}

export function recallTranscriptAddress(text: string, address: string): { text?: string; error?: string } {
  const match = /^@([\da-f]{8})(?:\.\.@([\da-f]{8}))?$/i.exec(address.trim())
  if (!match) return { error: 'address must be @xxxxxxxx or @first..@last' }
  const rows = parseTranscriptRows(text)
  const byAddress = (short: string) => rows.filter(row => row.uuid.slice(0, 8).toLowerCase() === short.toLowerCase())
  const firstAddress = match[1]
  if (!firstAddress) return { error: 'address must be @xxxxxxxx or @first..@last' }
  const firstMatches = byAddress(firstAddress)
  if (firstMatches.length !== 1) return { error: firstMatches.length ? `address @${firstAddress} is ambiguous` : `address @${firstAddress} was not found` }
  const first = firstMatches[0]
  if (!first) return { error: `address @${firstAddress} was not found` }
  const lastAddress = match[2]
  if (!lastAddress) return { text: first.raw }
  const lastMatches = byAddress(lastAddress)
  if (lastMatches.length !== 1) return { error: lastMatches.length ? `address @${lastAddress} is ambiguous` : `address @${lastAddress} was not found` }
  const last = lastMatches[0]
  if (!last) return { error: `address @${lastAddress} was not found` }
  const byUuid = new Map(rows.map(row => [row.uuid, row]))
  const reverse = [last]
  while (reverse.at(-1)?.uuid !== first.uuid) {
    const current = reverse.at(-1)
    const parent = current?.parentUuid
    const row = parent ? byUuid.get(parent) : undefined
    if (!row || reverse.some(item => item.uuid === row.uuid)) return { error: `@${firstAddress} is not an ancestor of @${lastAddress}` }
    reverse.push(row)
  }
  return { text: reverse.reverse().map(row => row.raw).join('\n') }
}

export type AddressIo = {
  transcriptPath: () => Promise<string | undefined>
  read: (path: string) => Promise<string | undefined>
  log: (text: string, options?: { to?: 'transcript' | 'debug' }) => void
}

export type AddressRuntimeIo = {
  sessionId: () => Promise<string>
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  read: (path: string) => Promise<string | undefined>
  log: (text: string, options?: { to?: 'transcript' | 'debug' }) => void
}

const transcriptPaths = new Map<string, string>()
const transcriptPathKey = (session: string) => `transcript-path:${session}`

export async function transcriptPath(io: AddressRuntimeIo, session: string): Promise<string | undefined> {
  const stored = await io.get(transcriptPathKey(session))
  const path = transcriptPaths.get(session) ?? (typeof stored === 'string' ? stored : undefined)
  if (path) transcriptPaths.set(session, path)
  return path
}

export async function transcriptRows(io: AddressRuntimeIo): Promise<AddressRow[]> {
  const session = await io.sessionId()
  const path = await transcriptPath(io, session)
  if (!path) return []
  const source = await io.read(path)
  return source === undefined ? [] : parseTranscriptRows(source)
}

export async function rememberTranscriptPath(io: AddressRuntimeIo, session: string, path: string): Promise<void> {
  transcriptPaths.set(session, path)
  await io.set(transcriptPathKey(session), path)
}

export function recallIo(io: AddressRuntimeIo): AddressIo {
  return {
    transcriptPath: async () => transcriptPath(io, await io.sessionId()),
    read: io.read,
    log: io.log,
  }
}

export async function recallAddress(io: AddressIo, address: unknown) {
  if (typeof address !== 'string') return { deny: 'clm_recall requires an address such as @c130a62d or @first..@last.' }
  const path = await io.transcriptPath()
  if (!path) return { result: 'The transcript path is unavailable for this session.', isError: true, isReadOnly: true }
  try {
    const source = await io.read(path)
    if (source === undefined) return { result: 'The transcript file is unavailable.', isError: true, isReadOnly: true }
    const recalled = recallTranscriptAddress(source, address)
    if (recalled.error) return { result: recalled.error, isError: true, isReadOnly: true }
    return { result: recalled.text ?? '', isReadOnly: true }
  } catch (err) {
    io.log(`clm_recall: transcript read failed (${String(err).slice(0, 120)})`, { to: 'debug' })
    return { result: 'The transcript could not be read.', isError: true, isReadOnly: true }
  }
}

export type { AddressRow }
