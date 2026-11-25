import { checkEvidence, describeOp, gateOps, withhold, isDoneClaim, isDropClaim, isReopenClaim, resolveRef, type Evidence, type Source } from './evidence'
import { parseReview, REVIEW_SYSTEM } from './ledger'
import { isRecord, type Issue, type Payload } from './tracker'

// kind 'fact' is only read back from holds stored before the facts section was removed; heldClaims settles them unreviewed.
export type Held = { key: string; nonce: string; kind: 'drop' | 'fact'; issue?: string; evidence: Evidence[]; sources: Record<string, Source> }
export type HeldClaim = { held: Extract<Held, { kind: 'drop' }>; issue: Issue; evidence: Evidence[] }
export type HeldClaims = { claims: HeldClaim[]; settled: string[] }
export type Gated = { ops: Payload[]; evidence: Evidence[][] }
export type ReviewInput = {
  ops: readonly Payload[]; evidence: readonly Evidence[][]; issues: readonly Issue[]
  claims: readonly HeldClaim[]; range: { text: string; sources: ReadonlyMap<string, Source> }; ratio: number
}
export type Reviewed = { ops: Payload[]; promoted: Payload[]; hold: Held[]; settled: string[]; failed: boolean }
type HeldLogEvent = 'evidence-rejected' | 'review-dropped' | 'review-failed' | 'review-rejected'
type HeldIo = {
  now: () => Promise<number>
  get: (key: string) => Promise<unknown>
  set: (key: string, value: unknown) => Promise<void>
  delete: (key: string) => Promise<void>
  logEvent: (event: HeldLogEvent, fields: { ratio?: number; reason?: string }) => Promise<void>
  complete: (request: { model: string; system: string; prompt: string; maxTokens: number; timeoutMs: number }) => Promise<{ isAnswered: boolean; text: string; reason: string }>
}
export function isHeld(value: unknown): value is Held {
  if (!isRecord(value)) return false
  const item = value
  return typeof item.key === 'string' && typeof item.nonce === 'string' && (item.kind === 'drop' || item.kind === 'fact')
    && (item.issue === undefined || typeof item.issue === 'string')
    && Array.isArray(item.evidence) && typeof item.sources === 'object' && item.sources !== null && !Array.isArray(item.sources)
}
const token = (held: Pick<Held, 'key' | 'nonce'>) => `${held.key}#${held.nonce}`
const heldKey = (session: string) => `held:${session}`
export const droppedIds = (issues: readonly Issue[]) => new Set(issues.filter(issue => issue.status === 'dropped').map(issue => issue.id))
const reviewMaxTokens = (claims: number) => Math.min(16_384, Math.max(2048, 512 + 100 * claims))
const landsUnreviewed = (op: Payload, dropped: ReadonlySet<string>) =>
  op.op === 'create' || op.op === 'progress' || op.op === 'task' || op.op === 'link'
  || (op.op === 'status' && op.status !== 'dropped' && op.status !== 'question' && !isReopenClaim(op, dropped))
const citedSources = (evidence: readonly Evidence[], sources: ReadonlyMap<string, Source>) =>
  Object.fromEntries(evidence.flatMap(item => { const key = resolveRef(item.ref, sources); return key ? [[item.ref, sources.get(key)!]] : [] }))

export async function readHeld(io: Pick<HeldIo, 'get'>, session: string): Promise<Held[]> {
  const value = await io.get(heldKey(session))
  return Array.isArray(value) ? value.filter(isHeld) : []
}

export async function updateHeld(io: HeldIo, session: string, settled: readonly string[], added: readonly Held[]): Promise<void> {
  if (!settled.length && !added.length) return
  const gone = new Set(settled), keys = new Set(added.map(item => item.key))
  const list = [...(await readHeld(io, session)).filter(item => !gone.has(token(item)) && !keys.has(item.key)), ...added]
  const key = heldKey(session)
  if (list.length) await io.set(key, list)
  else await io.delete(key)
}

async function heldDrop(io: HeldIo, issue: string, evidence: Evidence[], sources: Record<string, Source>): Promise<Held> {
  return { key: `drop:${issue}`, nonce: `${await io.now()}-${Math.random().toString(36).slice(2, 10)}`, kind: 'drop', issue, evidence, sources }
}

export function heldClaims(list: readonly Held[], issues: readonly Issue[], session: string): HeldClaims {
  const claims: HeldClaim[] = [], settled: string[] = []
  for (const item of list) {
    if (item.kind === 'fact') { settled.push(token(item)); continue }
    const checked = checkEvidence(item.evidence, new Map(Object.entries(item.sources)), ['user'])
    const issue = issues.find(candidate => candidate.id === item.issue && candidate.origin.session === session)
    if (!checked.held.length || !issue || issue.status === 'done' || issue.status === 'dropped') settled.push(token(item))
    else claims.push({ held: item, issue, evidence: checked.held })
  }
  return { claims, settled }
}

export async function gateMerge(
  io: Pick<HeldIo, 'logEvent'>, ops: readonly Payload[], evidence: readonly Evidence[][],
  sources: ReadonlyMap<string, Source>, ratio: number, dropped: ReadonlySet<string>, issues: readonly Issue[] = [],
): Promise<Gated> {
  const gated = gateOps(ops, evidence, sources, dropped)
  const rejections = [...gated.rejections]
  const byId = new Map(issues.map(issue => [issue.id, issue]))
  const keep = gated.ops.map(op => !(op.op === 'retitle' && byId.get(byId.get(op.issue)?.parent ?? '')?.planMode))
  const keptOps = gated.ops.filter((_, index) => keep[index])
  const keptEvidence = gated.evidence.filter((_, index) => keep[index])
  if (rejections.length) await io.logEvent('evidence-rejected', { ratio, reason: rejections.join(' | ').slice(0, 2000) })
  return { ops: keptOps, evidence: keptEvidence }
}

export async function reviewFold(io: HeldIo, opts: { reviewModel: string }, input: ReviewInput): Promise<Reviewed> {
  const title = (id: string) => input.issues.find(issue => issue.id === id)?.title
  const withSource = (claim: HeldClaim) => Object.fromEntries(claim.evidence.map(item => [item.ref, claim.held.sources[item.ref]?.text ?? '']))
  const claims = [
    ...input.ops.map((op, index) => ({ id: `op${index + 1}`, claim: describeOp(op, 'issue' in op ? title(op.issue) : undefined), evidence: input.evidence[index] ?? [] })),
    ...input.claims.map((claim, index) => ({ id: `drop${index + 1}`, claim: describeOp({ op: 'status', issue: claim.issue.id, status: 'dropped' }, claim.issue.title), evidence: claim.evidence, source: withSource(claim) })),
  ]
  let review
  try {
    const response = await io.complete({
      model: opts.reviewModel,
      system: REVIEW_SYSTEM,
      prompt: [
        `<claims>\n${claims.map(claim => JSON.stringify(claim)).join('\n') || '(none)'}\n</claims>`,
        `<folded_range>\n${input.range.text}\n</folded_range>`,
      ].join('\n\n'),
      maxTokens: reviewMaxTokens(claims.length),
      timeoutMs: 60_000,
    })
    review = response.isAnswered ? parseReview(response.text) : `review model gave no text (${response.reason})`
  } catch (err) {
    review = `review call failed (${String(err).slice(0, 120)})`
  }
  if (typeof review === 'string') {
    const dones = input.ops.filter(isDoneClaim).length
    const dropped = droppedIds(input.issues)
    const refused = input.ops.filter(op => !landsUnreviewed(op, dropped) && !isDropClaim(op))
    const hold: Held[] = []
    for (const [index, op] of input.ops.entries()) if (op.op === 'status' && isDropClaim(op)) hold.push(await heldDrop(io, op.issue, input.evidence[index] ?? [], citedSources(input.evidence[index] ?? [], input.range.sources)))
    const drops = hold.length
    await io.logEvent('review-failed', { ratio: input.ratio, reason: `${review}; ${dones} done(s) held for the user's confirmation, ${refused.length} unreviewed op(s) dropped${refused.length ? ` (${refused.map(op => describeOp(op)).join('; ')})` : ''}, ${drops} drop(s) held, ${input.claims.length} held claim(s) held for the next fold`.slice(0, 2000) })
    return { ops: input.ops.filter(op => landsUnreviewed(op, dropped)).flatMap(op => isDoneClaim(op) ? withhold(op) : [op]), promoted: [], hold, settled: [], failed: true }
  }
  const verdict = new Map(review.map(item => [item.id, item]))
  const lines: string[] = []
  const ops = input.ops.flatMap((op, index): Payload[] => {
    const item = verdict.get(`op${index + 1}`)
    if (item?.accept) return [op]
    if (!item && !isDoneClaim(op)) return [op]
    const why = item ? item.reason : 'no verdict'
    lines.push(`op${index + 1} ${describeOp(op)}: ${isDoneClaim(op) ? 'done held for the user\'s confirmation' : 'dropped'} (${why})`)
    return isDoneClaim(op) ? withhold(op) : []
  })
  const promoted: Payload[] = [], settled: string[] = []
  const judge = (id: string, held: Pick<Held, 'key' | 'nonce'>, land: () => void) => {
    const item = verdict.get(id)
    if (!item) return void lines.push(`${id} ${held.key}: still held (no verdict)`)
    settled.push(token(held))
    if (item.accept) land()
    else lines.push(`${id} ${held.key}: settled unaccepted (${item.reason})`)
  }
  input.claims.forEach((claim, index) => judge(`drop${index + 1}`, claim.held, () => promoted.push({ op: 'status', issue: claim.issue.id, status: 'dropped' })))
  if (lines.length) await io.logEvent('review-rejected', { ratio: input.ratio, reason: lines.join(' | ').slice(0, 2000) })
  return { ops, promoted, hold: [], settled, failed: false }
}
