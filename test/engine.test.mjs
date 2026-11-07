import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine, projectFolderName, spillDirName } from '../engine.js'

const CWD = '/tmp/example'
const TRACKED = 'session-aaaa1111'
const ORPHAN = 'session-orphan01'

async function makeFixture() {
  const home = await mkdtemp(join(tmpdir(), 'dshsp-'))
  const project = join(home, 'sessions', projectFolderName(CWD))
  const transcript = join(project, TRACKED, 'session.v4.jsonl.zstd')
  await mkdir(join(project, TRACKED), { recursive: true })
  await writeFile(transcript, 'conversation payload')

  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  const cacheFile = join(cacheDir, `${TRACKED}.json`)
  await writeFile(cacheFile, JSON.stringify({
    version: 7,
    record: {
      identity: { formatVersion: 4, createdAt: 1700000000000, cwd: CWD },
      rows: { title: { val: '测试会话' }, sessionStats: { val: { turns: 2 } } },
    },
  }))

  const workspaceFile = join(home, 'storages', 'workspace.json')
  await writeFile(workspaceFile, JSON.stringify({
    global: { workspaceIds: ['w1'], archivedSessionIds: [TRACKED], pinnedSessionIds: [TRACKED] },
    tables: {
      workspaces: {
        w1: { path: CWD, title: 'example', sessionIds: [TRACKED, ORPHAN] },
      },
    },
  }))
  const favoritesFile = join(home, 'storages', 'archive_manager_favorites.json')
  await writeFile(favoritesFile, JSON.stringify({ global: { favoriteSessionIds: [TRACKED] } }))

  const orphanDir = join(project, ORPHAN)
  await mkdir(orphanDir, { recursive: true })
  await writeFile(join(orphanDir, 'session.v4.jsonl.zstd'), 'leftover conversation')
  const old = new Date(Date.now() - 10 * 60_000)
  await utimes(orphanDir, old, old)

  const spillRoot = join(home, 'spill')
  const spillDir = join(spillRoot, spillDirName(TRACKED))
  await mkdir(spillDir, { recursive: true })
  await writeFile(join(spillDir, 'leaked.txt'), 'spilled tool output')

  return { home, project, transcript, cacheFile, cacheDir, workspaceFile, favoritesFile, orphanDir, spillRoot, spillDir }
}

function makeServices(fixture, options = {}) {
  const detached = []
  const services = {
    sessionPersistence: {
      list: async () => options.trackedList ?? [{
        header: { id: TRACKED, cwd: CWD, createdAt: 1700000000000 },
        sizeBytes: 21,
        location: { kind: 'jsonl', path: fixture.transcript },
      }],
    },
    sessions: { list: () => options.live ?? [] },
    sessionProjectionCache: {
      requireTable: () => ({
        async delete(id) {
          await rm(join(fixture.cacheDir, `${id}.json`), { force: true })
        },
      }),
    },
    workspaceRegistry: {
      list: () => [{
        async detachSession(id) {
          detached.push(id)
        },
      }],
    },
    spillStore: { root: fixture.spillRoot },
  }
  return { services, detached }
}

function engineFor(fixture, options = {}) {
  const { services, detached } = makeServices(fixture, options)
  const emitted = []
  const engine = createEngine({
    home: fixture.home,
    getService: (name) => services[name],
    emit: (event, id) => emitted.push([event, id]),
    warn: () => {},
  })
  return { engine, detached, emitted }
}

test('project folder and spill names match the DSH layout', () => {
  assert.equal(projectFolderName('/Users/example/Desktop/插件'), '--Users-example-Desktop-~63D2~4EF6--')
  assert.equal(spillDirName('session-12345678-90ab-cdef-1234-567890abcdef'), 'session-923a57b3231c')
})

test('list reports sessions, titles, traces and leftovers', async () => {
  const fixture = await makeFixture()
  const { engine } = engineFor(fixture)
  const report = await engine.list()

  const tracked = report.sessions.find((session) => session.id === TRACKED)
  assert.ok(tracked, 'tracked session missing')
  assert.equal(tracked.title, '测试会话')
  assert.equal(tracked.tracked, true)
  assert.equal(tracked.orphan, false)
  assert.equal(tracked.traces.projectionCache, true)
  assert.deepEqual(tracked.traces.workspaces, [CWD])
  assert.equal(tracked.traces.archived, true)
  assert.equal(tracked.traces.pinned, true)
  assert.equal(tracked.traces.favorite, true)
  assert.equal(tracked.traces.spill, true)

  const orphan = report.sessions.find((session) => session.id === ORPHAN)
  assert.ok(orphan, 'orphan session missing')
  assert.equal(orphan.orphan, true)
  assert.equal(report.counts.orphans, 1)
  assert.deepEqual(report.cleanup.orphanSessionIds, [ORPHAN])

  await rm(fixture.home, { recursive: true, force: true })
})

test('dry run reports plans without deleting anything', async () => {
  const fixture = await makeFixture()
  const { engine } = engineFor(fixture)
  const result = await engine.purge([TRACKED], { dryRun: true })

  assert.equal(result.results[0].status, 'planned')
  assert.ok(result.results[0].paths.some((path) => path.includes(TRACKED)))
  assert.equal((await stat(fixture.transcript)).isFile(), true)
  assert.deepEqual(await readdir(join(fixture.project, TRACKED)), ['session.v4.jsonl.zstd'])

  await rm(fixture.home, { recursive: true, force: true })
})

test('purge deletes transcript, cache, spill and workspace accounting', async () => {
  const fixture = await makeFixture()
  const { engine, detached, emitted } = engineFor(fixture)

  const result = await engine.purge([TRACKED])
  assert.equal(result.ok, true)
  assert.equal(result.results[0].status, 'deleted')

  await assert.rejects(stat(join(fixture.project, TRACKED)))
  await assert.rejects(stat(fixture.cacheFile))
  await assert.rejects(stat(fixture.spillDir))
  assert.ok(detached.includes(TRACKED))
  assert.deepEqual(emitted, [['api-session/removed', TRACKED]])

  const workspace = JSON.parse(await readFile(fixture.workspaceFile, 'utf8'))
  assert.deepEqual(workspace.global.archivedSessionIds, [])
  assert.deepEqual(workspace.global.pinnedSessionIds, [])
  assert.deepEqual(workspace.tables.workspaces.w1.sessionIds, [ORPHAN])
  const favorites = JSON.parse(await readFile(fixture.favoritesFile, 'utf8'))
  assert.deepEqual(favorites.global.favoriteSessionIds, [])

  // The orphan still occupies the project folder, so the folder must survive.
  assert.equal((await stat(fixture.project)).isDirectory(), true)

  await rm(fixture.home, { recursive: true, force: true })
})

test('cleanup removes orphan transcripts, stale caches and empty project folders', async () => {
  const fixture = await makeFixture()
  // A stale cache row for a session that no longer exists anywhere.
  await writeFile(join(fixture.cacheDir, 'session-stale999.json'), JSON.stringify({ record: { identity: {}, rows: {} } }))

  const { engine } = engineFor(fixture)
  const dry = await engine.cleanup({ dryRun: true })
  assert.equal(dry.dryRun, true)
  assert.equal((await stat(fixture.orphanDir)).isDirectory(), true)

  const result = await engine.cleanup({})
  assert.equal(result.ok, true)
  await assert.rejects(stat(fixture.orphanDir))
  await assert.rejects(stat(join(fixture.cacheDir, 'session-stale999.json')))
  // The tracked session still exists, so the project folder stays.
  assert.equal((await stat(fixture.project)).isDirectory(), true)

  await rm(fixture.home, { recursive: true, force: true })
})

test('cleanup is refused when the persistence list is unavailable', async () => {
  const fixture = await makeFixture()
  const { engine } = engineFor(fixture, { trackedList: null })
  // Simulate a failing persistence service: list returns null and engine treats
  // it as an unavailable/failed listing only when it throws.
  const failing = createEngine({
    home: fixture.home,
    getService: (name) => name === 'sessionPersistence'
      ? { list: async () => { throw new Error('boom') } }
      : undefined,
    emit: () => {},
    warn: () => {},
  })
  const result = await failing.cleanup({})
  assert.equal(result.ok, false)
  assert.equal((await stat(fixture.orphanDir)).isDirectory(), true)

  await rm(fixture.home, { recursive: true, force: true })
  await engine.list()
})

test('rejects traversal ids and never follows a symlinked session directory', async () => {
  const fixture = await makeFixture()
  const outside = await mkdtemp(join(tmpdir(), 'dshsp-outside-'))
  await mkdir(join(outside, 'keep'), { recursive: true })
  await writeFile(join(outside, 'keep', 'data.txt'), 'do not delete')
  const linkedId = 'session-linked'
  await symlink(join(outside, 'keep'), join(fixture.project, linkedId))

  const { engine } = engineFor(fixture)
  const bad = await engine.purge(['../../etc/passwd'])
  assert.equal(bad.results[0].status, 'failed')

  const linked = await engine.purge([linkedId])
  assert.notEqual(linked.results[0].status, 'deleted')
  assert.equal((await stat(join(outside, 'keep', 'data.txt'))).isFile(), true)

  const cleanup = await engine.cleanup({})
  assert.equal((await stat(join(outside, 'keep', 'data.txt'))).isFile(), true)
  assert.equal(cleanup.ok, true)

  await rm(fixture.home, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

test('reconcile skips a session that is still in the durable list', async () => {
  const fixture = await makeFixture()
  const { engine } = engineFor(fixture)
  const result = await engine.reconcile(TRACKED)
  assert.equal(result.status, 'skipped')
  assert.equal((await stat(fixture.transcript)).isFile(), true)
  await rm(fixture.home, { recursive: true, force: true })
})

test('reconcile finishes a deletion another plugin started (orphan transcript)', async () => {
  const fixture = await makeFixture()
  // Simulate a session manager that removed the durable log but left the folder:
  // the persistence list no longer contains the orphan id, the folder stays.
  const { engine, emitted } = engineFor(fixture)
  const result = await engine.reconcile(ORPHAN)
  assert.equal(result.status, 'deleted')
  await assert.rejects(stat(fixture.orphanDir))
  assert.ok(emitted.some(([event, id]) => event === 'api-session/removed' && id === ORPHAN))
  await rm(fixture.home, { recursive: true, force: true })
})

test('reconcile refuses to act when the durable list is unreadable', async () => {
  const fixture = await makeFixture()
  const failing = createEngine({
    home: fixture.home,
    getService: (name) => name === 'sessionPersistence'
      ? { list: async () => { throw new Error('boom') } }
      : name === 'sessions'
        ? { list: () => [] }
        : undefined,
    emit: () => {},
    warn: () => {},
  })
  const result = await failing.reconcile(ORPHAN)
  assert.equal(result.status, 'skipped')
  assert.equal((await stat(fixture.orphanDir)).isDirectory(), true)
  await rm(fixture.home, { recursive: true, force: true })
})

test('purge deletes a live session only when allowed, flushing and detaching first', async () => {
  const fixture = await makeFixture()
  const { services } = makeServices(fixture)
  const flushed = []
  const detached = []
  services.sessions = {
    list: () => [{ id: TRACKED }],
    get: (id) => (id === TRACKED ? { id: TRACKED } : undefined),
    flush: async (session) => { flushed.push(session.id) },
    liveEntryFor: () => ({ key: 'entry-1' }),
    detachEntered: (entry) => { detached.push(entry.key) },
  }
  const engine = createEngine({
    home: fixture.home,
    getService: (name) => services[name],
    emit: () => {},
    warn: () => {},
  })

  const skipped = await engine.purge([TRACKED], { allowLive: false })
  assert.equal(skipped.results[0].status, 'skipped')
  assert.equal((await stat(fixture.transcript)).isFile(), true)

  const allowed = await engine.purge([TRACKED], { allowLive: true })
  assert.equal(allowed.results[0].status, 'deleted')
  assert.equal(allowed.results[0].live, true)
  assert.equal(allowed.results[0].detached, true)
  assert.deepEqual(flushed, [TRACKED])
  assert.deepEqual(detached, ['entry-1'])
  await assert.rejects(stat(join(fixture.project, TRACKED)))

  await rm(fixture.home, { recursive: true, force: true })
})

test('reconcile cleans an untracked session even when a live object still exists', async () => {
  const fixture = await makeFixture()
  const { services } = makeServices(fixture)
  services.sessions = {
    list: () => [{ id: ORPHAN }],
    get: (id) => (id === ORPHAN ? { id: ORPHAN } : undefined),
    flush: async () => {},
    liveEntryFor: () => ({ key: 'entry-2' }),
    detachEntered: () => {},
  }
  const engine = createEngine({
    home: fixture.home,
    getService: (name) => services[name],
    emit: () => {},
    warn: () => {},
  })
  const result = await engine.reconcile(ORPHAN)
  assert.equal(result.status, 'deleted')
  assert.equal(result.live, true)
  await assert.rejects(stat(fixture.orphanDir))
  await rm(fixture.home, { recursive: true, force: true })
})

test('cleanup forgets archive-manager index entries for sessions that no longer exist', async () => {
  const fixture = await makeFixture()
  const { services } = makeServices(fixture)
  const forgotten = []
  services.workspaceRegistry.diagnoseSessionCaches = async () => ({
    count: 2,
    items: [
      { sessionId: 'session-gone111', identity: 'stale' },
      { sessionId: TRACKED, identity: 'tracked' },
    ],
  })
  services.workspaceRegistry.forgetIndexedSession = (id) => { forgotten.push(id) }
  const engine = createEngine({
    home: fixture.home,
    getService: (name) => services[name],
    emit: () => {},
    warn: () => {},
  })

  const report = await engine.list()
  assert.equal(report.archive.count, 2)
  assert.deepEqual(report.cleanup.staleIndexIds, ['session-gone111'])

  const result = await engine.cleanup({})
  assert.equal(result.ok, true)
  assert.ok(forgotten.includes('session-gone111'), 'stale index entry should be forgotten')
  assert.deepEqual(result.cleanedIndex.map((entry) => entry.sessionId), ['session-gone111'])
  await rm(fixture.home, { recursive: true, force: true })
})

test('purge also forgets the deleted session from the archive-manager index', async () => {
  const fixture = await makeFixture()
  const { services } = makeServices(fixture)
  const forgotten = []
  services.workspaceRegistry.forgetIndexedSession = (id) => { forgotten.push(id) }
  const engine = createEngine({
    home: fixture.home,
    getService: (name) => services[name],
    emit: () => {},
    warn: () => {},
  })
  const result = await engine.purge([TRACKED])
  assert.equal(result.results[0].status, 'deleted')
  assert.ok(forgotten.includes(TRACKED))
  await rm(fixture.home, { recursive: true, force: true })
})
