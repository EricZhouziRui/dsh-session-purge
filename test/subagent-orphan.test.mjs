import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine, projectFolderName } from '../engine.js'

const CWD = '/tmp/subagent-example'
const PROJECT = projectFolderName(CWD)

async function homeDir() {
  return mkdtemp(join(tmpdir(), 'dshsp-subagent-'))
}

async function writeTranscript(home, id) {
  const dir = join(home, 'sessions', PROJECT, id)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'session.v4.jsonl.zstd'), `transcript:${id}`)
  // Orphan recognition requires the transcript to be older than one minute.
  const old = new Date(Date.now() - 10 * 60_000)
  await utimes(dir, old, old)
  await utimes(join(dir, 'session.v4.jsonl.zstd'), old, old)
  return dir
}

function snapshot(id, extra = {}) {
  return {
    header: { id, cwd: CWD, createdAt: 1700000000000, ...extra },
    sizeBytes: 20,
  }
}

function engineWith(home, options = {}) {
  const snapshots = options.snapshots ?? []
  const services = {
    sessionPersistence: { list: async () => snapshots },
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
  return createEngine({
    home,
    getService: (name) => services[name],
    emit: () => {},
    warn: () => {},
    currentSessionId: options.currentSessionId,
  })
}

test('cleanup sees and deletes a tracked subagent whose parent is gone', async () => {
  const home = await homeDir()
  const sub = 'session-orphanchild1'
  const subDir = await writeTranscript(home, sub)
  const engine = engineWith(home, {
    snapshots: [snapshot(sub, { origin: 'subagent', parentSession: 'session-goneparent' })],
  })

  const report = await engine.list()
  // Hidden from the visible session list...
  assert.equal(report.sessions.some((session) => session.id === sub), false)
  // ...but visible to cleanup as a real orphan.
  assert.equal(report.cleanup.orphanSessionIds.includes(sub), true)
  assert.equal(report.counts.orphans >= 1, true)

  const cleanup = await engine.cleanup({})
  const removed = cleanup.removedSessions.find((entry) => entry.sessionId === sub)
  assert.equal(removed?.status, 'deleted')
  await assert.rejects(stat(subDir))
  await rm(home, { recursive: true, force: true })
})

test('a subagent whose parent still exists is kept', async () => {
  const home = await homeDir()
  const parent = 'session-liveparent'
  const sub = 'session-keptchild1'
  const parentDir = await writeTranscript(home, parent)
  const subDir = await writeTranscript(home, sub)
  const engine = engineWith(home, {
    snapshots: [
      snapshot(parent),
      snapshot(sub, { origin: 'subagent', parentSession: parent }),
    ],
  })

  const report = await engine.list()
  assert.equal(report.cleanup.orphanSessionIds.includes(sub), false)
  assert.equal(report.cleanup.orphanSessionIds.includes(parent), false)

  const cleanup = await engine.cleanup({})
  assert.equal(cleanup.removedSessions.length, 0)
  await stat(parentDir)
  await stat(subDir)
  await rm(home, { recursive: true, force: true })
})

test('purging a parent cascades to its non-live subagent children', async () => {
  const home = await homeDir()
  const parent = 'session-parentcasc'
  const child1 = 'session-cascadech1'
  const child2 = 'session-cascadech2'
  await writeTranscript(home, parent)
  const child1Dir = await writeTranscript(home, child1)
  const child2Dir = await writeTranscript(home, child2)
  const engine = engineWith(home, {
    snapshots: [
      snapshot(parent),
      snapshot(child1, { origin: 'subagent', parentSession: parent }),
      snapshot(child2, { origin: 'subagent', parentSession: parent }),
    ],
    live: [{ id: child2 }],
  })

  const result = await engine.purge([parent])
  const byId = new Map(result.results.map((entry) => [entry.sessionId, entry]))
  assert.equal(byId.get(parent)?.status, 'deleted')
  assert.equal(byId.get(child1)?.status, 'deleted')
  // A still-running child is left for later cleanup.
  assert.equal(byId.has(child2), false)
  await assert.rejects(stat(child1Dir))
  await stat(child2Dir)
  await rm(home, { recursive: true, force: true })
})

test('a whole subagent chain is orphaned when the outermost parent is gone', async () => {
  const home = await homeDir()
  const mid = 'session-chainmid1'
  const leaf = 'session-chainleaf1'
  const midDir = await writeTranscript(home, mid)
  const leafDir = await writeTranscript(home, leaf)
  const engine = engineWith(home, {
    snapshots: [
      snapshot(mid, { origin: 'subagent', parentSession: 'session-chainroot-gone' }),
      snapshot(leaf, { origin: 'subagent', parentSession: mid }),
    ],
  })

  const report = await engine.list()
  assert.equal(report.cleanup.orphanSessionIds.includes(mid), true)
  assert.equal(report.cleanup.orphanSessionIds.includes(leaf), true)

  const cleanup = await engine.cleanup({})
  assert.equal(cleanup.removedSessions.filter((entry) => entry.status === 'deleted').length, 2)
  await assert.rejects(stat(midDir))
  await assert.rejects(stat(leafDir))
  await rm(home, { recursive: true, force: true })
})

test('a hidden subagent can still be purged explicitly by id', async () => {
  const home = await homeDir()
  const parent = 'session-explicitprnt'
  const sub = 'session-explicitsub'
  await writeTranscript(home, parent)
  const subDir = await writeTranscript(home, sub)
  const engine = engineWith(home, {
    snapshots: [
      snapshot(parent),
      snapshot(sub, { origin: 'subagent', parentSession: parent }),
    ],
  })

  const result = await engine.purge([sub])
  assert.equal(result.results[0]?.status, 'deleted')
  await assert.rejects(stat(subDir))
  await rm(home, { recursive: true, force: true })
})
