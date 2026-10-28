import { test, expect } from 'claude-code/testing'
import { claimIssue, drainMail, pickNext, releaseClaim, revokeClaim, sendMail, shouldSpawn, writeCoworker, type CoworkerIo } from './coworker'

type Filesystem = { files: Map<string, string>; dirs: Set<string> }
let tempSequence = 0
const tempDir = () => `/tmp/clm-coworker-test-${++tempSequence}`
const removeTree = (fs: Filesystem, path: string) => {
  for (const file of [...fs.files.keys()]) if (file === path || file.startsWith(`${path}/`)) fs.files.delete(file)
  for (const dir of [...fs.dirs]) if (dir === path || dir.startsWith(`${path}/`)) fs.dirs.delete(dir)
}
const moveTree = (fs: Filesystem, from: string, to: string) => {
  if (fs.files.has(from)) {
    const value = fs.files.get(from)!
    fs.files.delete(from); fs.files.set(to, value)
    return
  }
  if (!fs.dirs.has(from)) throw new Error('source does not exist')
  for (const dir of [...fs.dirs].filter(dir => dir === from || dir.startsWith(`${from}/`))) {
    fs.dirs.delete(dir); fs.dirs.add(`${to}${dir.slice(from.length)}`)
  }
  for (const [file, value] of [...fs.files].filter(([file]) => file.startsWith(`${from}/`))) {
    fs.files.delete(file); fs.files.set(`${to}${file.slice(from.length)}`, value)
  }
}
function filesystemIo(root: string, fs: Filesystem = { files: new Map(), dirs: new Set() }): CoworkerIo {
  return {
    root,
    read: async path => fs.files.get(path),
    write: async (path, value) => { if (!fs.dirs.has(path.slice(0, path.lastIndexOf('/')))) throw new Error('parent missing'); fs.files.set(path, value) },
    list: async path => [
      ...[...fs.dirs].filter(entry => entry.startsWith(`${path}/`) && !entry.slice(path.length + 1).includes('/')).map(entry => ({ name: entry.slice(path.length + 1), kind: 'dir' })),
      ...[...fs.files.keys()].filter(entry => entry.startsWith(`${path}/`) && !entry.slice(path.length + 1).includes('/')).map(entry => ({ name: entry.slice(path.length + 1), kind: 'file' })),
    ],
    run: async argv => {
      try {
        if (argv[0] === 'mkdir' && argv[1] === '-p') {
          let current = ''; for (const part of argv[2]!.split('/').filter(Boolean)) { current += `/${part}`; fs.dirs.add(current) }
        } else if (argv[0] === 'mkdir') {
          if (fs.dirs.has(argv[1]!)) throw new Error('exists'); fs.dirs.add(argv[1]!)
        } else if (argv[0] === 'mv') moveTree(fs, argv[1]!, argv[2]!)
        else if (argv[0] === 'rm' && argv[1] === '-rf') removeTree(fs, argv[2]!)
        else if (argv[0] === 'rm' && argv[1] === '-f') fs.files.delete(argv[2]!)
        else throw new Error(`unsupported command: ${argv.join(' ')}`)
        return { exitCode: 0, stdout: '', stderr: '' }
      } catch (error) {
        return { exitCode: 1, stdout: '', stderr: String(error) }
      }
    },
  }
}

// Regression caught: racing workers could both believe they owned the same board issue.
test('two concurrent claims of one issue leave exactly one owner', async () => {
  const root = tempDir()
  const fs: Filesystem = { files: new Map(), dirs: new Set() }
  const io = filesystemIo(root, fs)
  await writeCoworker(io, { session: 'worker-a', main: 'main', repo: '/repo', state: 'idle', heartbeat: 100 })
  await writeCoworker(io, { session: 'worker-b', main: 'main', repo: '/repo', state: 'idle', heartbeat: 100 })
  const results = await Promise.all([
    claimIssue(io, { issueId: 'issue-1', session: 'worker-a', now: 100 }),
    claimIssue(io, { issueId: 'issue-1', session: 'worker-b', now: 100 }),
  ])
  expect(results.filter(result => result.claimed)).toHaveLength(1)
  const owner = JSON.parse(fs.files.get(`${root}/claims/issue-1/owner.json`)!) as { session: string }
  expect(['worker-a', 'worker-b']).toContain(owner.session)
})

// Regression caught: a crashed worker's claim could remain locked after its registry heartbeat expired.
test('an expired registry heartbeat lets a live worker reclaim the issue', async () => {
  const root = tempDir()
  const io = filesystemIo(root)
  await writeCoworker(io, { session: 'stale', main: 'main', repo: '/repo', state: 'busy', heartbeat: 10 })
  await writeCoworker(io, { session: 'live', main: 'main', repo: '/repo', state: 'idle', heartbeat: 100 })
  expect(await claimIssue(io, { issueId: 'issue-1', session: 'stale', now: 10 })).toEqual({ claimed: true })
  expect(await claimIssue(io, { issueId: 'issue-1', session: 'live', now: 100, ttlMs: 50 })).toEqual({ claimed: true })
})

// Regression caught: an available worker or a saturated host could trigger an unnecessary extra session.
test('shouldSpawn is false while a live co-worker is idle and false above the load cap', () => {
  const issues = [{ id: 'i1', status: 'todo', ready: true, repo: '/repo', createdAt: 1 }]
  const base = { issues, repo: '/repo', main: 'main', cores: 8, now: 100, ttlMs: 50 }
  expect(shouldSpawn({ ...base, load1: 1, coworkers: [{ session: 'w1', main: 'main', repo: '/repo', state: 'idle', heartbeat: 100 }] })).toBe(false)
  expect(shouldSpawn({ ...base, load1: 6, coworkers: [] })).toBe(false)
  expect(shouldSpawn({ ...base, load1: 5.99, coworkers: [] })).toBe(true)
})

// Regression caught: lexicographic file reads could reorder mail or deliver it repeatedly.
test('mailbox drains each message once in send order', async () => {
  const root = tempDir()
  const io = filesystemIo(root)
  await sendMail(io, { from: 'main', to: 'worker', text: 'first', now: 10 })
  await sendMail(io, { from: 'peer', to: 'worker', text: 'second', now: 20 })
  expect((await drainMail(io, 'worker')).map(message => message.text)).toEqual(['first', 'second'])
  expect(await drainMail(io, 'worker')).toEqual([])
})

// Regression caught: stale claims could block ready work, while a non-owner could release a live claim.
test('only the owner releases a live claim and the orchestrator can revoke it', async () => {
  const root = tempDir()
  const io = filesystemIo(root)
  await writeCoworker(io, { session: 'worker', main: 'main', repo: '/repo', state: 'busy', heartbeat: 100 })
  expect(await claimIssue(io, { issueId: 'i1', session: 'worker', now: 100 })).toEqual({ claimed: true })
  expect(await releaseClaim(io, 'i1', 'intruder')).toBe(false)
  expect(await releaseClaim(io, 'i1', 'worker')).toBe(true)
  expect(await claimIssue(io, { issueId: 'i1', session: 'worker', now: 100 })).toEqual({ claimed: true })
  expect(await revokeClaim(io, 'i1')).toBe(true)
})

// Regression caught: an older low-priority issue could outrank a newer high-priority ready issue.
test('pickNext selects the highest priority ready unclaimed issue in the repo', () => {
  expect(pickNext([
    { id: 'old', status: 'todo', ready: true, priority: 1, repo: '/repo', createdAt: 1 },
    { id: 'high', status: 'todo', ready: true, priority: 3, repo: '/repo', createdAt: 2 },
    { id: 'claimed', status: 'todo', ready: true, priority: 9, claimedBy: 'worker', repo: '/repo', createdAt: 0 },
  ], '/repo')?.id).toBe('high')
})
