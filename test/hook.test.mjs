import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../index.js'
import { projectFolderName } from '../engine.js'

const CWD = '/tmp/example'
const TRACKED = 'session-aaaa1111'
const ORPHAN = 'session-orphan01'

async function makeFixture() {
  const home = await mkdtemp(join(tmpdir(), 'dshsp-hook-'))
  const project = join(home, 'sessions', projectFolderName(CWD))
  await mkdir(join(project, TRACKED), { recursive: true })
  const transcript = join(project, TRACKED, 'session.v4.jsonl.zstd')
  await writeFile(transcript, 'payload')
  const orphanDir = join(project, ORPHAN)
  await mkdir(orphanDir, { recursive: true })
  await writeFile(join(orphanDir, 'session.v4.jsonl.zstd'), 'leftover')
  const old = new Date(Date.now() - 10 * 60_000)
  await utimes(orphanDir, old, old)
  const cacheDir = join(home, 'storages', 'session_projcache', 'sessions')
  await mkdir(cacheDir, { recursive: true })
  await writeFile(join(cacheDir, `${ORPHAN}.json`), JSON.stringify({ record: { identity: { cwd: CWD }, rows: {} } }))
  return { home, project, transcript, orphanDir, cacheDir }
}

function makeContext(home, services, state) {
  const listeners = new Map()
  const ctx = {
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'workspaceRegistry') return services.workspaceRegistry
      if (name === 'sessionPersistence') return services.sessionPersistence
      if (name === 'sessions') return services.sessions
      if (name === 'spillStore') return services.spillStore
      if (name === 'sessionProjectionCache') return services.sessionProjectionCache
      return undefined
    },
    on(event, listener) {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {}
    },
    emit(event, ...args) {
      state.emitted.push([event, ...args])
    },
    effect(fn) {
      const dispose = fn()
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    },
    webServer: { register() { return () => {} } },
    tools: { register() { return () => {} } },
  }
  return { ctx, listeners }
}

function makeServices() {
  return {
    sessionPersistence: {
      list: async () => [{
        header: { id: TRACKED, cwd: CWD, createdAt: 1700000000000 },
        sizeBytes: 7,
      }],
    },
    sessions: { list: () => [] },
    sessionProjectionCache: { requireTable: () => ({ async delete() {} }) },
    spillStore: { root: undefined },
    workspaceRegistry: {
      async deleteSession() {
        // Simulates a session manager whose delete left the transcript folder behind.
        return { deleted: true }
      },
      async deleteArchivedSessions() {
        return { deletedSessionIds: [], skippedSessionIds: [], requestedSessionIds: [] }
      },
    },
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withHome(fixture, fn) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = fixture.home
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

test('api-session/removed triggers automatic leftover cleanup', async () => {
  const fixture = await makeFixture()
  const services = makeServices()
  services.sessionPersistence.list = async () => [{
    header: { id: TRACKED, cwd: CWD, createdAt: 1700000000000 },
    sizeBytes: 7,
  }]
  const state = { emitted: [] }
  const { ctx, listeners } = makeContext(fixture.home, services, state)

  await withHome(fixture, async () => {
    apply(ctx, {})
    await wait(400) // let the delete-method hook install
    const handlers = listeners.get('api-session/removed') ?? []
    assert.equal(handlers.length, 1)
    handlers[0](ORPHAN)
    await wait(1400)
  })

  await assert.rejects(stat(fixture.orphanDir), 'orphan transcript should be removed')
  assert.equal((await stat(fixture.transcript)).isFile(), true, 'tracked session must survive')
  await rm(fixture.home, { recursive: true, force: true })
})

test('a wrapped delete method triggers automatic leftover cleanup', async () => {
  const fixture = await makeFixture()
  const services = makeServices()
  const state = { emitted: [] }
  const { ctx } = makeContext(fixture.home, services, state)

  await withHome(fixture, async () => {
    apply(ctx, {})
    await wait(500) // the hook wraps workspaceRegistry.deleteSession
    const result = await services.workspaceRegistry.deleteSession(ORPHAN)
    assert.deepEqual(result, { deleted: true })
    await wait(1400)
  })

  await assert.rejects(stat(fixture.orphanDir), 'orphan transcript should be removed by the hook')
  await rm(fixture.home, { recursive: true, force: true })
})

test('a removal event for a still-tracked session never deletes it', async () => {
  const fixture = await makeFixture()
  const services = makeServices()
  services.sessionPersistence.list = async () => [{
    header: { id: TRACKED, cwd: CWD, createdAt: 1700000000000 },
    sizeBytes: 7,
  }]
  const state = { emitted: [] }
  const { ctx, listeners } = makeContext(fixture.home, services, state)

  await withHome(fixture, async () => {
    apply(ctx, {})
    await wait(400)
    for (const handler of listeners.get('api-session/removed') ?? []) handler(TRACKED)
    await wait(1400)
  })

  assert.equal((await stat(fixture.transcript)).isFile(), true)
  assert.equal((await stat(join(fixture.project, ORPHAN))).isDirectory(), true, 'unrelated orphan is untouched')
  await rm(fixture.home, { recursive: true, force: true })
})
