import { test, expect } from 'claude-code/testing'
import { acquireResource, applyResourceAction, consumeResourceNotice, detectOwned, endResources, guardBash, registerResource, resourceKey, resourceLedgerLines, turnStartResources } from './resources'
import type { MutexOwner, ProcessResult, ResourceIo, ResourceSession } from './resources'
import type { ClmResourceInput } from '../types'

type World = { files: Map<string, string>; dirs: Set<string>; store: Map<string, unknown>; alive: Set<number>; calls: string[][]; logs: string[]; now: number }
const result = (exitCode = 0, stdout = '', stderr = ''): ProcessResult => ({ exitCode, stdout, stderr })
const mkdirs = (world: World, path: string) => {
  let current = ''
  for (const part of path.split('/').filter(Boolean)) {
    current += `/${part}`
    world.dirs.add(current)
  }
}
const removeTree = (world: World, path: string) => {
  world.dirs.delete(path)
  for (const dir of [...world.dirs]) if (dir.startsWith(`${path}/`)) world.dirs.delete(dir)
  for (const file of [...world.files.keys()]) if (file === path || file.startsWith(`${path}/`)) world.files.delete(file)
}
const moveTree = (world: World, from: string, to: string) => {
  for (const dir of [...world.dirs].filter(dir => dir === from || dir.startsWith(`${from}/`))) {
    world.dirs.delete(dir)
    world.dirs.add(`${to}${dir.slice(from.length)}`)
  }
  for (const [file, value] of [...world.files]) if (file === from || file.startsWith(`${from}/`)) {
    world.files.delete(file)
    world.files.set(`${to}${file.slice(from.length)}`, value)
  }
}
const world = (): World => ({ files: new Map(), dirs: new Set(), store: new Map(), alive: new Set([101, 202]), calls: [], logs: [], now: Date.parse('2026-10-16T00:00:00Z') })
function ioFor(shared: World, session: string, processPid = 101, cwd = '/work/repo'): ResourceIo {
  return {
    sessionId: async () => session,
    home: async () => '/home/test',
    cwd: async () => cwd,
    repo: async () => '/work/repo',
    now: async () => shared.now,
    keys: async () => [...shared.store.keys()],
    get: async key => shared.store.get(key),
    set: async (key, value) => { shared.store.set(key, structuredClone(value)) },
    delete: async key => { shared.store.delete(key) },
    exists: async path => shared.dirs.has(path),
    list: async path => [...shared.dirs].filter(dir => dir.startsWith(`${path}/`) && !dir.slice(path.length + 1).includes('/')).map(dir => ({ name: dir.slice(path.length + 1), kind: 'dir' })),
    read: async path => shared.files.get(path),
    write: async (path, value) => { shared.files.set(path, value); mkdirs(shared, path.slice(0, path.lastIndexOf('/'))) },
    run: async (argv): Promise<ProcessResult> => {
      shared.calls.push([...argv])
      if (argv[0] === 'sh') return result(0, `${processPid}\n`)
      if (argv[0] === '/bin/ps') return result(0, 'claude --test\n')
      if (argv[0] === '/bin/kill' && argv[1] === '-0') return shared.alive.has(Number(argv[2])) ? result() : result(1, '', 'No such process')
      if (argv[0] === 'mkdir' && argv[1] === '-p') { mkdirs(shared, argv[2]!); return result() }
      if (argv[0] === 'mkdir') {
        if (shared.dirs.has(argv[1]!)) return result(1, '', 'File exists')
        shared.dirs.add(argv[1]!)
        return result()
      }
      if (argv[0] === 'mv') {
        if (!shared.dirs.has(argv[1]!)) return result(1, '', 'No such file or directory')
        moveTree(shared, argv[1]!, argv[2]!)
        return result()
      }
      if (argv[0] === 'rm' && argv[1] === '-rf') { removeTree(shared, argv[2]!); return result() }
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
  expect(detected).toEqual([{ kind: 'android-emulator', id: 'avd:Pixel_9_API_35', label: 'Pixel_9_API_35', cwd: '/work/repo', startedAt: '2026-10-16T00:00:00.000Z', backgroundTaskId: 'bg1' }])
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
  expect((await acquireResource(first, 'ipad')).result).toMatchObject({ status: 'claimed', borrower: 's1' })
  const denied = await guardBash(second, 'agent-device use ipad')
  expect(denied).toContain('session s1')
  expect(denied).toContain('/work/repo')
  expect(denied).toContain('since 2026-10-16T00:00:00.000Z')
})

// Regression caught: a crashed holder could strand a mutex forever after its heartbeat or PID stopped proving life.
test('regression: a dead mutex holder is reclaimed before a new session acquires it', async () => {
  const shared = world()
  const first = ioFor(shared, 's1', 101)
  const second = ioFor(shared, 's2', 202)
  await registerResource(first, mutexInput('ipad'))
  await acquireResource(first, 'ipad')
  shared.alive.delete(101)
  expect((await acquireResource(second, 'ipad')).result).toMatchObject({ status: 'claimed', borrower: 's2' })
  expect(shared.logs.some(line => line.includes('reclaimed ipad from dead session s1'))).toBe(true)
})

// Regression caught: the resource tool exposed registration without a working list, who, release, unregister, and forget path.
test('regression: every resource tool action updates and reports the current session state', async () => {
  const shared = world()
  const io = ioFor(shared, 's1')
  await applyResourceAction(io, { action: 'register', kind: 'owned', name: 'test server' })
  await applyResourceAction(io, mutexInput('ipad'))
  await applyResourceAction(io, { action: 'acquire', name: 'ipad' })
  expect(await applyResourceAction(io, { action: 'list' })).toMatchObject({ result: { owned: [{ id: 'test server' }], mutexes: [{ name: 'ipad', borrower: { session: 's1' } }] } })
  expect(await applyResourceAction(io, { action: 'who', name: 'ipad' })).toMatchObject({ result: { borrower: { session: 's1' } } })
  expect(await applyResourceAction(io, { action: 'release', name: 'ipad' })).toMatchObject({ result: { status: 'released' } })
  expect(await applyResourceAction(io, { action: 'unregister', name: 'ipad' })).toMatchObject({ result: { status: 'unregistered' } })
  expect(await applyResourceAction(io, { action: 'forget', name: 'test server' })).toMatchObject({ result: { forgotten: 'test server' } })
})

// Regression caught: /clear and resume change the session id without session.start, which otherwise loses ownership.
test('regression: clear and resume transfer owned resources and mutexes lazily to the matching process session', async () => {
  for (const reason of ['clear', 'resume']) {
    const shared = world()
    const old = ioFor(shared, 'old', 101)
    const next = ioFor(shared, 'new', 101)
    await registerResource(old, { action: 'register', kind: 'owned', name: 'local api' })
    await registerResource(old, mutexInput('ipad'))
    await acquireResource(old, 'ipad')
    const prior = await old.get(resourceKey('old')) as ResourceSession
    await old.set(resourceKey('old'), {
      ...prior,
      owned: [...prior.owned, { kind: 'ios-simulator', id: '1234-ABCD', label: 'iPad simulator', cwd: '/work/repo', startedAt: '2026-10-16T00:00:00.000Z' }],
    } satisfies ResourceSession)
    await endResources(old, 'old', reason)
    await turnStartResources(next)
    const moved = await next.get(resourceKey('new')) as ResourceSession
    expect(moved.owned.map(resource => resource.id)).toEqual(['local api', '1234-ABCD'])
    expect(moved.mutexes).toEqual(['ipad'])
    const registered = JSON.parse(shared.files.get([...shared.files.keys()].find(path => path.endsWith('/resource.json'))!)!) as { name: string }
    const ownerPath = [...shared.files.keys()].find(path => path.endsWith('/owner/owner.json'))!
    expect((JSON.parse(shared.files.get(ownerPath)!) as MutexOwner).session).toBe('new')
    expect(registered.name).toBe('ipad')
    await endResources(next, 'new', 'logout')
    expect(shared.calls.some(argv => argv[0] === 'xcrun' && argv.at(-1) === '1234-ABCD')).toBe(true)
    expect((await next.get(resourceKey('new')) as ResourceSession).owned).toEqual([])
  }
})

// Regression caught: ending one session must release its mutex, keep shared simulators alive, and stop unshared servers.
test('regression: session end releases mutexes and stops only owned resources with no other session reference', async () => {
  const shared = world()
  const current = ioFor(shared, 's1')
  const other = ioFor(shared, 's2')
  await registerResource(current, mutexInput('ipad'))
  await acquireResource(current, 'ipad')
  const owned = [
    { kind: 'ios-simulator' as const, id: 'shared-udid', label: 'shared-udid', cwd: '/work/repo', startedAt: '2026-10-16T00:00:00.000Z' },
    { kind: 'metro' as const, id: '8081', label: ':8081', cwd: '/work/repo', startedAt: '2026-10-16T00:00:00.000Z' },
  ]
  await current.set(resourceKey('s1'), { owned, mutexes: ['ipad'], changes: [], identity: { processPid: 101, pid: 101, cwd: '/work/repo', repo: '/work/repo', heartbeat: shared.now, probedAt: shared.now } } satisfies ResourceSession)
  await other.set(resourceKey('s2'), { owned: [owned[0]], mutexes: [], changes: [] } satisfies ResourceSession)
  await endResources(current, 's1', 'prompt_input_exit')
  expect(shared.calls.some(argv => argv[0] === 'xcrun' && argv.at(-1) === 'shared-udid')).toBe(false)
  expect(shared.calls.some(argv => argv[0] === '/bin/kill' && argv[1] === '333')).toBe(true)
  expect(shared.files.has([...shared.files.keys()].find(path => path.endsWith('/owner/owner.json'))!)).toBe(false)
  expect(await current.get(resourceKey('s1'))).toBe(undefined)
})

// Regression caught: resource changes were either injected on every prompt or missed on the next user turn.
test('regression: resource changes become one prompt notice on the next turn only', async () => {
  const shared = world()
  const io = ioFor(shared, 's1')
  await io.set(resourceKey('s1'), { owned: [], mutexes: [], changes: ['+metro :8081'] } satisfies ResourceSession)
  expect(await consumeResourceNotice(io)).toBe(undefined)
  await turnStartResources(io)
  expect(await consumeResourceNotice(io)).toBe('clm resources: +metro :8081')
  expect(await consumeResourceNotice(io)).toBe(undefined)
  await io.set(resourceKey('s1'), { owned: [], mutexes: ['ipad'], changes: ['mutex ipad held'] } satisfies ResourceSession)
  expect(await consumeResourceNotice(io)).toBe(undefined)
  await turnStartResources(io)
  expect(await consumeResourceNotice(io)).toBe('clm resources: mutex ipad held')
  expect(resourceLedgerLines({
    owned: [{ kind: 'metro', id: '8081', label: ':8081', cwd: '/work/repo', startedAt: '2026-10-16T00:00:00.000Z' }],
    mutexes: ['ipad'], changes: [],
  })).toEqual(['- metro :8081', '- mutex ipad held'])
})
