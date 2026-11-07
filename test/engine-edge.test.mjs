import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine, projectFolderName, spillDirName } from '../engine.js'

const CWD = '/tmp/edge-example'
const PROJECT = projectFolderName(CWD)
const TRACKED = 'session-trackedge1'

async function homeDir() {
  return mkdtemp(join(tmpdir(), 'dshsp-edge-'))
}

async function writeTranscript(home, id, cwd = CWD, project = projectFolderName(cwd)) {
  const dir = join(home, 'sessions', project, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), `transcript:${id}`)
  return dir
}

function engineWith(home, options = {}) {
  const snapshots = options.snapshots ?? [{
    header: { id: TRACKED, cwd: CWD, createdAt: 1700000000000 },
    sizeBytes: 20,
  }]
  const services = {
    sessionPersistence: {
      list: options.persistenceFails
        ? async () => { throw new Error('persistence down') }
        : async () => snapshots,
    },
    sessions: {
      list: () => options.live ?? [],
      get: (id) => (options.live ?? []).find((session) => session.id === id),
      flush: async () => {},
      liveEntryFor: () => undefined,
      detachEntered: () => {},
    },
    workspaceRegistry: {
      list: () => [{ async detachSession() {} }],
      ...(options.workspaceRegistry ?? {}),
    },
    sessionProjectionCache: undefined,
    spillStore: { root: options.spillRoot },
  }
  const engine = createEngine({
    home,
    getService: (name) => services[name],
    emit: () => {},
    warn: () => {},
    currentSessionId: options.currentSessionId,
  })
  return engine
}

test('an unrecognized folder under sessions/ is not listed, purged, or cleaned', async () => {
  const home = await homeDir()
  await writeTranscript(home, TRACKED)
  const badId = 'session-outsideproj1'
  const badDir = join(home, 'sessions', 'not-a-dsh-project', badId)
  await mkdir(badDir, { recursive: true })
  await writeFile(join(badDir, 'keep.txt'), 'do not delete')
  const old = new Date(Date.now() - 10 * 60_000)
  await utimes(badDir, old, old)

  const engine = engineWith(home)
  const report = await engine.list()
  assert.equal(report.sessions.some((session) => session.id === badId), false)
  assert.equal(report.cleanup.emptyProjectDirs.some((entry) => entry.path.includes('not-a-dsh-project')), false)

  const purge = await engine.purge([badId])
  assert.equal(purge.results[0].status, 'missing')
  assert.equal((await readFile(join(badDir, 'keep.txt'), 'utf8')), 'do not delete')

  await engine.cleanup({})
  assert.equal((await readFile(join(badDir, 'keep.txt'), 'utf8')), 'do not delete')
  await rm(home, { recursive: true, force: true })
})

test('purge reports favorite and workspace file cleanup separately', async () => {
  const home = await homeDir()
  await writeTranscript(home, TRACKED)
  const storages = join(home, 'storages')
  const cacheDir = join(storages, 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, `${TRACKED}.json`), JSON.stringify({ record: { identity: { cwd: CWD }, rows: {} } }))
  const workspaceFile = join(storages, 'workspace.json')
  await writeFile(workspaceFile, JSON.stringify({
    global: { archivedSessionIds: [TRACKED], pinnedSessionIds: [TRACKED] },
    tables: { workspaces: { w1: { path: CWD, title: 'edge', sessionIds: [TRACKED] } } },
  }))
  const favoritesFile = join(storages, 'archive_manager_favorites.json')
  await writeFile(favoritesFile, JSON.stringify({ global: { favoriteSessionIds: [TRACKED] } }))

  const engine = engineWith(home)
  const result = await engine.purge([TRACKED])
  const entry = result.results[0]
  assert.equal(entry.status, 'deleted')
  assert.equal(entry.favoriteRemoved, true)
  assert.equal(entry.workspaceFileTouched, true)
  const favorites = JSON.parse(await readFile(favoritesFile, 'utf8'))
  assert.deepEqual(favorites.global.favoriteSessionIds, [])
  await rm(home, { recursive: true, force: true })
})

test('purge of an unknown id is missing in dry-run and real mode', async () => {
  const home = await homeDir()
  await writeTranscript(home, TRACKED)
  const engine = engineWith(home)
  const dry = await engine.purge(['session-doesnotexist'], { dryRun: true })
  assert.equal(dry.results[0].status, 'missing')
  const real = await engine.purge(['session-doesnotexist'])
  assert.equal(real.results[0].status, 'missing')
  await rm(home, { recursive: true, force: true })
})

test('deleting every session in one project removes the project directory', async () => {
  const home = await homeDir()
  const second = 'session-trackedge2'
  await writeTranscript(home, TRACKED)
  await writeTranscript(home, second)
  const engine = engineWith(home, {
    snapshots: [
      { header: { id: TRACKED, cwd: CWD, createdAt: 1700000000000 }, sizeBytes: 20 },
      { header: { id: second, cwd: CWD, createdAt: 1700000000001 }, sizeBytes: 20 },
    ],
  })
  const result = await engine.purge([TRACKED, second])
  assert.deepEqual(result.results.map((entry) => entry.status), ['deleted', 'deleted'])
  await assert.rejects(stat(join(home, 'sessions', PROJECT)))
  await rm(home, { recursive: true, force: true })
})

test('cleanup removes an empty project folder that only has .DS_Store', async () => {
  const home = await homeDir()
  await writeTranscript(home, TRACKED)
  const emptyProject = join(home, 'sessions', '--empty--')
  await mkdir(emptyProject, { recursive: true })
  await writeFile(join(emptyProject, '.DS_Store'), 'metadata')

  const engine = engineWith(home)
  const result = await engine.cleanup({})
  assert.equal(result.ok, true)
  assert.equal(result.cleanedProjects.some((entry) => entry.path === emptyProject && entry.status === 'deleted'), true)
  await assert.rejects(stat(emptyProject))
  await rm(home, { recursive: true, force: true })
})

test('an empty persistence list beside disk sessions disables orphan cleanup', async () => {
  const home = await homeDir()
  await writeTranscript(home, TRACKED)
  const engine = engineWith(home, { snapshots: [] })
  const report = await engine.list()
  assert.equal(report.orphanSafe, false)
  assert.deepEqual(report.cleanup.orphanSessionIds, [])
  const result = await engine.cleanup({})
  assert.equal(result.ok, false)
  assert.equal((await stat(join(home, 'sessions', PROJECT, TRACKED))).isDirectory(), true)
  await rm(home, { recursive: true, force: true })
})

test('a symlinked project folder is ignored and its target is untouched', async () => {
  const home = await homeDir()
  await writeTranscript(home, TRACKED)
  const outside = await mkdtemp(join(tmpdir(), 'dshsp-edge-outside-'))
  const linkedSession = join(outside, 'session-linkproject1')
  await mkdir(linkedSession, { recursive: true })
  await writeFile(join(linkedSession, 'keep.txt'), 'keep')
  await symlink(outside, join(home, 'sessions', '--linked--'))

  const engine = engineWith(home)
  const report = await engine.list()
  assert.equal(report.sessions.some((session) => session.id === 'session-linkproject1'), false)
  await engine.cleanup({})
  assert.equal((await readFile(join(linkedSession, 'keep.txt'), 'utf8')), 'keep')
  await rm(home, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

test('a symlinked spill directory is unlinked without touching its target', async () => {
  const home = await homeDir()
  const spillRoot = join(home, 'spill')
  await mkdir(spillRoot, { recursive: true })
  const outside = await mkdtemp(join(tmpdir(), 'dshsp-edge-spill-'))
  await writeFile(join(outside, 'keep.txt'), 'keep')
  const link = join(spillRoot, spillDirName(TRACKED))
  await writeTranscript(home, TRACKED)
  await symlink(outside, link)

  const engine = engineWith(home, { spillRoot })
  const result = await engine.purge([TRACKED])
  assert.equal(result.results[0].spillRemoved, true)
  assert.equal((await readFile(join(outside, 'keep.txt'), 'utf8')), 'keep')
  await assert.rejects(stat(link))
  await rm(home, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

test('a tracked location pointing through a symlinked project is not deleted', async () => {
  const home = await homeDir()
  const outside = await mkdtemp(join(tmpdir(), 'dshsp-edge-loc-'))
  const id = 'session-snaplink1'
  const real = join(outside, 'real-project')
  await mkdir(join(real, id), { recursive: true })
  await writeFile(join(real, id, 'session.v4.jsonl.zstd'), 'keep me')
  await mkdir(join(home, 'sessions'), { recursive: true })
  const linkProject = join(home, 'sessions', '--symlink-project--')
  await symlink(real, linkProject)

  const engine = engineWith(home, {
    snapshots: [{
      header: { id, cwd: '/tmp/symlink-placeholder', createdAt: 1700000000000 },
      location: { kind: 'jsonl', path: join(linkProject, id, 'session.v4.jsonl.zstd') },
    }],
  })
  const result = await engine.purge([id])
  assert.equal(result.results[0].status, 'deleted')
  assert.deepEqual(result.results[0].removed, [])
  assert.equal(await readFile(join(real, id, 'session.v4.jsonl.zstd'), 'utf8'), 'keep me')
  await rm(home, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

test('tracked subagent transcripts are hidden from the list but still purgeable by id', async () => {
  const home = await homeDir()
  const id = '18c2d8a5-ce6f-49e4-8e76-39b891cc74ab'
  await writeTranscript(home, id)
  const engine = engineWith(home, {
    snapshots: [{
      header: { id, cwd: CWD, createdAt: 1700000000000, origin: 'subagent', parentSession: TRACKED },
    }],
  })
  const report = await engine.list()
  assert.equal(report.sessions.some((session) => session.id === id), false)
  assert.equal(report.counts.sessions, 0)
  const result = await engine.purge([id])
  assert.equal(result.results[0].status, 'deleted')
  await assert.rejects(stat(join(home, 'sessions', PROJECT, id)))
  await rm(home, { recursive: true, force: true })
})

test('subagent UUID sessions are listed and can be purged', async () => {
  const home = await homeDir()
  const id = '8582a21d-0bc2-4163-b4fd-5308ec318633'
  await writeTranscript(home, id)
  const engine = engineWith(home, {
    snapshots: [{ header: { id, cwd: CWD, createdAt: 1700000000000 } }],
  })
  const report = await engine.list()
  assert.equal(report.sessions.some((session) => session.id === id), true)
  const result = await engine.purge([id])
  assert.equal(result.results[0].status, 'deleted')
  await assert.rejects(stat(join(home, 'sessions', PROJECT, id)))
  await rm(home, { recursive: true, force: true })
})

test('a symlinked projection cache is unlinked without touching its target', async () => {
  const home = await homeDir()
  await writeTranscript(home, TRACKED)
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  const outside = await mkdtemp(join(tmpdir(), 'dshsp-edge-cache-'))
  const target = join(outside, 'keep.json')
  await writeFile(target, JSON.stringify({ record: { identity: { cwd: CWD }, rows: {} } }))
  const link = join(cacheDir, `${TRACKED}.json`)
  await symlink(target, link)

  const engine = engineWith(home)
  const result = await engine.purge([TRACKED])
  assert.equal(result.results[0].cacheRemoved, true)
  assert.equal((await readFile(target, 'utf8')).includes('identity'), true)
  await assert.rejects(stat(link))
  await rm(home, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })
})

test('a cache-only orphan is deleted without claiming a transcript directory', async () => {
  const home = await homeDir()
  await writeTranscript(home, TRACKED)
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  const cacheId = 'session-cacheonly1'
  const cacheFile = join(cacheDir, `${cacheId}.json`)
  await writeFile(cacheFile, JSON.stringify({ record: { identity: { cwd: CWD }, rows: {} } }))

  const engine = engineWith(home)
  const report = await engine.list()
  assert.equal(report.cleanup.staleProjectionCacheIds.includes(cacheId), true)
  const result = await engine.cleanup({})
  assert.equal(result.removedCaches.some((entry) => entry.sessionId === cacheId && entry.status === 'deleted'), true)
  await assert.rejects(stat(cacheFile))
  await rm(home, { recursive: true, force: true })
})

test('malformed workspace JSON does not block deletion', async () => {
  const home = await homeDir()
  await writeTranscript(home, TRACKED)
  await mkdir(join(home, 'storages'), { recursive: true })
  await writeFile(join(home, 'storages', 'workspace.json'), '{ not valid json')
  const engine = engineWith(home)
  const report = await engine.list()
  assert.ok(report.warnings.some((warning) => warning.includes('workspace.json')))
  const result = await engine.purge([TRACKED])
  assert.equal(result.results[0].status, 'deleted')
  await rm(home, { recursive: true, force: true })
})

test('purging the same session twice is idempotent', async () => {
  const home = await homeDir()
  await writeTranscript(home, TRACKED)
  const snapshots = [{ header: { id: TRACKED, cwd: CWD, createdAt: 1700000000000 }, sizeBytes: 20 }]
  const engine = engineWith(home, { snapshots })
  const first = await engine.purge([TRACKED])
  assert.equal(first.results[0].status, 'deleted')
  snapshots.length = 0
  const second = await engine.purge([TRACKED])
  assert.equal(second.results[0].status, 'missing')
  await rm(home, { recursive: true, force: true })
})

test('currentSessionId is protected unless allowLive is explicitly true', async () => {
  const home = await homeDir()
  await writeTranscript(home, TRACKED)
  const engine = engineWith(home, { currentSessionId: TRACKED })
  const skipped = await engine.purge([TRACKED])
  assert.equal(skipped.results[0].status, 'skipped')
  assert.equal((await stat(join(home, 'sessions', PROJECT, TRACKED))).isDirectory(), true)

  const allowed = await engine.purge([TRACKED], { allowLive: true })
  assert.equal(allowed.results[0].status, 'deleted')
  await rm(home, { recursive: true, force: true })
})
