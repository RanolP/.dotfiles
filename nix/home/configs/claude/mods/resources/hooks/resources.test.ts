import { test, expect } from 'claude-code/testing'
import { attributeFlights, beginFlight, stopWorkerProcesses, acquireResource, applyResourceAction, consumeResourceNotice, detectOwned, endResources, guardBash, handleResourceTool, profileName, recordDetected, registerResource, releaseResource, resourceKey, resourceLedgerLines, scanShellProcesses, touchResources, turnStartResources, unregisterResource } from './resources'
import { deliveredPath, loadLine, loadNotices, ownerNotices, pressureNotes, shellJobs } from './load'
import { register } from './register'
import { evalNeedle, matchFlights, parseForkLines } from './attribution'
import type { MutexOwner, OwnedResource, ProcessResult, ResourceIo, ResourceSession } from './resources'
import type { ResourceInput } from '../types'

type World = { files: Map<string, string>; dirs: Set<string>; dirMtimes: Map<string, number>; alive: Set<number>; calls: string[][]; writes: string[]; logs: string[]; now: number }
const ROOT = '/home/test/.local/state/claude/resources'
const ownedPath = (session: string) => resourceKey(ROOT, session)
const readSession = (shared: World, session: string): ResourceSession | undefined => {
  const value = shared.files.get(ownedPath(session))
  return value ? JSON.parse(value) as ResourceSession : undefined
}
const writeSession = (shared: World, session: string, value: ResourceSession) => {
  shared.files.set(ownedPath(session), JSON.stringify(value))
  mkdirs(shared, ownedPath(session).slice(0, ownedPath(session).lastIndexOf('/')))
}
const result = (exitCode = 0, stdout = '', stderr = ''): ProcessResult => ({ exitCode, stdout, stderr })
const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('expected a value')
  return value
}
const mkdirs = (world: World, path: string) => {
  let current = ''
  for (const part of path.split('/').filter(Boolean)) {
    current += `/${part}`
    if (!world.dirs.has(current)) world.dirMtimes.set(current, world.now)
    world.dirs.add(current)
  }
}
const removeTree = (world: World, path: string) => {
  world.dirs.delete(path)
  world.dirMtimes.delete(path)
  for (const dir of [...world.dirs]) if (dir.startsWith(`${path}/`)) { world.dirs.delete(dir); world.dirMtimes.delete(dir) }
  for (const file of [...world.files.keys()]) if (file === path || file.startsWith(`${path}/`)) world.files.delete(file)
}
const moveTree = (world: World, from: string, to: string) => {
  for (const dir of [...world.dirs].filter(dir => dir === from || dir.startsWith(`${from}/`))) {
    world.dirs.delete(dir)
    const moved = `${to}${dir.slice(from.length)}`
    world.dirs.add(moved)
    const mtime = world.dirMtimes.get(dir)
    if (mtime !== undefined) world.dirMtimes.set(moved, mtime)
    world.dirMtimes.delete(dir)
  }
  for (const [file, value] of [...world.files]) if (file === from || file.startsWith(`${from}/`)) {
    world.files.delete(file)
    world.files.set(`${to}${file.slice(from.length)}`, value)
  }
}
const world = (): World => ({ files: new Map(), dirs: new Set(), dirMtimes: new Map(), alive: new Set([101, 202, 303]), calls: [], writes: [], logs: [], now: Date.parse('2026-10-16T00:00:00Z') })
function ioFor(shared: World, session: string, processPid = 101, cwd = '/work/repo', profile = 'default'): ResourceIo {
  return {
    sessionId: async () => session,
    home: async () => '/home/test',
    configDir: async () => profile === 'default' ? undefined : `/Users/test/.claude-${profile}`,
    cwd: async () => cwd,
    repo: async () => '/work/repo',
    now: async () => shared.now,
    exists: async path => shared.dirs.has(path) || shared.files.has(path),
    list: async path => [
      ...[...shared.dirs].filter(dir => dir.startsWith(`${path}/`) && !dir.slice(path.length + 1).includes('/')).map(dir => ({ name: dir.slice(path.length + 1), kind: 'dir', mtimeMs: shared.dirMtimes.get(dir) })),
      ...[...shared.files.keys()].filter(file => file.startsWith(`${path}/`) && !file.slice(path.length + 1).includes('/')).map(file => ({ name: file.slice(path.length + 1), kind: 'file', mtimeMs: shared.now })),
    ],
    read: async path => shared.files.get(path),
    write: async (path, value) => {
      const parent = path.slice(0, path.lastIndexOf('/'))
      if (!shared.dirs.has(parent)) throw new Error(`parent directory does not exist: ${parent}`)
      shared.writes.push(path)
      shared.files.set(path, value)
      shared.dirMtimes.set(parent, shared.now)
    },
    run: async (argv): Promise<ProcessResult> => {
      shared.calls.push([...argv])
      if (argv[0] === 'sh') return result(0, `${processPid}\n`)
      if (argv[0] === '/bin/ps') return result(0, 'claude --test\n')
      if (argv[0] === '/bin/kill' && argv[1] === '-0') return shared.alive.has(Number(argv[2])) ? result() : result(1, '', 'No such process')
      if (argv[0] === 'mkdir' && argv[1] === '-p') { mkdirs(shared, must(argv[2])); return result() }
      if (argv[0] === 'mkdir') {
        const path = must(argv[1])
        if (shared.dirs.has(path)) return result(1, '', 'File exists')
        shared.dirs.add(path)
        shared.dirMtimes.set(path, shared.now)
        return result()
      }
      if (argv[0] === 'mv') {
        const from = must(argv[1])
        if (!shared.dirs.has(from)) return result(1, '', 'No such file or directory')
        moveTree(shared, from, must(argv[2]))
        return result()
      }
      if (argv[0] === 'rm' && argv[1] === '-f') { shared.files.delete(must(argv[2])); return result() }
      if (argv[0] === 'rm' && argv[1] === '-rf') { removeTree(shared, must(argv[2])); return result() }
      if (argv[0] === 'rmdir') { const path = must(argv[1]); shared.dirs.delete(path); shared.dirMtimes.delete(path); return result() }
      if (argv[0] === 'lsof') return result(0, '333\n')
      return result()
    },
    log: text => { shared.logs.push(text) },
    budgetRemaining: () => Infinity,
  }
}
const mutexInput = (name: string, aliases: string[] = []): ResourceInput => ({ action: 'register', kind: 'mutex', name, aliases, description: 'shared test resource' })

// Regression caught: emulator starts must retain the AVD name used to find its adb serial at cleanup.
test('regression: Android emulator detection records the AVD name after a successful start', async () => {
  const detected = detectOwned('emulator -avd "Pixel_9_API_35"', { result: { exitCode: 0, stdout: '', stderr: '', backgroundTaskId: 'bg1' } }, '/work/repo', Date.parse('2026-10-16T00:00:00Z'))
  expect(detected).toEqual([{ kind: 'android-emulator', id: 'avd:Pixel_9_API_35', label: 'Pixel_9_API_35', profile: 'default', cwd: '/work/repo', startedAt: '2026-10-16T00:00:00.000Z', backgroundTaskId: 'bg1' }])
  expect(detectOwned('emulator -avd Pixel', { isError: true, result: { stdout: '' } }, '/work/repo', 1)).toEqual([])
})

// Regression caught: a successful simctl boot must leave the exact UDID available for shutdown.
test('regression: iOS simulator detection records the booted UDID', async () => {
  expect(detectOwned('xcrun simctl boot 1234-ABCD', { result: { exitCode: 0, stdout: '' } }, '/work/repo', 1)[0]?.id).toBe('1234-ABCD')
  expect(detectOwned('xcrun simctl boot 1234-ABCD', { result: { exitCode: 0, interrupted: true } }, '/work/repo', 1)).toEqual([])
})

// Regression caught: Metro's implicit port and explicit --port must both be represented correctly.
test('regression: Metro detection defaults to 8081 and keeps an explicit port', async () => {
  expect(detectOwned('npx expo start', { result: { exitCode: 0, stdout: '' } }, '/work/repo', 1)[0]?.id).toBe('8081')
  expect(detectOwned('npx react-native start --port 8099', { result: { exitCode: 0, stdout: '' } }, '/work/repo', 1)[0]?.id).toBe('8099')
  expect(detectOwned('FOO=1 sudo command pnpm exec expo start --port 8123', { result: { exitCode: 0, stdout: '' } }, '/work/repo', 1)[0]?.id).toBe('8123')
  expect(detectOwned('grep metro package.json', { result: { exitCode: 0, stdout: '' } }, '/work/repo', 1)).toEqual([])
})

// Regression caught: launch-like words inside search and commit arguments must not create owned servers or PRs.
test('regression: detection ignores launch strings inside search patterns and commit messages', () => {
  const commands = [
    'rg "react-native start" package.json',
    'git commit -m "run expo start"',
    'rg vite docs/',
    'echo "gh pr create"',
  ]
  for (const command of commands) expect(detectOwned(command, { result: { exitCode: 0, stdout: 'http://localhost:4173 https://github.com/acme/app/pull/42' } }, '/work/repo', 1)).toEqual([])
})

// Regression caught: web servers without a URL port cannot be cleaned up safely by a guessed port.
test('regression: web dev detection uses the port printed in the successful start output', async () => {
  expect(detectOwned('pnpm run dev', { result: { exitCode: 0, stdout: 'Local: http://localhost:4173/' } }, '/work/repo', 1)[0]?.id).toBe('4173')
  expect(detectOwned('vite', { result: { exitCode: 0, stdout: 'ready' } }, '/work/repo', 1)).toEqual([])
})

// Regression caught: a successful PR command must keep GitHub's URL as its resource identity.
test('regression: PR detection records the URL emitted by gh pr create', async () => {
  expect(detectOwned('gh pr create --fill', { result: { exitCode: 0, stdout: 'https://github.com/acme/app/pull/42\n' } }, '/work/repo', 1)[0]?.id).toBe('https://github.com/acme/app/pull/42')
})

// Regression caught: two sessions could both use a registered mutex because the registry lacked an atomic owner directory.
test('regression: a live mutex borrower denies another session and names its location and start time', async () => {
  const shared = world()
  const first = ioFor(shared, 's1', 101)
  const second = ioFor(shared, 's2', 202, '/work/other')
  expect(await registerResource(first, mutexInput('iPad Pro', ['ipad'] ))).toEqual({ result: { registered: 'mutex', name: 'iPad Pro', aliases: ['ipad'] } })
  expect((await acquireResource(first, 'ipad')).result).toMatchObject({ status: 'claimed', borrower: 'default/s1 (/work/repo, since 2026-10-16T00:00:00.000Z)' })
  const denied = await guardBash(second, 'agent-device use ipad')
  expect(denied).toContain('default/s1')
  expect(denied).toContain('/work/repo')
  expect(denied).toContain('since 2026-10-16T00:00:00.000Z')
})

// Regression caught: shared aliases in search patterns, filenames, and commit prose must not reserve or deny a device.
test('regression: search and commit commands neither claim nor deny a mutex alias', async () => {
  const shared = world()
  const holder = ioFor(shared, 'alias-holder', 101)
  const reader = ioFor(shared, 'alias-reader', 202)
  await registerResource(holder, mutexInput('iPad', ['ipad']))
  await acquireResource(holder, 'ipad')
  for (const command of ['rg ipad src', 'rg ipados', 'git commit -m "fix ipad layout"', 'cat ipad-layout.tsx', 'git log --grep ipad', 'fd ipad', 'FOO=1 rg ipad', 'sudo rg ipad']) {
    expect(await guardBash(reader, command)).toBe(undefined)
  }
  const ownerPath = must([...shared.files.keys()].find(path => path.endsWith('/owner/owner.json')))
  const owner = JSON.parse(must(shared.files.get(ownerPath))) as MutexOwner
  expect(owner.session).toBe('alias-holder')
})

// Regression caught: ordinary Bash references to a free mutex alias must not implicitly acquire it.
test('regression: a free alias command is allowed without implicitly claiming the mutex', async () => {
  const shared = world()
  const io = ioFor(shared, 'free-alias')
  await registerResource(io, mutexInput('ipad'))
  expect(await guardBash(io, 'agent-device use ipad')).toBe(undefined)
  expect(shared.files.has(must([...shared.files.keys()].find(path => path.endsWith('/resource.json'))).replace('/resource.json', '/owner/owner.json'))).toBe(false)
  expect(readSession(shared, 'free-alias')?.mutexes).toEqual([])
})

// Regression caught: concurrent reclaimers must not move a fresh owner installed after their stale observation.
test('regression: a second reclaimer that saw a stale owner does not displace the new borrower', async () => {
  const shared = world()
  const stale = ioFor(shared, 'stale-holder', 101)
  const first = ioFor(shared, 'first-reclaimer', 202)
  const second = ioFor(shared, 'second-reclaimer', 303)
  await registerResource(stale, mutexInput('ipad'))
  await acquireResource(stale, 'ipad')
  shared.alive.delete(101)
  const reached = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const originalRun = second.run
  second.run = async (argv, options) => {
    if (argv[0] === 'mkdir' && argv[1]?.endsWith('/reclaim')) {
      reached.resolve()
      await resume.promise
    }
    return originalRun(argv, options)
  }
  const pending = acquireResource(second, 'ipad')
  await reached.promise
  expect((await acquireResource(first, 'ipad')).result).toMatchObject({ status: 'claimed', borrower: 'default/first-reclaimer (/work/repo, since 2026-10-16T00:00:00.000Z)' })
  resume.resolve()
  expect((await pending).deny).toContain('default/first-reclaimer')
  const ownerPath = must([...shared.files.keys()].find(path => path.endsWith('/owner/owner.json')))
  const owner = JSON.parse(must(shared.files.get(ownerPath))) as MutexOwner
  expect(owner.session).toBe('first-reclaimer')
})

// Regression caught: profile-local stores let the same physical device appear free to another ccc profile.
test('regression: a mutex held under ~/.claude-personal stays visible and blocks ~/.claude-work', async () => {
  const shared = world()
  const personal = ioFor(shared, 'sid-personal', 101, '/work/repo', 'personal')
  const work = ioFor(shared, 'sid-work', 202, '/work/repo', 'work')
  await registerResource(personal, mutexInput('iPad', ['ipad']))
  await acquireResource(personal, 'ipad')
  const denied = await guardBash(work, 'agent-device use ipad')
  expect(denied).toContain('personal/sid-personal')
  const holder = 'personal/sid-personal (/work/repo, since 2026-10-16T00:00:00.000Z)'
  expect((await applyResourceAction(work, { action: 'who', name: 'ipad' })).result).toMatchObject({ borrower: holder })
  expect((await applyResourceAction(work, { action: 'list' })).result).toMatchObject({ mutexes: [{ borrower: holder, owner: { profile: 'personal', session: 'sid-personal' } }] })
  expect(await profileName('/Users/test/.claude-personal')).toBe('personal')
  expect(await profileName('/Users/test/.claude-work')).toBe('work')
})

// Regression caught: a crashed holder could strand a mutex forever after its heartbeat or PID stopped proving life.
test('regression: a dead mutex holder is reclaimed before a new session acquires it', async () => {
  const shared = world()
  const first = ioFor(shared, 's1', 101)
  const second = ioFor(shared, 's2', 202)
  await registerResource(first, mutexInput('ipad'))
  await acquireResource(first, 'ipad')
  shared.alive.delete(101)
  expect((await acquireResource(second, 'ipad')).result).toMatchObject({ status: 'claimed', borrower: 'default/s2 (/work/repo, since 2026-10-16T00:00:00.000Z)' })
  expect(shared.logs.some(line => line.includes('reclaimed ipad from dead session s1'))).toBe(true)
})

// Regression caught: abandoned owner and reclaim directories must expire, while a fresh incomplete owner stays locked.
test('regression: stale empty owner and reclaim locks expire but a young empty owner is transiently denied', async () => {
  const shared = world()
  const io = ioFor(shared, 'stale-lock-user')
  await registerResource(io, mutexInput('ipad'))
  const registry = must([...shared.files.keys()].find(path => path.endsWith('/resource.json'))).replace(/\/resource\.json$/, '')
  const oldOwner = `${registry}/owner`
  const oldReclaim = `${registry}/reclaim`
  shared.dirs.add(oldOwner)
  shared.dirMtimes.set(oldOwner, shared.now - 31_000)
  shared.dirs.add(oldReclaim)
  shared.dirMtimes.set(oldReclaim, shared.now - 31_000)
  expect((await acquireResource(io, 'ipad')).result).toMatchObject({ status: 'claimed' })
  expect(shared.dirs.has(`${registry}/reclaim`)).toBe(false)
  await releaseResource(io, 'ipad')

  await registerResource(io, mutexInput('ipad-unregister'))
  const unregisterRegistry = must([...shared.files.keys()].find(path => path.endsWith('/resource.json') && path.includes('ipad-unregister'))).replace(/\/resource\.json$/, '')
  const staleUnregisterOwner = `${unregisterRegistry}/owner`
  shared.dirs.add(staleUnregisterOwner)
  shared.dirMtimes.set(staleUnregisterOwner, shared.now - 31_000)
  expect(await unregisterResource(io, 'ipad-unregister')).toMatchObject({ result: { status: 'unregistered' } })

  await registerResource(io, mutexInput('young-lock'))
  const youngRegistry = must([...shared.files.keys()].find(path => path.endsWith('/resource.json') && path.includes('young-lock'))).replace(/\/resource\.json$/, '')
  const youngOwner = `${youngRegistry}/owner`
  shared.dirs.add(youngOwner)
  shared.dirMtimes.set(youngOwner, shared.now - 10_000)
  expect((await acquireResource(io, 'young-lock')).deny).toContain('could not claim')
})

// Regression caught: empty sessions should incur no recurring process spawn or file write for resource heartbeats.
test('regression: ten empty-session tool calls perform zero resource writes and spawns', async () => {
  const shared = world()
  const io = ioFor(shared, 'empty-tool-session')
  for (let call = 0; call < 10; call++) await touchResources(io)
  expect(shared.writes).toEqual([])
  expect(shared.calls).toEqual([])

  await registerResource(io, { action: 'register', kind: 'owned', name: 'local api' })
  shared.calls.length = 0
  shared.writes.length = 0
  for (let call = 0; call < 10; call++) await touchResources(io)
  expect(shared.writes).toHaveLength(1)
  expect(shared.calls).toEqual([])
  shared.now += 60_000
  await touchResources(io)
  expect(shared.writes).toHaveLength(2)
  expect(shared.calls).toEqual([])
})

// Regression caught: a resumed process must probe its own PID instead of trusting the previous process PID in its session file.
test('regression: a resumed process replaces a persisted dead PID with its current process identity', async () => {
  const shared = world()
  const setup = ioFor(shared, 'identity-setup', 101)
  const resumed = ioFor(shared, 'resume-process-unique', 202)
  await registerResource(setup, mutexInput('ipad'))
  const registry = must([...shared.files.keys()].find(path => path.endsWith('/resource.json'))).replace(/\/resource\.json$/, '')
  shared.dirs.add(`${registry}/owner`)
  shared.files.set(`${registry}/owner/owner.json`, JSON.stringify({ session: 'resume-process-unique', profile: 'default', pid: 101, cwd: '/work/repo', repo: '/work/repo', since: '2026-10-15T00:00:00.000Z', heartbeat: shared.now } satisfies MutexOwner))
  shared.files.set(ownedPath('resume-process-unique'), JSON.stringify({ profile: 'default', owned: [], mutexes: ['ipad'], changes: [], identity: { processPid: 101, pid: 101, profile: 'default', cwd: '/work/repo', repo: '/work/repo', heartbeat: shared.now, probedAt: shared.now } }))
  mkdirs(shared, `${ROOT}/owned`)
  expect((await acquireResource(resumed, 'ipad')).result).toMatchObject({ status: 'held' })
  const stored = must(readSession(shared, 'resume-process-unique'))
  expect(stored.identity).toEqual({ cwd: '/work/repo', repo: '/work/repo', heartbeat: shared.now, pid: 202, processCommand: 'claude --test' })
  const owner = JSON.parse(must(shared.files.get(`${registry}/owner/owner.json`))) as MutexOwner
  expect(owner.pid).toBe(202)
})

// Regression caught: an idle but live peer process must keep its shared owned resource from cleanup.
test('regression: a live peer PID remains a resource reference after a two-hour idle heartbeat', async () => {
  const shared = world()
  const current = ioFor(shared, 'ending-session', 202)
  const resource: OwnedResource = { kind: 'web-dev', id: '4173', label: ':4173', profile: 'default', cwd: '/work/repo', startedAt: '2026-10-16T00:00:00.000Z' }
  writeSession(shared, 'ending-session', { profile: 'default', owned: [resource], mutexes: [], changes: [], identity: { cwd: '/work/repo', repo: '/work/repo', heartbeat: shared.now, pid: 202, processCommand: 'claude --test' } })
  writeSession(shared, 'idle-peer', { profile: 'personal', owned: [{ ...resource, profile: 'personal' }], mutexes: [], changes: [], identity: { cwd: '/work/repo', repo: '/work/repo', heartbeat: shared.now - 2 * 60 * 60 * 1000, pid: 303, processCommand: 'claude --test' } })
  await endResources(current, 'ending-session', 'prompt_input_exit')
  expect(shared.calls).toContainEqual(['/bin/kill', '-0', '303'])
  expect(shared.calls.some(argv => argv[0] === 'lsof')).toBe(false)
  expect(shared.files.has(ownedPath('ending-session'))).toBe(false)
  expect(shared.files.has(ownedPath('idle-peer'))).toBe(true)
})

// Regression caught: the resource tool exposed registration without a working list, who, release, unregister, and forget path.
test('regression: every resource tool action updates and reports the current session state', async () => {
  const shared = world()
  const io = ioFor(shared, 's1')
  await applyResourceAction(io, { action: 'register', kind: 'owned', name: 'test server' })
  await applyResourceAction(io, mutexInput('ipad'))
  await applyResourceAction(io, { action: 'acquire', name: 'ipad' })
  expect(await applyResourceAction(io, { action: 'list' })).toMatchObject({ result: { owned: [{ id: 'test server', profile: 'default' }], mutexes: [{ name: 'ipad', borrower: 'default/s1 (/work/repo, since 2026-10-16T00:00:00.000Z)', owner: { session: 's1', profile: 'default' } }] } })
  expect(await applyResourceAction(io, { action: 'who', name: 'ipad' })).toMatchObject({ result: { borrower: 'default/s1 (/work/repo, since 2026-10-16T00:00:00.000Z)' } })
  expect(await applyResourceAction(io, { action: 'release', name: 'ipad' })).toMatchObject({ result: { status: 'released' } })
  expect(await applyResourceAction(io, { action: 'unregister', name: 'ipad' })).toMatchObject({ result: { status: 'unregistered' } })
  expect(await applyResourceAction(io, { action: 'forget', name: 'test server' })).toMatchObject({ result: { forgotten: 'test server' } })
})

// Regression caught: /clear and resume change the session id without session.start, which otherwise loses ownership.
test('regression: clear and resume transfer from the shared owned directory without $.store', async () => {
  for (const reason of ['clear', 'resume']) {
    const shared = world()
    const old = ioFor(shared, 'old', 101)
    const next = ioFor(shared, 'new', 101)
    await registerResource(old, { action: 'register', kind: 'owned', name: 'local api' })
    await registerResource(old, mutexInput('ipad'))
    await acquireResource(old, 'ipad')
    const prior = must(readSession(shared, 'old'))
    writeSession(shared, 'old', {
      ...prior,
      owned: [...prior.owned, { kind: 'ios-simulator', id: '1234-ABCD', label: 'iPad simulator', profile: 'default', cwd: '/work/repo', startedAt: '2026-10-16T00:00:00.000Z' }],
    } satisfies ResourceSession)
    await endResources(old, 'old', reason)
    expect(readSession(shared, 'old')?.pendingTransfer).toBe(true)
    expect([...shared.files.keys()].some(path => path === ownedPath('old'))).toBe(true)
    await turnStartResources(next)
    const moved = must(readSession(shared, 'new'))
    expect(moved.owned.map(resource => resource.id)).toEqual(['local api', '1234-ABCD'])
    expect(moved.mutexes).toEqual(['ipad'])
    const registeredPath = must([...shared.files.keys()].find(path => path.endsWith('/resource.json')))
    const registered = JSON.parse(must(shared.files.get(registeredPath))) as { name: string }
    const mutexOwnerPath = must([...shared.files.keys()].find(path => path.endsWith('/owner/owner.json')))
    expect((JSON.parse(must(shared.files.get(mutexOwnerPath))) as MutexOwner).session).toBe('new')
    expect(registered.name).toBe('ipad')
    await endResources(next, 'new', 'logout')
    expect(shared.calls.some(argv => argv[0] === 'xcrun' && argv.at(-1) === '1234-ABCD')).toBe(true)
    expect(readSession(shared, 'new')?.owned).toEqual([])
  }
})

// Regression caught: a pending source must not re-transfer forgotten resources on each later turn.
test('regression: clear transfer source is removed so a forgotten resource stays gone on the next turn', async () => {
  const shared = world()
  const old = ioFor(shared, 'old-session', 101)
  const next = ioFor(shared, 'new-session', 101)
  await recordDetected(old, [{ kind: 'metro', id: '8081', label: ':8081', profile: 'default', cwd: '/work/repo', startedAt: '2026-10-16T00:00:00.000Z' }])
  await endResources(old, 'old-session', 'clear')
  await turnStartResources(next)
  expect(readSession(shared, 'new-session')?.owned.map(item => item.id)).toEqual(['8081'])
  expect(await applyResourceAction(next, { action: 'forget', name: '8081' })).toMatchObject({ result: { forgotten: '8081' } })
  await turnStartResources(next)
  expect(readSession(shared, 'new-session')?.owned).toEqual([])
  expect(shared.files.has(ownedPath('old-session'))).toBe(false)
})

// Regression caught: a dead session's pending transfer record must not keep a shared port alive forever.
test('regression: session end deletes dead pending-transfer references before stopping a resource', async () => {
  const shared = world()
  const current = ioFor(shared, 'end-with-stale-reference', 202)
  const resource: ResourceSession = {
    profile: 'default', owned: [{ kind: 'web-dev', id: '4173', label: ':4173', profile: 'default', cwd: '/work/repo', startedAt: '2026-10-16T00:00:00.000Z' }], mutexes: [], changes: [],
  }
  writeSession(shared, 'end-with-stale-reference', resource)
  writeSession(shared, 'dead-pending-reference', {
    profile: 'personal', owned: [{ ...must(resource.owned[0]), profile: 'personal' }], mutexes: [], changes: [], pendingTransfer: true,
    identity: { cwd: '/work/repo', repo: '/work/repo', heartbeat: shared.now - 60 * 60 * 1000 - 1 },
  })
  await endResources(current, 'end-with-stale-reference', 'prompt_input_exit')
  expect(shared.files.has(ownedPath('dead-pending-reference'))).toBe(false)
  expect(shared.calls).toContainEqual(['lsof', '-nP', '-iTCP:4173', '-sTCP:LISTEN', '-t'])
  expect(shared.calls).toContainEqual(['/bin/kill', '333'])
})

// Regression caught: a missing HOME or unwritable session file must not deny unrelated or unverifiable Bash commands.
test('regression: resource setup failures allow Bash and create owned parents before writes', async () => {
  const shared = world()
  const io = ioFor(shared, 'mkdir-before-write', 101)
  expect(await registerResource(io, { action: 'register', kind: 'owned', name: 'local api' })).toMatchObject({ result: { registered: 'owned' } })
  expect(shared.calls).toContainEqual(['mkdir', '-p', `${ROOT}/owned`])
  const missingHome: ResourceIo = { ...io, home: async () => undefined }
  expect(await guardBash(missingHome, 'agent-device use ipad')).toBe(undefined)
  await registerResource(io, mutexInput('ipad'))
  const brokenWrite: ResourceIo = { ...ioFor(shared, 'broken-identity', 202), write: async () => { throw new Error('write unavailable') } }
  expect(await guardBash(brokenWrite, 'agent-device use ipad')).toBe(undefined)
})

// Regression caught: malformed MCP input must be rejected before it reaches resource actions.
test('regression: malformed resource input is denied by the runtime type guard', async () => {
  const shared = world()
  expect(await handleResourceTool(ioFor(shared, 'bad-tool-input'), { action: 'acquire', name: 42 })).toMatchObject({ deny: 'resource requires a valid action and resource fields.' })
})

// Regression caught: resources must be wired by the resources entry point without importing it back from the resource module.
test('regression: the resources entry point registers resource hooks without an import cycle', () => {
  const calls: unknown[][] = []
  const on: Parameters<typeof register>[0] = ((...args: unknown[]) => { calls.push(args); return undefined }) as Parameters<typeof register>[0]
  register(on, {})
  expect(calls.some(call => call[0] === 'tool.call' && (call[1] as { tool?: string } | undefined)?.tool === 'mcp__resources__resource')).toBe(true)
})

// Regression caught: ending one profile must keep resources referenced by owned records from every other profile.
test('regression: session end scans every profile before stopping a shared resource', async () => {
  const shared = world()
  const current = ioFor(shared, 's1')
  await registerResource(current, mutexInput('ipad'))
  await acquireResource(current, 'ipad')
  const owned = [
    { kind: 'ios-simulator' as const, id: 'shared-udid', label: 'shared-udid', profile: 'default', cwd: '/work/repo', startedAt: '2026-10-16T00:00:00.000Z' },
    { kind: 'metro' as const, id: '8081', label: ':8081', profile: 'default', cwd: '/work/repo', startedAt: '2026-10-16T00:00:00.000Z' },
  ]
  writeSession(shared, 's1', { profile: 'default', owned, mutexes: ['ipad'], changes: [], identity: { pid: 101, processCommand: 'claude --test', cwd: '/work/repo', repo: '/work/repo', heartbeat: shared.now } })
  writeSession(shared, 's2', { profile: 'personal', owned: [{ ...must(owned[0]), profile: 'personal' }], mutexes: [], changes: [], identity: { cwd: '/work/repo', repo: '/work/repo', heartbeat: shared.now } })
  await endResources(current, 's1', 'prompt_input_exit')
  expect(shared.calls.some(argv => argv[0] === 'xcrun' && argv.at(-1) === 'shared-udid')).toBe(false)
  expect(shared.calls.some(argv => argv[0] === '/bin/kill' && argv[1] === '333')).toBe(true)
  expect(shared.calls).toContainEqual(['lsof', '-nP', '-iTCP:8081', '-sTCP:LISTEN', '-t'])
  const registry = must([...shared.files.keys()].find(path => path.endsWith('/resource.json'))).replace(/\/resource\.json$/, '')
  expect(shared.files.has(`${registry}/owner/owner.json`)).toBe(false)
  expect(readSession(shared, 's1')).toBe(undefined)
})

// Regression caught: resource changes were either injected on every prompt or missed on the next user turn.
test('regression: resource changes become one prompt notice on the next turn only', async () => {
  const shared = world()
  const io = ioFor(shared, 's1')
  writeSession(shared, 's1', { profile: 'default', owned: [], mutexes: [], changes: ['+metro :8081'] } satisfies ResourceSession)
  expect(await consumeResourceNotice(io)).toBe(undefined)
  await turnStartResources(io)
  expect(await consumeResourceNotice(io)).toBe('resources: +metro :8081')
  expect(await consumeResourceNotice(io)).toBe(undefined)
  writeSession(shared, 's1', { profile: 'default', owned: [], mutexes: ['ipad'], changes: ['mutex ipad held'] } satisfies ResourceSession)
  expect(await consumeResourceNotice(io)).toBe(undefined)
  await turnStartResources(io)
  expect(await consumeResourceNotice(io)).toBe('resources: mutex ipad held')
  expect(resourceLedgerLines({
    owned: [{ kind: 'metro', id: '8081', label: ':8081', profile: 'default', cwd: '/work/repo', startedAt: '2026-10-16T00:00:00.000Z' }],
    mutexes: ['ipad'], changes: [],
  })).toEqual(['- metro :8081', '- mutex ipad held'])
})

const stoppedJob = { id: '7@t', pid: 7, command: 'ipsw dyld xref', rss_mb: 900, pressure: 2, pressure_name: 'warn', stopped_at: 't', resume_policy: 'P', resumed_at: null, session_id: 'A' }

test('regression: another session must not see a watchdog stop', () => {
  expect(ownerNotices([stoppedJob], 'B', new Set())).toEqual({ notes: [], keys: [] })
})
test('regression: a watchdog stop is delivered once with its original explanation', () => {
  const first = ownerNotices([stoppedJob], 'A', new Set())
  expect(first.keys).toEqual(['7@t:stop'])
  expect(first.notes[0]).toContain('pid 7 (900 MB, ipsw dyld xref)')
  expect(first.notes[0]).toContain('warn (level 2). Resume: P.')
  expect(ownerNotices([stoppedJob], 'A', new Set(first.keys))).toEqual({ notes: [], keys: [] })
})
test('regression: a watchdog resume is delivered after its stop', () => {
  const resumed = ownerNotices([{ ...stoppedJob, resumed_at: 'u', resumed_by: 'watchdog' }], 'A', new Set(['7@t:stop']))
  expect(resumed.keys).toEqual(['7@t:resume'])
  expect(resumed.notes[0]).toContain('resumed (SIGCONT) pid 7 (ipsw dyld xref) at u.')
})
test('regression: an unowned watchdog stop goes to nobody', () => {
  expect(ownerNotices([{ ...stoppedJob, session_id: null }], '', new Set())).toEqual({ notes: [], keys: [] })
})
test('regression: bad session ids cannot escape the watchdog delivery directory', () => {
  expect(deliveredPath('/home/test', '../x')).toBeUndefined()
  expect(deliveredPath('/home/test', 'A')).toBe('/home/test/.cache/claude-resource-watchdog/delivered/A.json')
})
const processTree = `101 1 100 S claude --test
110 101 100 S /bin/zsh -c job
111 110 204800 S heavy job
120 101 100 S codex bridge
121 120 100 S bridge-worker
202 1 100 S claude --other
210 202 100 S bash -c other
211 210 500000 S other-job`
test('regression 2026-11-23: shell jobs belong to this agent and the codex bridge stays infrastructure', () => {
  expect(shellJobs(processTree, 101).map(p => p.pid)).toEqual([111])
})
test('regression: vanished and reused process pids are replaced using their start identity', async () => {
  const shared = world()
  writeSession(shared, 'process-scan', { profile: 'default', owned: [{ kind: 'process', id: 'pid:111@old start', pid: 111, label: 'old job', profile: 'default', cwd: '/work/repo', startedAt: 'old start' }], mutexes: [], changes: [] })
  const io = ioFor(shared, 'process-scan')
  const originalRun = io.run
  io.run = async (argv, options) => argv[1] === '-axo' ? result(0, processTree) : argv.includes('lstart=') ? result(0, 'new start') : originalRun(argv, options)
  await scanShellProcesses(io)
  expect(readSession(shared, 'process-scan')?.owned[0]?.id).toBe('pid:111@new start')
  expect(resourceLedgerLines(readSession(shared, 'process-scan')).join(' ')).toContain('heavy job')
  const listed = await applyResourceAction(io, { action: 'list' })
  expect(JSON.stringify(listed)).toContain('heavy job')
  io.run = async (argv, options) => argv[1] === '-axo' ? result(0, '101 1 100 S claude --test') : originalRun(argv, options)
  await scanShellProcesses(io)
  expect(readSession(shared, 'process-scan')?.owned).toEqual([])
})
test('regression: endResources leaves detected processes running', async () => {
  const shared = world()
  writeSession(shared, 'process-end', { profile: 'default', owned: [{ kind: 'process', id: 'pid:111@t', pid: 111, rss: 204800, label: 'heavy job', profile: 'default', cwd: '/work/repo', startedAt: 't' }], mutexes: [], changes: [] })
  await endResources(ioFor(shared, 'process-end'), 'process-end', 'logout')
  expect(shared.calls.some(argv => argv[0] === '/bin/kill' && argv[1] === '111')).toBe(false)
  expect(shared.calls.some(argv => argv[0] === 'lsof')).toBe(false)
  expect(readSession(shared, 'process-end')?.owned[0]?.kind).toBe('process')
})
test('regression: high pressure names stop candidates in descending RSS order', () => {
  const base = { profile: 'default', cwd: '/work/repo', startedAt: 't' }
  const notes = pressureNotes(4, 9, 8, [
    { ...base, kind: 'process', id: 'pid:1@t', pid: 1, rss: 1024, label: 'small' },
    { ...base, kind: 'metro', id: '8081', label: ':8081' },
    { ...base, kind: 'process', id: 'pid:2@t', pid: 2, rss: 2048, label: 'large' },
  ])
  expect(notes[2]).toBe('pid 2 2 MB large (started by main)\npid 1 1 MB small (started by main)\nmetro :8081\nstop the ones you no longer need and hold off on new heavy jobs until this clears; tell the user what you stopped.')
})
test('regression: prompt load uses the 0.8 per-core threshold; renice sets 15 absolutely (renice -n increments, which pushed claude to nice 20)', async () => {
  const shared = world()
  const io = ioFor(shared, 'load-test')
  let niceValue = '19'
  const originalRun = io.run
  io.run = async (argv, options) => {
    if (argv.includes('vm.loadavg')) return result(0, '{ 6.4 2 1 }')
    if (argv.includes('hw.ncpu')) return result(0, '8')
    if (argv.includes('nice=')) return result(0, niceValue)
    return originalRun(argv, options)
  }
  expect(await loadLine(io)).toBe('load 6.4/8 cores (high)')
  await loadNotices(io, 101, [])
  expect(shared.calls.some(c => c[0] === 'renice')).toBe(false)
  niceValue = '0'
  await loadNotices(io, 101, [])
  expect(shared.calls).toContainEqual(['renice', '15', '-p', '101'])
})

test('regression: a watchdog delivery file survives subsequent Bash calls without repeating notices', async () => {
  const shared = world()
  const io = ioFor(shared, 'A')
  shared.files.set('/home/test/.cache/claude-resource-watchdog/stopped.json', JSON.stringify([stoppedJob]))
  const originalRun = io.run
  io.run = async (argv, options) => {
    if (argv[0] === 'mv' && argv[1]?.endsWith('.json.tmp')) {
      shared.files.set(must(argv[2]), must(shared.files.get(must(argv[1]))))
      shared.files.delete(must(argv[1]))
      return result()
    }
    return originalRun(argv, options)
  }
  expect((await loadNotices(io, undefined, [])).join(' ')).toContain('stopped (SIGSTOP) pid 7')
  expect(await loadNotices(io, undefined, [])).toEqual([])
  expect(shared.files.get('/home/test/.cache/claude-resource-watchdog/delivered/A.json')).toBe('["7@t:stop"]')
})
test('regression: a server already covered by an owned port is not duplicated as a process', async () => {
  const shared = world()
  writeSession(shared, 'covered-server', { profile: 'default', owned: [{ kind: 'metro', id: '8081', label: ':8081', profile: 'default', cwd: '/work/repo', startedAt: 't' }], mutexes: [], changes: [] })
  const io = ioFor(shared, 'covered-server')
  const originalRun = io.run
  io.run = async (argv, options) => argv[1] === '-axo' ? result(0, processTree) : argv[0] === 'lsof' ? result(0, '111') : originalRun(argv, options)
  await scanShellProcesses(io)
  expect(readSession(shared, 'covered-server')?.owned.map(r => r.kind)).toEqual(['metro'])
})

test('regression: an owned shell job stays tracked after reparenting but a reused orphan pid does not', async () => {
  const shared = world()
  const io = ioFor(shared, 'orphan-job')
  writeSession(shared, 'orphan-job', { profile: 'default', owned: [{ kind: 'process', id: 'pid:111@original', pid: 111, label: 'job', profile: 'default', cwd: '/work/repo', startedAt: 'original' }], mutexes: [], changes: [] })
  const originalRun = io.run
  io.run = async (argv, options) => argv[1] === '-axo' ? result(0, '101 1 100 S claude --test\n111 1 2048 S job') : argv.includes('lstart=') ? result(0, 'original') : originalRun(argv, options)
  await scanShellProcesses(io)
  expect(readSession(shared, 'orphan-job')?.owned[0]?.id).toBe('pid:111@original')
  io.run = async (argv, options) => argv[1] === '-axo' ? result(0, '101 1 100 S claude --test\n111 1 2048 S unrelated') : argv.includes('lstart=') ? result(0, 'reused') : originalRun(argv, options)
  await scanShellProcesses(io)
  expect(readSession(shared, 'orphan-job')?.owned).toEqual([])
})

test('regression: pressure candidates and watchdog stops name the worker that started the process', () => {
  const base = { profile: 'default', cwd: '/w', startedAt: 't' }
  expect(pressureNotes(4, 1, 8, [{ ...base, kind: 'process', id: 'pid:1@t', pid: 1, rss: 1024, label: 'mps', agentId: 'abea15e8dca011a5d' }])[1]).toContain('pid 1 1 MB mps (started by worker abea15e8dca011a5d)')
  expect(ownerNotices([{ ...stoppedJob, agent_id: 'abea15e8dca011a5d' }], 'A', new Set()).notes[0]).toContain('by worker abea15e8dca011a5d,')
  expect(ownerNotices([stoppedJob], 'A', new Set()).notes[0]).toContain('by main,')
  expect(ownerNotices([stoppedJob], 'A', new Set(), pid => pid === 7 ? 'abea15e8dca011a5d' : undefined).notes[0]).toContain('by worker abea15e8dca011a5d,')
})

const WORKER = 'abea15e8dca011a5d'
// What fork-tracker.py writes for one Bash call: the zsh -c line Claude Code builds around eval '<command>'.
const shellLine = (command: string, pid: number, pgid: number, t: number) => JSON.stringify({ pid, pgid, t, argv: ['/bin/zsh', '-c', "source /snap.sh 2>/dev/null || true && eval '" + command.replaceAll("'", "'\"'\"'") + "' < /dev/null && pwd -P >| /tmp/claude-cwd"] })
const withProcesses = (shared: World, io: ResourceIo, ps: string, live: Set<number>) => {
  const originalRun = io.run
  io.run = async (argv, options) => {
    if (argv[0] === '/bin/ps' && argv[1] === '-axwwo') { shared.calls.push([...argv]); return result(0, ps) }
    if (argv[0] === '/bin/kill' && argv[1] === '-0') { shared.calls.push([...argv]); return live.has(Number(argv[2])) ? result() : result(1) }
    if (argv[0] === '/bin/kill' && argv[1] === '-TERM') { shared.calls.push([...argv]); for (const p of argv.slice(2)) if (p !== '806') live.delete(Number(p)); return result() }
    if (argv[0] === '/bin/kill' && argv[1] === '-KILL') { shared.calls.push([...argv]); for (const p of argv.slice(2)) live.delete(Number(p)); return result() }
    return originalRun(argv, options)
  }
}

test('regression 2026-11-27: a worker whose shell exits at once leaves an orphan that keeps its pgid, is attributed from the fork ledger and is killed by TaskStop', async () => {
  const shared = world()
  const io = ioFor(shared, 'orphan')
  const command = "(nohup sleep 41 >/dev/null 2>&1 &); echo it's done"
  const flight = beginFlight(WORKER, command, shared.now)
  shared.files.set(ROOT + '/forks/101.jsonl', shellLine(command, 800, 800, shared.now + 20) + '\n')
  flight.endedAt = shared.now + 120
  const live = new Set([805, 806, 900])
  // shell 800 is gone; orphans 805 and 806 (ppid 1) keep pgid 800; 900 is another group
  withProcesses(shared, io, '805 800 sleep 41\n806 800 sleep 42\n900 900 unrelated\n', live)
  await attributeFlights(io)
  expect(readSession(shared, 'orphan')?.agentPgids).toEqual({ '800': WORKER })
  const note = await stopWorkerProcesses(io, WORKER)
  expect(note).toContain('pid 805 sleep 41')
  expect(note).toContain('pid 806 sleep 42 (needed SIGKILL)')
  expect(note).not.toContain('pid 900')
  expect(shared.calls.find(a => a[1] === '-TERM')).toEqual(['/bin/kill', '-TERM', '805', '806'])
  expect(shared.calls.find(a => a[1] === '-KILL')).toEqual(['/bin/kill', '-KILL', '806'])
  expect(await stopWorkerProcesses(io, 'a0000000000000000')).toBeUndefined()
})

test('regression: two identical commands in flight from different agents pair with their shells by start order, and a shell from before the call is nobody\'s', () => {
  const t0 = 1_000_000
  const flights = [{ agentId: 'b1', command: 'sleep 5', startedAt: t0 + 10 }, { agentId: 'a1', command: 'sleep 5', startedAt: t0 }, { agentId: 'c1', command: 'echo stale', startedAt: t0 }]
  const lines = parseForkLines([shellLine('sleep 5', 10, 10, t0 + 30), shellLine('sleep 5', 11, 11, t0 + 40), shellLine('echo stale', 9, 9, t0 - 5000)].join('\n') + '\ntorn')
  const pairs = matchFlights(flights, lines, new Set())
  expect(pairs.map(p => [p.flight.agentId, p.line.pgid])).toEqual([['a1', 10], ['b1', 11]])
  expect(evalNeedle("it's")).toBe("eval 'it'\"'\"'s'")
})

test('regression: a worker job that outlived its shell (ppid 1) is listed with its worker from its pgid', async () => {
  const shared = world()
  writeSession(shared, 'scan-orphan', { profile: 'default', owned: [], mutexes: [], changes: [], agentPgids: { '800': WORKER } })
  const io = ioFor(shared, 'scan-orphan')
  withProcesses(shared, io, '805 800 sleep 41\n', new Set())
  const originalRun = io.run
  io.run = async (argv, options) => argv[1] === '-axo' ? result(0, '101 1 100 S claude --test\n805 1 2048 S sleep 41') : argv.includes('lstart=') ? result(0, 'start') : originalRun(argv, options)
  await scanShellProcesses(io)
  expect(readSession(shared, 'scan-orphan')?.owned[0]).toMatchObject({ pid: 805, agentId: WORKER })
})

test('regression: the Bash hook passes the command to the rest of the stack byte-identical, without an env prefix', async () => {
  const shared = world()
  const io = ioFor(shared, 'hook')
  const hooks: Record<string, (...args: never[]) => unknown> = {}
  const on = ((event: string, matcher: unknown, hook: (...args: never[]) => unknown) => { if (event === 'tool.call' && (matcher as { tool?: string }).tool === 'Bash') hooks.bash = hook }) as unknown as Parameters<typeof register>[0]
  register(on, {})
  const engine = { session: { id: io.sessionId, cwd: io.cwd, root: io.repo }, env: { get: async (k: string) => k === 'HOME' ? '/home/test' : undefined }, clock: { now: io.now }, fs: { exists: io.exists, list: io.list, read: io.read, write: io.write }, process: { run: io.run }, ui: { log: () => undefined } }
  const command = "echo 'a' && ls"
  let seen: Record<string, unknown> | undefined
  const e = { tool: 'Bash', command, agentId: WORKER }
  const next = async (input: Record<string, unknown>) => { seen = input; return { result: { exitCode: 0, stdout: '' } } }
  await (hooks.bash as unknown as (...args: unknown[]) => Promise<unknown>)(engine, e, next)
  expect(seen).toEqual(e)
  expect(seen?.command).toBe(command)
  expect(JSON.stringify(seen)).not.toContain('CLAUDE_AGENT_ID')
})

test('regression: a shell sharing claude\'s own process group is never attributed and TaskStop never signals claude or its group', async () => {
  const shared = world()
  const io = ioFor(shared, 'claude-group')
  const command = 'echo shares-claude-group'
  const flight = beginFlight(WORKER, command, shared.now)
  // the shell (pid 810) was not its own group leader: it carries claude's group 100, which header line says claude leads
  shared.files.set(ROOT + '/forks/101.jsonl', '{"claudePgid": 100}\n' + shellLine(command, 810, 100, shared.now + 20) + '\n')
  flight.endedAt = shared.now + 50
  const live = new Set([101, 810, 811])
  withProcesses(shared, io, '101 100 claude --test\n810 100 zsh shell\n811 100 sleep 9\n', live)
  await attributeFlights(io)
  expect(readSession(shared, 'claude-group')?.agentPgids).toBeUndefined()
  // even a ledger that already maps the group (older tracker, hand edit) must not make TaskStop signal it
  writeSession(shared, 'claude-group', { profile: 'default', owned: [], mutexes: [], changes: [], agentPgids: { '100': WORKER } })
  expect(await stopWorkerProcesses(io, WORKER, 101)).toBeUndefined()
  expect(shared.calls.some(a => a[0] === '/bin/kill' && (a[1] === '-TERM' || a[1] === '-KILL'))).toBe(false)
})
