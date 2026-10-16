import { test, expect } from 'claude-code/testing'
import { acquireResource, applyResourceAction, consumeResourceNotice, detectOwned, endResources, guardBash, handleResourceTool, profileName, recordDetected, registerResource, releaseResource, resourceKey, resourceLedgerLines, touchResources, turnStartResources, unregisterResource } from './resources'
import { register } from './register'
import type { MutexOwner, OwnedResource, ProcessResult, ResourceIo, ResourceSession } from './resources'
import type { ClmResourceInput } from '../types'

type World = { files: Map<string, string>; dirs: Set<string>; dirMtimes: Map<string, number>; alive: Set<number>; calls: string[][]; writes: string[]; logs: string[]; now: number }
const ROOT = '/home/test/.local/state/clm/resources'
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
const mutexInput = (name: string, aliases: string[] = []): ClmResourceInput => ({ action: 'register', kind: 'mutex', name, aliases, description: 'shared test resource' })

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
test('regression: malformed clm_resource input is denied by the runtime type guard', async () => {
  const shared = world()
  expect(await handleResourceTool(ioFor(shared, 'bad-tool-input'), { action: 'acquire', name: 42 })).toMatchObject({ deny: 'clm_resource requires a valid action and resource fields.' })
})

// Regression caught: resources must be wired by the clm entry point without importing it back from the resource module.
test('regression: the clm entry point registers resource hooks without an import cycle', () => {
  const calls: unknown[][] = []
  const on: Parameters<typeof register>[0] = ((...args: unknown[]) => { calls.push(args); return undefined }) as Parameters<typeof register>[0]
  register(on, {})
  expect(calls.some(call => call[0] === 'tool.call' && (call[1] as { tool?: string } | undefined)?.tool === 'mcp__clm__clm_resource')).toBe(true)
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
  expect(await consumeResourceNotice(io)).toBe('clm resources: +metro :8081')
  expect(await consumeResourceNotice(io)).toBe(undefined)
  writeSession(shared, 's1', { profile: 'default', owned: [], mutexes: ['ipad'], changes: ['mutex ipad held'] } satisfies ResourceSession)
  expect(await consumeResourceNotice(io)).toBe(undefined)
  await turnStartResources(io)
  expect(await consumeResourceNotice(io)).toBe('clm resources: mutex ipad held')
  expect(resourceLedgerLines({
    owned: [{ kind: 'metro', id: '8081', label: ':8081', profile: 'default', cwd: '/work/repo', startedAt: '2026-10-16T00:00:00.000Z' }],
    mutexes: ['ipad'], changes: [],
  })).toEqual(['- metro :8081', '- mutex ipad held'])
})
