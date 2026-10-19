export type WorktreeIo = {
  home?: () => Promise<string | undefined>
  run: (argv: readonly string[], options: { cwd?: string; timeoutMs: number }) => Promise<{ exitCode: number; stdout: string; stderr: string }>
}

export type Worktree = {
  dir: string
  baseSha: string
  originBranch: string
  repoRoot: string
  worktreesRoot: string
  headSha: string
}

type StartWorktreeInput = {
  repoRoot: string
  sessionId: string
  goalId: string
  worktreesRoot?: string
}

type CommandResult = { exitCode: number; stdout: string; stderr: string }

const COMMAND_TIMEOUT = 30_000

export class WorktreeError extends Error {
  constructor(
    message: string,
    readonly argv: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(`${message}; argv=${JSON.stringify(argv)} exitCode=${exitCode ?? 'unavailable'} stderr=${stderr}`)
    this.name = 'WorktreeError'
  }
}

async function run(io: WorktreeIo, argv: readonly string[], cwd?: string): Promise<CommandResult> {
  let result: CommandResult
  try {
    result = await io.run(argv, { ...(cwd ? { cwd } : {}), timeoutMs: COMMAND_TIMEOUT })
  } catch (error) {
    throw new WorktreeError('command could not complete', argv, null, String(error))
  }
  if (result.exitCode !== 0)
    throw new WorktreeError('command failed', argv, result.exitCode, result.stderr.trim())
  return result
}

async function git(io: WorktreeIo, repoRoot: string, args: readonly string[]): Promise<string> {
  const result = await run(io, ['git', '-C', repoRoot, ...args])
  return result.stdout.trim()
}

function normalizeAbsolutePath(path: string): string | undefined {
  const value = path.replace(/\\/g, '/')
  const drive = /^([A-Za-z]:)(?:\/|$)/.exec(value)?.[1]
  if (!drive && !value.startsWith('/')) return undefined
  const prefix = drive ? `${drive}/` : '/'
  const rest = drive ? value.slice(drive.length + 1) : value.slice(1)
  const parts: string[] = []
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return `${prefix}${parts.join('/')}`
}

function isWithin(root: string, path: string): boolean {
  const prefix = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(prefix) && path !== root
}

function failure(message: string, detail: string): WorktreeError {
  return new WorktreeError(message, [], null, detail)
}

function safeSegment(value: string, name: string): string {
  if (!value || value === '.' || value === '..' || /[\u0000-\u001f\u007f/\\]/.test(value))
    throw failure(`invalid ${name}`, JSON.stringify(value))
  return value
}

function worktreesRootFor(home: string): string {
  const normalizedHome = normalizeAbsolutePath(home)
  if (!normalizedHome) throw failure('HOME must be an absolute path', home)
  return `${normalizedHome.replace(/\/$/, '')}/.claude-work/clm/worktrees`
}

export async function startWorktree(io: WorktreeIo, input: StartWorktreeInput): Promise<Worktree> {
  const session = safeSegment(input.sessionId, 'sessionId')
  const goal = safeSegment(input.goalId, 'goalId')
  const configuredRoot = input.worktreesRoot ?? worktreesRootFor((await io.home?.()) ?? '')
  const root = normalizeAbsolutePath(configuredRoot)
  if (!root) throw failure('worktreesRoot must be an absolute path', configuredRoot)
  const dir = `${root.replace(/\/$/, '')}/${session}/${goal}`
  const normalizedDir = normalizeAbsolutePath(dir)
  if (!normalizedDir || !isWithin(root, normalizedDir))
    throw failure('worktree path escapes its root', `root=${root} dir=${dir}`)

  const originBranch = await git(io, input.repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])
  await git(io, input.repoRoot, ['worktree', 'add', '--detach', dir, 'HEAD'])
  const baseSha = await git(io, dir, ['rev-parse', 'HEAD'])
  return { dir, baseSha, originBranch, repoRoot: input.repoRoot, worktreesRoot: root, headSha: baseSha }
}

export async function checkpointCommit(io: WorktreeIo, worktree: Worktree, stepTitle: string): Promise<string> {
  if (!stepTitle.trim()) throw failure('checkpoint title must not be empty', JSON.stringify(stepTitle))
  await git(io, worktree.dir, ['add', '-A'])
  await git(io, worktree.dir, ['-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', `clm checkpoint: ${stepTitle}`])
  const sha = await git(io, worktree.dir, ['rev-parse', 'HEAD'])
  worktree.headSha = sha
  return sha
}

async function assertOwnedWorktree(io: WorktreeIo, worktree: Worktree): Promise<void> {
  const root = normalizeAbsolutePath(worktree.worktreesRoot)
  const dir = normalizeAbsolutePath(worktree.dir)
  if (!root || !dir || !isWithin(root, dir))
    throw failure('refusing worktree operation outside the worktrees root', `root=${worktree.worktreesRoot} dir=${worktree.dir}`)

  const registeredOutput = await git(io, worktree.repoRoot, ['worktree', 'list', '--porcelain'])
  const resolvedDir = normalizeAbsolutePath(await git(io, worktree.dir, ['rev-parse', '--show-toplevel']))
  const mainDir = normalizeAbsolutePath(await git(io, worktree.repoRoot, ['rev-parse', '--show-toplevel']))
  if (!resolvedDir || !isWithin(root, resolvedDir))
    throw failure('refusing worktree operation whose resolved path is outside the worktrees root', `root=${root} resolvedDir=${resolvedDir ?? 'not absolute'}`)
  if (mainDir && resolvedDir === mainDir)
    throw failure('refusing worktree operation on the shared checkout', `repoRoot=${mainDir} dir=${resolvedDir}`)

  const registered = registeredOutput.split(/\r?\n/)
    .filter(line => line.startsWith('worktree '))
    .map(line => normalizeAbsolutePath(line.slice('worktree '.length)))
  if (!registered.includes(dir) || !registered.includes(resolvedDir))
    throw failure('refusing operation on a path absent from the registered worktree list', `dir=${dir} resolvedDir=${resolvedDir}`)
}

function requireSha(sha: string): string {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha))
    throw failure('invalid commit SHA', JSON.stringify(sha))
  return sha
}

export async function rollbackTo(io: WorktreeIo, worktree: Worktree, sha: string): Promise<void> {
  const targetSha = requireSha(sha)
  await assertOwnedWorktree(io, worktree)
  await git(io, worktree.dir, ['reset', '--hard', targetSha])
  await git(io, worktree.dir, ['clean', '-fd'])
  worktree.headSha = targetSha
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export function landCommands(worktree: Worktree): string[] {
  const range = `${requireSha(worktree.baseSha)}..${requireSha(worktree.headSha)}`
  return [
    `git -C ${shellQuote(worktree.repoRoot)} cherry-pick ${shellQuote(range)}`,
    `git -C ${shellQuote(worktree.repoRoot)} worktree remove ${shellQuote(worktree.dir)}`,
  ]
}

export async function removeWorktree(io: WorktreeIo, worktree: Worktree): Promise<void> {
  await assertOwnedWorktree(io, worktree)
  await git(io, worktree.repoRoot, ['worktree', 'remove', '--force', worktree.dir])
  await git(io, worktree.repoRoot, ['worktree', 'prune'])
}
