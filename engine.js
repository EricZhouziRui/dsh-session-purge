/**
 * Filesystem-level DSH session purge engine.
 *
 * DSH (0.2.x) stores a session as a transcript directory under
 * `<DSH_HOME>/sessions/<encoded-cwd>/<session-id>/` and keeps several derived
 * artifacts elsewhere. Deleting only the sidebar entry (or only the transcript)
 * leaves those artifacts behind, so this module removes every trace it can
 * safely identify and reports what it did.
 *
 * The engine is deliberately plain Node (no Cordis imports) so it can be unit
 * tested against a throwaway fixture directory. Services are read lazily
 * through the injected `getService` callback.
 *
 * @module session-purge/engine
 */

import { createHash } from 'node:crypto'
import { lstat, readdir, readFile, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'

/** A session id is used as a path segment, so it must be a bare safe name.
 * Top-level DSH sessions use `session-...`; subagent sessions use a bare UUID. */
const SESSION_ID_RE = /^(?:session-[A-Za-z0-9._-]{1,120}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/

/** @param {unknown} value - untrusted session id. */
export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value)
}
/** Project folders are `--<encoded-cwd>--` or `_no-cwd`. */
const PROJECT_DIR_RE = /^--.*--$/

/** Only DSH's own project folder names may be scanned or removed as project dirs. */
function isProjectDirName(name) {
  return name === '_no-cwd' || PROJECT_DIR_RE.test(name)
}
/** A brand-new session directory may still be materializing; never treat it as an orphan. */
const MIN_ORPHAN_AGE_MS = 60_000
/** Recursion guard for directory size measurement. */
const MAX_WALK_DEPTH = 3

/** Human-readable message for any thrown value. */
export function errorMessage(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

/** Node system error code, when present. */
function errorCode(error) {
  return error !== null && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined
}

async function lstatMaybe(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
}

async function readJsonMaybe(path) {
  try {
    const text = await readFile(path, 'utf8')
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temporary, JSON.stringify(value, null, 2), 'utf8')
  await rename(temporary, path)
}

/** Recursively sum regular-file bytes under `path` without following symlinks. */
async function measurePath(path, depth = 0) {
  let stats
  try {
    stats = await lstat(path)
  } catch {
    return { bytes: 0, files: 0 }
  }
  if (stats.isSymbolicLink()) return { bytes: 0, files: 0 }
  if (stats.isFile()) return { bytes: stats.size, files: 1 }
  if (!stats.isDirectory() || depth >= MAX_WALK_DEPTH) return { bytes: 0, files: 0 }
  let bytes = 0
  let files = 0
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return { bytes: 0, files: 0 }
  }
  for (const entry of entries) {
    const child = await measurePath(join(path, entry.name), depth + 1)
    bytes += child.bytes
    files += child.files
  }
  return { bytes, files }
}

/**
 * Encode one arbitrary string as one injective filesystem-safe path segment,
 * matching the encoding the JSONL session backend uses for cwd and id.
 *
 * @param {string} raw - untrusted text.
 * @returns {string} one safe segment.
 */
export function encodeSegment(raw) {
  if (raw.length === 0) return '~'
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const character = String.fromCharCode(code)
    out += character !== '~' && /^[A-Za-z0-9._-]$/.test(character)
      ? character
      : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

/**
 * Project folder name for one cwd, matching the JSONL session backend.
 *
 * @param {string | undefined} cwd - session working directory.
 * @returns {string} the encoded project directory name.
 */
export function projectFolderName(cwd) {
  if (cwd === undefined || cwd === null || cwd.length === 0) return '_no-cwd'
  const readable = encodeSegment(cwd.replace(/[\\/:]+/g, '-')).replace(/^-+/, '') || 'root'
  return `--${readable.slice(0, 251)}--`
}

/**
 * Expected transcript directory for one session.
 *
 * @param {string} sessionsRoot - `<DSH_HOME>/sessions`.
 * @param {string} id - session id.
 * @param {string | undefined} cwd - session working directory.
 * @returns {string} absolute expected directory.
 */
export function expectedSessionDir(sessionsRoot, id, cwd) {
  return join(sessionsRoot, projectFolderName(cwd), id)
}

/**
 * Session-scoped spill directory name (sha256 prefix of the session id).
 *
 * @param {string} id - session id.
 * @returns {string} the spill directory name.
 */
export function spillDirName(id) {
  return `session-${createHash('sha256').update(id).digest('hex').slice(0, 12)}`
}

/** Remove one directory if it contains no entries except macOS `.DS_Store`. */
async function removeDirIfEmpty(path) {
  let entries
  try {
    entries = await readdir(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return true
    return false
  }
  for (const name of entries) {
    if (name === '.DS_Store') {
      try {
        await unlink(join(path, name))
      } catch {
        return false
      }
      continue
    }
    return false
  }
  try {
    await rmdir(path)
    return true
  } catch (error) {
    return errorCode(error) === 'ENOENT'
  }
}

/**
 * Create a purge engine bound to one DSH home directory.
 *
 * @param {object} options
 * @param {string} options.home - DSH home (`~/.dsh`).
 * @param {(name: string) => unknown} [options.getService] - lazy Host service lookup.
 * @param {(event: string, id: string) => void} [options.emit] - Host event emitter.
 * @param {(message: string) => void} [options.warn] - diagnostic sink.
 * @param {string | undefined} [options.currentSessionId] - session that must never be deleted.
 * @returns {object} engine with `list`, `purge`, `cleanup`.
 */
export function createEngine(options) {
  const home = options.home
  const getService = options.getService ?? (() => undefined)
  const emit = options.emit ?? (() => {})
  const warn = options.warn ?? (() => {})
  const currentSessionId = options.currentSessionId

  const sessionsRoot = join(home, 'sessions')
  const storagesRoot = join(home, 'storages')
  const projectionCacheDir = join(storagesRoot, 'session_projcache', 'sessions')
  const workspaceFile = join(storagesRoot, 'workspace.json')
  const favoritesFile = join(storagesRoot, 'archive_manager_favorites.json')

  const service = (name) => {
    try {
      return getService(name)
    } catch {
      return undefined
    }
  }

  function assertSessionId(id) {
    if (!isSessionId(id)) {
      throw new Error(`不是合法的会话 ID：${String(id)}`)
    }
  }

  /** Stored sessions as reported by the session persistence service. */
  async function trackedSessions() {
    const persistence = service('sessionPersistence')
    if (persistence === undefined || typeof persistence.list !== 'function') {
      return { ok: false, entries: new Map(), reason: '会话持久化服务不可用' }
    }
    try {
      const snapshots = await persistence.list()
      const entries = new Map()
      for (const snapshot of snapshots ?? []) {
        const id = snapshot?.header?.id
        if (typeof id === 'string') entries.set(id, snapshot)
      }
      return { ok: true, entries }
    } catch (error) {
      return { ok: false, entries: new Map(), reason: errorMessage(error) }
    }
  }

  /** Every transcript directory on disk, grouped by session id and project folder. */
  async function scanDiskSessions() {
    const byId = new Map()
    const projects = new Map()
    let entries
    try {
      entries = await readdir(sessionsRoot, { withFileTypes: true })
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return { byId, projects, rootExists: false }
      throw error
    }
    for (const projectEntry of entries) {
      if (!projectEntry.isDirectory() || projectEntry.name.startsWith('.')) continue
      // Anything else under sessions/ is not a DSH project folder. Scanning it
      // would offer "orphan sessions" that safeSessionDirectories then refuses
      // to delete, and could let empty-folder cleanup touch unrelated data.
      if (!isProjectDirName(projectEntry.name)) continue
      const projectPath = join(sessionsRoot, projectEntry.name)
      const project = { name: projectEntry.name, path: projectPath, sessionIds: [], hasOtherEntries: false }
      let children
      try {
        children = await readdir(projectPath, { withFileTypes: true })
      } catch {
        continue
      }
      for (const child of children) {
        if (!child.isDirectory() || !SESSION_ID_RE.test(child.name)) {
          if (child.name !== '.DS_Store') project.hasOtherEntries = true
          continue
        }
        const dirPath = join(projectPath, child.name)
        let stats
        try {
          stats = await lstat(dirPath)
        } catch {
          continue
        }
        if (stats.isSymbolicLink() || !stats.isDirectory()) continue
        const size = await measurePath(dirPath)
        const record = {
          id: child.name,
          dirPath,
          projectPath,
          projectName: projectEntry.name,
          bytes: size.bytes,
          files: size.files,
          mtimeMs: stats.mtimeMs,
        }
        project.sessionIds.push(child.name)
        const existing = byId.get(record.id)
        if (existing === undefined) byId.set(record.id, [record])
        else existing.push(record)
      }
      projects.set(projectEntry.name, project)
    }
    return { byId, projects, rootExists: true }
  }

  /** Projection-cache records (title, cwd, creation time, size). */
  async function scanProjectionCaches() {
    const records = new Map()
    let entries
    try {
      entries = await readdir(projectionCacheDir)
    } catch {
      return records
    }
    for (const name of entries) {
      if (!name.endsWith('.json')) continue
      const id = name.slice(0, -'.json'.length)
      if (!SESSION_ID_RE.test(id)) continue
      const path = join(projectionCacheDir, name)
      const stats = await lstatMaybe(path)
      const data = await readJsonMaybe(path)
      const rows = data?.record?.rows
      const title = rows?.title?.val
      const identity = data?.record?.identity
      const lastPromptAt = rows?.sessionListMetadata?.val?.lastPromptAt
      const blank = rows?.sessionListMetadata?.val?.blank === true
      const turns = rows?.sessionStats?.val?.turns
      records.set(id, {
        path,
        bytes: stats?.size ?? 0,
        title: typeof title === 'string' && title.trim().length > 0 ? title.trim() : undefined,
        cwd: typeof identity?.cwd === 'string' ? identity.cwd : undefined,
        createdAt: typeof identity?.createdAt === 'number' ? identity.createdAt : undefined,
        lastPromptAt: typeof lastPromptAt === 'number' ? lastPromptAt : undefined,
        blank,
        turns: typeof turns === 'number' ? turns : undefined,
      })
    }
    return records
  }

  /** Workspace accounting: workspace membership, archived and pinned ids. */
  async function readWorkspaceState() {
    const data = await readJsonMaybe(workspaceFile)
    const state = { ok: data !== undefined, workspaceBySession: new Map(), archived: new Set(), pinned: new Set(), workspaces: [] }
    if (data === undefined) return state
    for (const id of data?.global?.archivedSessionIds ?? []) {
      if (typeof id === 'string') state.archived.add(id)
    }
    for (const id of data?.global?.pinnedSessionIds ?? []) {
      if (typeof id === 'string') state.pinned.add(id)
    }
    const tables = data?.tables?.workspaces
    if (tables !== null && typeof tables === 'object') {
      for (const [workspaceId, record] of Object.entries(tables)) {
        const sessionIds = Array.isArray(record?.sessionIds)
          ? record.sessionIds.filter((id) => typeof id === 'string')
          : []
        const info = {
          id: workspaceId,
          path: typeof record?.path === 'string' ? record.path : '',
          title: typeof record?.title === 'string' ? record.title : '',
          sessionIds,
        }
        state.workspaces.push(info)
        for (const sessionId of sessionIds) {
          const list = state.workspaceBySession.get(sessionId) ?? []
          list.push({ workspaceId, path: info.path || undefined, title: info.title || undefined })
          state.workspaceBySession.set(sessionId, list)
        }
      }
    }
    return state
  }

  /** Sessions marked as favorites by the archive-manager plugin, when installed. */
  async function readFavorites() {
    const data = await readJsonMaybe(favoritesFile)
    const ids = new Set()
    for (const id of data?.global?.favoriteSessionIds ?? []) {
      if (typeof id === 'string') ids.add(id)
    }
    return ids
  }

  /** Session ids that currently have a live in-memory agent. */
  function liveSessionIds() {
    const sessions = service('sessions')
    if (sessions === undefined || typeof sessions.list !== 'function') return new Set()
    try {
      return new Set((sessions.list() ?? []).map((session) => session?.id).filter((id) => typeof id === 'string'))
    } catch {
      return new Set()
    }
  }

  /** The live in-memory session for `id`, when one exists. */
  function liveSessionFor(id) {
    const sessions = service('sessions')
    if (sessions === undefined || typeof sessions.get !== 'function') return undefined
    try {
      return sessions.get(id)
    } catch {
      return undefined
    }
  }

  /**
   * Flush a live session and detach it from the Host store before its files are
   * removed. Files alone cannot stop an in-memory writer, so this is the closest
   * Host API allows us to get to "the session no longer exists".
   *
   * @param {string} id - session id.
   * @returns {Promise<{ live: boolean, detached: boolean }>} release outcome.
   */
  async function releaseLiveSession(id) {
    const sessions = service('sessions')
    if (sessions === undefined) return { live: false, detached: false }
    const live = liveSessionFor(id)
    if (live === undefined) return { live: false, detached: false }
    try {
      if (typeof sessions.flush === 'function') await sessions.flush(live)
    } catch (error) {
      warn(`刷新运行中会话 ${id} 失败：${errorMessage(error)}`)
    }
    let detached = false
    try {
      const entry = typeof sessions.liveEntryFor === 'function' ? sessions.liveEntryFor(live) : undefined
      if (entry !== undefined && typeof sessions.detachEntered === 'function') {
        sessions.detachEntered(entry)
        detached = true
      }
    } catch (error) {
      warn(`从 Host 分离运行中会话 ${id} 失败：${errorMessage(error)}`)
    }
    return { live: true, detached }
  }

  /**
   * Ask the archive-manager (when installed) which sessions its in-memory header
   * index still considers to be missing a usable list cache. Stale index entries
   * for already-deleted sessions are what make its "rebuiled cache" button report
   * 10 skipped items, so we surface and clean them.
   */
  async function archiveCacheDiagnosis() {
    const registry = service('workspaceRegistry')
    if (registry === null || typeof registry !== 'object' || typeof registry.diagnoseSessionCaches !== 'function') return undefined
    try {
      const result = await registry.diagnoseSessionCaches()
      if (result === null || typeof result !== 'object') return undefined
      const items = Array.isArray(result.items) ? result.items : []
      const ids = []
      for (const item of items) {
        if (item !== null && typeof item === 'object' && typeof item.sessionId === 'string') ids.push(item.sessionId)
      }
      return { count: typeof result.count === 'number' ? result.count : ids.length, ids }
    } catch (error) {
      warn(`读取 archive-manager 缓存诊断失败：${errorMessage(error)}`)
      return undefined
    }
  }

  /** Remove one id from the archive-manager's in-memory header index when present. */
  async function forgetArchiveIndex(id) {
    const registry = service('workspaceRegistry')
    if (registry === null || typeof registry !== 'object') return false
    try {
      if (typeof registry.forgetIndexedSession === 'function') {
        registry.forgetIndexedSession(id)
        return true
      }
      let removed = false
      for (const key of ['headers', 'sessionPaths', 'invalidSessionPaths', 'missingSessionPaths']) {
        const map = registry[key]
        if (map !== undefined && map !== null && typeof map.delete === 'function' && map.has?.(id) === true) {
          map.delete(id)
          removed = true
        }
      }
      return removed
    } catch (error) {
      warn(`清理 archive-manager 会话索引 ${id} 失败：${errorMessage(error)}`)
      return false
    }
  }

  /** Spill roots that may hold session-scoped files. */
  async function spillDirectoriesFor(ids) {
    const root = service('spillStore')?.root
    const result = new Map()
    if (typeof root !== 'string' || root.length === 0) return result
    let entries = []
    try {
      entries = await readdir(root)
    } catch {
      return result
    }
    const present = new Set(entries)
    for (const id of ids) {
      const name = spillDirName(id)
      if (present.has(name)) result.set(id, join(root, name))
    }
    return result
  }

  /**
   * Write one JSON file back only when `mutate` changes it.
   * @returns {Promise<boolean>} whether a write happened.
   */
  async function mutateJsonFile(path, mutate) {
    const data = await readJsonMaybe(path)
    if (data === undefined) return false
    const changed = mutate(data) === true
    if (!changed) return false
    await writeJsonAtomic(path, data)
    return true
  }

  /** Remove a session id from workspace.json accounting arrays. */
  async function cleanWorkspaceFile(id) {
    try {
      return await mutateJsonFile(workspaceFile, (data) => {
        let changed = false
        const arrays = ['archivedSessionIds', 'pinnedSessionIds']
        for (const key of arrays) {
          const list = data?.global?.[key]
          if (!Array.isArray(list)) continue
          const next = list.filter((entry) => entry !== id)
          if (next.length !== list.length) {
            data.global[key] = next
            changed = true
          }
        }
        const tables = data?.tables?.workspaces
        if (tables !== null && typeof tables === 'object') {
          for (const record of Object.values(tables)) {
            if (!Array.isArray(record?.sessionIds)) continue
            const next = record.sessionIds.filter((entry) => entry !== id)
            if (next.length !== record.sessionIds.length) {
              record.sessionIds = next
              changed = true
            }
          }
        }
        return changed
      })
    } catch (error) {
      warn(`清理 workspace.json 失败：${errorMessage(error)}`)
      return false
    }
  }

  /** Remove a session id from the archive-manager favorites file. */
  async function removeFavorite(id) {
    try {
      return await mutateJsonFile(favoritesFile, (data) => {
        const list = data?.global?.favoriteSessionIds
        if (!Array.isArray(list)) return false
        const next = list.filter((entry) => entry !== id)
        if (next.length === list.length) return false
        data.global.favoriteSessionIds = next
        return true
      })
    } catch (error) {
      warn(`清理收藏记录失败：${errorMessage(error)}`)
      return false
    }
  }

  /** Detach one session from every workspace entity and durable accounting list. */
  async function detachWorkspaceReferences(id) {
    const registry = service('workspaceRegistry')
    let detached = false
    if (registry !== undefined && typeof registry.list === 'function') {
      try {
        for (const workspace of registry.list() ?? []) {
          if (workspace !== null && typeof workspace === 'object' && typeof workspace.detachSession === 'function') {
            await workspace.detachSession(id)
            detached = true
          }
        }
      } catch (error) {
        warn(`从工作区分离会话失败：${errorMessage(error)}`)
      }
    }
    if (registry !== undefined && typeof registry.requireState === 'function' && typeof registry.setState === 'function') {
      try {
        const state = registry.requireState()
        const archived = Array.isArray(state?.archivedSessionIds) ? state.archivedSessionIds : []
        const pinned = Array.isArray(state?.pinnedSessionIds) ? state.pinnedSessionIds : []
        const nextArchived = archived.filter((entry) => entry !== id)
        const nextPinned = pinned.filter((entry) => entry !== id)
        if (nextArchived.length !== archived.length || nextPinned.length !== pinned.length) {
          await registry.setState({ ...state, archivedSessionIds: nextArchived, pinnedSessionIds: nextPinned })
        }
      } catch (error) {
        warn(`清理归档/置顶记录失败：${errorMessage(error)}`)
      }
    }
    const fileTouched = await cleanWorkspaceFile(id)
    return { detached, fileTouched }
  }

  /** Delete one projection-cache record through the service, else on disk. */
  async function removeProjectionCache(id) {
    const cache = service('sessionProjectionCache')
    if (cache !== undefined && typeof cache.requireTable === 'function') {
      try {
        const table = cache.requireTable()
        if (table !== undefined && typeof table.delete === 'function') await table.delete(id)
      } catch (error) {
        warn(`通过投影缓存服务删除 ${id} 失败，改为直接删除文件：${errorMessage(error)}`)
      }
    }
    // A stale record (session already deleted) may not be tracked by the live
    // cache table, so always fall back to the file the service stores it in.
    const path = join(projectionCacheDir, `${id}.json`)
    if (await lstatMaybe(path) === undefined) return false
    await rm(path, { force: true })
    return true
  }

  /** Delete the session-scoped spill directory when it exists. */
  async function removeSpillDirectory(id) {
    const root = service('spillStore')?.root
    if (typeof root !== 'string' || root.length === 0) return false
    const path = join(root, spillDirName(id))
    if (await lstatMaybe(path) === undefined) return false
    await rm(path, { recursive: true, force: true })
    return true
  }

  /**
   * Resolve candidate directories to canonical paths that really are
   * `<sessionsRoot>/<project>/<id>` and not symlinks leaving the root.
   */
  async function safeSessionDirectories(candidates, id) {
    const safe = []
    const seen = new Set()
    let rootReal
    try {
      rootReal = await realpath(sessionsRoot)
    } catch {
      return safe
    }
    for (const candidate of candidates) {
      if (typeof candidate !== 'string' || candidate.length === 0) continue
      // realpath() deliberately resolves symlinks, but a symlinked project or
      // session directory must never become a deletion target: reject it before
      // resolving, so the recursive delete can only touch real directories under
      // the sessions root.
      const direct = await lstatMaybe(candidate)
      if (direct === undefined || direct.isSymbolicLink() || !direct.isDirectory()) {
        warn(`跳过符号链接或非目录路径：${candidate}`)
        continue
      }
      const parent = await lstatMaybe(dirname(candidate))
      if (parent === undefined || parent.isSymbolicLink() || !parent.isDirectory()) {
        warn(`跳过符号链接或非目录的项目路径：${dirname(candidate)}`)
        continue
      }
      let resolved
      try {
        resolved = await realpath(candidate)
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue
        warn(`无法解析会话目录 ${candidate}：${errorMessage(error)}`)
        continue
      }
      const rel = relative(rootReal, resolved)
      const parts = rel.split(sep)
      if (parts.length !== 2) {
        warn(`跳过不在会话目录结构内的路径：${resolved}`)
        continue
      }
      const [projectName, sessionName] = parts
      const allowedProject = projectName === '_no-cwd' || PROJECT_DIR_RE.test(projectName)
      if (!allowedProject || sessionName !== id) {
        warn(`跳过与目标会话不匹配的路径：${resolved}`)
        continue
      }
      if (seen.has(resolved)) continue
      seen.add(resolved)
      safe.push(resolved)
    }
    return safe
  }

  /** Build the merged, read-only view used by both list and cleanup. */
  async function analyze() {
    const [tracked, disk, caches, workspace, favorites, archive] = await Promise.all([
      trackedSessions(),
      scanDiskSessions(),
      scanProjectionCaches(),
      readWorkspaceState(),
      readFavorites(),
      archiveCacheDiagnosis(),
    ])
    const live = liveSessionIds()
    const warnings = []
    if (!tracked.ok) warnings.push(`无法读取会话列表：${tracked.reason}。为避免误删，残留清理已停用。`)
    // An empty stored list beside transcript directories on disk means the
    // persistence backend is not reporting what is actually there; never treat
    // those directories as orphans.
    const orphanSafe = tracked.ok && !(tracked.entries.size === 0 && disk.byId.size > 0)
    if (tracked.ok && !orphanSafe) warnings.push('会话列表为空但磁盘上存在会话目录，已停用残留识别以避免误删。')
    if (!workspace.ok) warnings.push('无法读取 workspace.json，工作区归属信息不可用（不影响删除会话文件）。')

    const ids = new Set([...tracked.entries.keys(), ...disk.byId.keys(), ...caches.keys()])
    const sessions = []
    for (const id of ids) {
      const snapshot = tracked.entries.get(id)
      const diskEntries = disk.byId.get(id) ?? []
      if (snapshot === undefined && diskEntries.length === 0) continue
      const cache = caches.get(id)
      const header = snapshot?.header
      const cwd = header?.cwd ?? cache?.cwd
      const createdAt = typeof header?.createdAt === 'number'
        ? header.createdAt
        : cache?.createdAt ?? diskEntries[0]?.mtimeMs ?? 0
      let bytes = diskEntries.reduce((total, entry) => total + entry.bytes, 0)
      if (diskEntries.length === 0 && typeof snapshot?.sizeBytes === 'number') bytes = snapshot.sizeBytes
      const workspaceEntries = workspace.workspaceBySession.get(id) ?? []
      const session = {
        id,
        title: cache?.title ?? '',
        cwd: typeof cwd === 'string' ? cwd : '',
        // Subagent transcripts share the sessions tree but are delegation
        // internals, not conversations the user can manage. Keep the flag so the
        // UI/tool list can hide them; purge() can still delete one by explicit id.
        subagent: header?.origin === 'subagent' || typeof header?.parentSession === 'string',
        createdAt,
        live: live.has(id),
        tracked: snapshot !== undefined,
        orphan: snapshot === undefined,
        bytes,
        files: diskEntries.reduce((total, entry) => total + entry.files, 0),
        turns: cache?.turns ?? 0,
        blank: cache === undefined ? false : cache.blank === true || ((cache.turns ?? 0) === 0 && (cache.title ?? '').length === 0),
        mtimeMs: diskEntries[0]?.mtimeMs ?? 0,
        dirPaths: diskEntries.map((entry) => entry.dirPath),
        projectPaths: [...new Set(diskEntries.map((entry) => entry.projectPath))],
        workspaceIds: workspaceEntries.map((entry) => entry.workspaceId),
        traces: {
          projectionCache: caches.has(id),
          workspaces: workspaceEntries.map((entry) => entry.path ?? entry.title ?? entry.workspaceId).filter(Boolean),
          archived: workspace.archived.has(id),
          pinned: workspace.pinned.has(id),
          favorite: favorites.has(id),
          spill: false,
        },
      }
      sessions.push(session)
    }

    // A tracked session whose transcript directory the scan missed (e.g. it was
    // just materialized) still gets an expected directory for deletion.
    for (const session of sessions) {
      if (session.dirPaths.length > 0) continue
      const candidate = expectedSessionDir(sessionsRoot, session.id, session.cwd || undefined)
      const stats = await lstatMaybe(candidate)
      if (stats !== undefined && stats.isDirectory() && !stats.isSymbolicLink()) {
        const size = await measurePath(candidate)
        session.dirPaths = [candidate]
        session.projectPaths = [dirname(candidate)]
        session.bytes = size.bytes
        session.files = size.files
        session.mtimeMs = stats.mtimeMs
      }
    }

    const spillDirs = await spillDirectoriesFor(sessions.map((session) => session.id))
    for (const session of sessions) {
      session.traces.spill = spillDirs.has(session.id)
    }

    const now = Date.now()
    const orphanSessionIds = orphanSafe
      ? sessions
        .filter((session) => session.orphan && !session.live && session.dirPaths.length > 0)
        .filter((session) => session.mtimeMs === 0 || now - session.mtimeMs >= MIN_ORPHAN_AGE_MS)
        .map((session) => session.id)
      : []
    const orphanBytes = sessions
      .filter((session) => orphanSessionIds.includes(session.id))
      .reduce((total, session) => total + session.bytes, 0)

    const staleProjectionCacheIds = orphanSafe
      ? [...caches.keys()].filter((id) => !tracked.entries.has(id) && !disk.byId.has(id) && !live.has(id))
      : []
    const staleProjectionCacheBytes = staleProjectionCacheIds
      .reduce((total, id) => total + (caches.get(id)?.bytes ?? 0), 0)

    const accountedIds = new Set([...workspace.workspaceBySession.keys(), ...workspace.archived, ...workspace.pinned, ...favorites])
    const staleWorkspaceRefIds = orphanSafe
      ? [...accountedIds].filter((id) => !tracked.entries.has(id) && !disk.byId.has(id) && !live.has(id))
      : []
    const staleFavoriteIds = orphanSafe
      ? [...favorites].filter((id) => !tracked.entries.has(id) && !disk.byId.has(id) && !live.has(id))
      : []
    // Sessions the archive-manager still remembers in its header index although
    // the durable log and transcript are gone. Rebuilding their cache always
    // skips; forgetting them is the correct cleanup.
    const staleIndexIds = orphanSafe && archive !== undefined
      ? archive.ids.filter((id) => !tracked.entries.has(id) && !disk.byId.has(id) && !live.has(id))
      : []

    const emptyProjectDirs = [...disk.projects.values()]
      .filter((project) => project.sessionIds.length === 0)
      .map((project) => ({ name: project.name, path: project.path }))

    sessions.sort((left, right) => {
      if (left.live !== right.live) return left.live ? -1 : 1
      return right.createdAt - left.createdAt
    })

    return {
      home,
      sessionsRoot,
      sessions,
      workspaces: workspace.workspaces,
      trackedOk: tracked.ok,
      orphanSafe,
      trackedCount: tracked.entries.size,
      liveCount: sessions.filter((session) => session.live).length,
      orphanSessionIds,
      orphanBytes,
      staleProjectionCacheIds,
      staleProjectionCacheBytes,
      staleWorkspaceRefIds,
      staleFavoriteIds,
      staleIndexIds,
      archiveDiagnosis: archive === undefined ? undefined : { count: archive.count, sessionIds: archive.ids },
      emptyProjectDirs,
      warnings,
      cachePaths: new Map([...caches].map(([id, record]) => [id, record.path])),
      spillDirs,
    }
  }

  /** Public JSON view of one analysis. */
  function present(analysis) {
    const visibleSessions = analysis.sessions.filter((session) => session.subagent !== true)
    return {
      ok: true,
      home: analysis.home,
      sessionsRoot: analysis.sessionsRoot,
      generatedAt: Date.now(),
      sessions: visibleSessions,
      workspaces: analysis.workspaces,
      trackedOk: analysis.trackedOk,
      orphanSafe: analysis.orphanSafe,
      cleanup: {
        orphanSessionIds: analysis.orphanSessionIds,
        orphanBytes: analysis.orphanBytes,
        staleProjectionCacheIds: analysis.staleProjectionCacheIds,
        staleProjectionCacheBytes: analysis.staleProjectionCacheBytes,
        staleWorkspaceRefIds: analysis.staleWorkspaceRefIds,
        staleFavoriteIds: analysis.staleFavoriteIds,
        staleIndexIds: analysis.staleIndexIds,
        emptyProjectDirs: analysis.emptyProjectDirs,
        reclaimableBytes: analysis.orphanBytes + analysis.staleProjectionCacheBytes,
      },
      counts: {
        sessions: visibleSessions.length,
        tracked: visibleSessions.filter((session) => session.tracked).length,
        live: visibleSessions.filter((session) => session.live).length,
        orphans: analysis.orphanSessionIds.length,
        staleProjectionCaches: analysis.staleProjectionCacheIds.length,
        staleWorkspaceRefs: analysis.staleWorkspaceRefIds.length,
        staleIndexEntries: analysis.staleIndexIds.length,
      },
      archive: analysis.archiveDiagnosis,
      warnings: analysis.warnings,
    }
  }

  /**
   * Permanently delete one analyzed session and every trace it owns.
   * @param {string} id - session id.
   * @param {object} analysis - current analysis.
   * @param {{ dryRun?: boolean, allowLive?: boolean }} options - behavior flags.
   * @returns {Promise<object>} per-session result.
   */
  async function purgeFromAnalysis(id, analysis, options) {
    const dryRun = options?.dryRun === true
    const allowLive = options?.allowLive === true
    assertSessionId(id)
    const session = analysis.sessions.find((entry) => entry.id === id)
    const isLive = session?.live === true || liveSessionIds().has(id)
    if (isLive && !allowLive) {
      return { sessionId: id, status: 'skipped', reason: '会话仍在运行中；需要明确允许删除运行中会话才会执行' }
    }
    if (currentSessionId !== undefined && id === currentSessionId && !allowLive) {
      return { sessionId: id, status: 'skipped', reason: '当前会话正在使用中；需要明确允许删除运行中会话才会执行' }
    }

    const candidates = [...(session?.dirPaths ?? [])]
    const snapshot = (await trackedSessions()).entries.get(id)
    if (snapshot?.location?.path !== undefined) {
      const locationPath = snapshot.location.path
      const locationDir = dirname(locationPath)
      if (locationDir !== sessionsRoot) candidates.push(locationDir)
    }
    if (candidates.length === 0 && session !== undefined) {
      candidates.push(expectedSessionDir(sessionsRoot, id, session.cwd || undefined))
    }
    const directories = await safeSessionDirectories(candidates, id)

    const cachePath = analysis.cachePaths.get(id) ?? join(projectionCacheDir, `${id}.json`)
    const cacheExists = await lstatMaybe(cachePath) !== undefined
    const spillPath = analysis.spillDirs.get(id) ?? (typeof service('spillStore')?.root === 'string' ? join(service('spillStore').root, spillDirName(id)) : undefined)
    const spillExists = spillPath !== undefined && await lstatMaybe(spillPath) !== undefined
    const hasDiskTrace = directories.length > 0 || cacheExists || spillExists

    // An "orphan" is only known from the disk scan. If every scanned directory
    // was rejected by the canonical-path guard (symlink, unexpected project,
    // concurrently deleted, ...) there is nothing this call could safely delete;
    // report missing instead of claiming a successful deletion.
    if (!hasDiskTrace && (session === undefined || session.orphan)) {
      return { sessionId: id, status: 'missing', reason: '没有找到可安全删除的会话目录（可能已删除或不是 DSH 项目目录）', live: isLive }
    }

    if (dryRun) {
      return {
        sessionId: id,
        status: 'planned',
        live: isLive,
        bytes: session?.bytes ?? 0,
        paths: [
          ...directories,
          ...(cacheExists ? [`${cachePath}（投影缓存）`] : []),
          ...(spillExists ? [`${spillPath}（溢出文件）`] : []),
        ],
      }
    }

    // A live session keeps an in-memory writer; flush and detach it first so the
    // files we are about to delete are not immediately re-materialized.
    const release = isLive ? await releaseLiveSession(id) : { live: false, detached: false }

    const workspace = await detachWorkspaceReferences(id)
    const favoriteRemoved = await removeFavorite(id)
    const cacheRemoved = await removeProjectionCache(id)
    const spillRemoved = await removeSpillDirectory(id)
    const removed = []
    for (const directory of directories) {
      await rm(directory, { recursive: true, force: true })
      removed.push(directory)
    }
    const projects = new Set(directories.map((directory) => dirname(directory)))
    for (const project of projects) await removeDirIfEmpty(project)
    await forgetArchiveIndex(id)
    try {
      emit('api-session/removed', id)
    } catch (error) {
      warn(`发送会话移除事件失败：${errorMessage(error)}`)
    }
    return {
      sessionId: id,
      status: 'deleted',
      live: release.live || isLive,
      detached: release.detached,
      bytes: session?.bytes ?? 0,
      removed,
      cacheRemoved,
      spillRemoved,
      favoriteRemoved,
      workspaceFileTouched: workspace.fileTouched,
    }
  }

  return {
    /**
     * List sessions and reclaimable leftovers.
     * @returns {Promise<object>} report.
     */
    async list() {
      return present(await analyze())
    },

    /**
     * Permanently delete the given sessions.
     * @param {string[]} ids - session ids.
     * @param {{ dryRun?: boolean, allowLive?: boolean }} [options] - flags.
     * @returns {Promise<object>} per-session results.
     */
    async purge(ids, options = {}) {
      if (!Array.isArray(ids) || ids.length === 0) throw new Error('没有指定要删除的会话')
      const analysis = await analyze()
      const results = []
      for (const id of ids) {
        try {
          results.push(await purgeFromAnalysis(String(id), analysis, options))
        } catch (error) {
          results.push({ sessionId: String(id), status: 'failed', error: errorMessage(error) })
        }
      }
      return {
        ok: results.every((result) => result.status !== 'failed'),
        dryRun: options.dryRun === true,
        results,
        bytes: results.reduce((total, result) => total + (result.status === 'deleted' ? (result.bytes ?? 0) : 0), 0),
      }
    },

    /**
     * Finish a deletion another plugin already started: clean every remaining
     * trace of `id` only when the session is no longer reported by the durable
     * session list (so a normal agent disposal never deletes a live session).
     *
     * @param {string} id - session id that something just removed.
     * @returns {Promise<object>} per-session result.
     */
    async reconcile(id) {
      assertSessionId(id)
      const analysis = await analyze()
      const session = analysis.sessions.find((entry) => entry.id === id)
      if (!analysis.trackedOk || !analysis.orphanSafe) {
        return { sessionId: id, status: 'skipped', reason: '无法确认会话持久化列表，已跳过自动清理' }
      }
      if (session?.tracked === true) {
        return { sessionId: id, status: 'skipped', reason: '会话仍存在于会话列表，未执行清理' }
      }
      // The other plugin already declared this session permanently deleted, so a
      // leftover live object must not block cleaning its remnant files.
      const result = await purgeFromAnalysis(id, analysis, { allowLive: true })
      const projects = new Set(session?.projectPaths ?? [])
      if (projects.size === 0 && typeof session?.cwd === 'string' && session.cwd.length > 0) {
        projects.add(join(sessionsRoot, projectFolderName(session.cwd)))
      }
      for (const project of projects) await removeDirIfEmpty(project)
      return result
    },

    /**
     * Remove orphan transcripts, stale caches and stale workspace references.
     * @param {{ dryRun?: boolean }} [options] - flags.
     * @returns {Promise<object>} cleanup report.
     */
    async cleanup(options = {}) {
      const dryRun = options.dryRun === true
      const analysis = await analyze()
      if (!analysis.trackedOk || !analysis.orphanSafe) {
        return {
          ok: false,
          error: '无法确认会话持久化列表，为避免误删已跳过残留清理',
          warnings: analysis.warnings,
        }
      }
      const removedSessions = []
      for (const id of analysis.orphanSessionIds) {
        try {
          removedSessions.push(await purgeFromAnalysis(id, analysis, { dryRun, allowLive: false }))
        } catch (error) {
          removedSessions.push({ sessionId: id, status: 'failed', error: errorMessage(error) })
        }
      }
      const removedCaches = []
      for (const id of analysis.staleProjectionCacheIds) {
        if (dryRun) {
          removedCaches.push({ sessionId: id, status: 'planned' })
          continue
        }
        try {
          const path = analysis.cachePaths.get(id)
          let removed = false
          if (path !== undefined) {
            removed = await lstatMaybe(path) !== undefined
          }
          if (removed) {
            await removeProjectionCache(id)
            removedCaches.push({ sessionId: id, status: 'deleted' })
          }
          const cacheFile = path ?? join(projectionCacheDir, `${id}.json`)
          if (await lstatMaybe(cacheFile) !== undefined) {
            await rm(cacheFile, { force: true })
          }
        } catch (error) {
          removedCaches.push({ sessionId: id, status: 'failed', error: errorMessage(error) })
        }
      }
      const cleanedRefs = []
      for (const id of new Set([...analysis.staleWorkspaceRefIds, ...analysis.staleFavoriteIds])) {
        if (dryRun) {
          cleanedRefs.push({ sessionId: id, status: 'planned' })
          continue
        }
        try {
          await detachWorkspaceReferences(id)
          await removeFavorite(id)
          cleanedRefs.push({ sessionId: id, status: 'cleaned' })
        } catch (error) {
          cleanedRefs.push({ sessionId: id, status: 'failed', error: errorMessage(error) })
        }
      }
      const cleanedIndex = []
      for (const id of analysis.staleIndexIds) {
        if (dryRun) {
          cleanedIndex.push({ sessionId: id, status: 'planned' })
          continue
        }
        try {
          const forgotten = await forgetArchiveIndex(id)
          const cacheRemoved = await removeProjectionCache(id)
          await detachWorkspaceReferences(id)
          await removeFavorite(id)
          cleanedIndex.push({ sessionId: id, status: forgotten || cacheRemoved ? 'cleaned' : 'gone' })
        } catch (error) {
          cleanedIndex.push({ sessionId: id, status: 'failed', error: errorMessage(error) })
        }
      }
      const cleanedProjects = []
      for (const project of analysis.emptyProjectDirs) {
        if (dryRun) {
          cleanedProjects.push({ path: project.path, status: 'planned' })
          continue
        }
        try {
          const removed = await removeDirIfEmpty(project.path)
          cleanedProjects.push({ path: project.path, status: removed ? 'deleted' : 'kept' })
        } catch (error) {
          cleanedProjects.push({ path: project.path, status: 'failed', error: errorMessage(error) })
        }
      }
      // Projects that became empty after orphan transcript deletion.
      if (!dryRun) {
        const projects = new Set(analysis.orphanSessionIds.flatMap((id) => analysis.sessions.find((session) => session.id === id)?.projectPaths ?? []))
        for (const project of projects) {
          if (cleanedProjects.some((entry) => entry.path === project)) continue
          try {
            const removed = await removeDirIfEmpty(project)
            if (removed) cleanedProjects.push({ path: project, status: 'deleted' })
          } catch (error) {
            cleanedProjects.push({ path: project, status: 'failed', error: errorMessage(error) })
          }
        }
      }
      return {
        ok: [...removedSessions, ...removedCaches, ...cleanedRefs, ...cleanedIndex, ...cleanedProjects]
          .every((result) => result.status !== 'failed'),
        dryRun,
        analysis: present(analysis),
        removedSessions,
        removedCaches,
        cleanedRefs,
        cleanedIndex,
        cleanedProjects,
        bytes: analysis.orphanBytes + analysis.staleProjectionCacheBytes,
      }
    },
  }
}
