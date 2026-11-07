/**
 * Host half of the "彻底删除会话 / Session purge" bundle.
 *
 * Registers three same-origin HTTP endpoints consumed by the settings page and
 * one agent tool that shares the exact same engine, so the UI and the model
 * never maintain separate deletion logic.
 *
 * @module session-purge
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { createEngine, errorMessage, isSessionId } from './engine.js'

export const name = 'session-purge'
export const inject = ['webServer', 'tools']

const LIST_ENDPOINT = '/api/session-purge/list'
const PURGE_ENDPOINT = '/api/session-purge/purge'
const CLEANUP_ENDPOINT = '/api/session-purge/cleanup'

/** JSON response helper. */
function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

/** Read a bounded JSON object body. */
function readJsonBody(request) {
  return new Promise((resolve) => {
    const chunks = []
    let bytes = 0
    let tooLarge = false
    request.on('data', (chunk) => {
      if (tooLarge) return
      bytes += chunk.length
      if (bytes > 1024 * 1024) {
        tooLarge = true
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (tooLarge) {
        resolve(undefined)
        return
      }
      try {
        const raw = Buffer.concat(chunks).toString('utf8')
        const parsed = raw.length === 0 ? {} : JSON.parse(raw)
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : undefined)
      } catch {
        resolve(undefined)
      }
    })
    request.on('error', () => resolve(undefined))
  })
}

/** Same-origin check for mutating requests (no Origin header means a local client). */
function isTrustedRequest(request) {
  const origin = request.headers.origin
  if (typeof origin !== 'string' || origin.length === 0) return true
  try {
    return new URL(origin).host === request.headers.host
  } catch {
    return false
  }
}

/** Compact human-readable session line for the agent tool. */
function formatList(report) {
  const lines = []
  lines.push(`DSH 会话：共 ${report.counts.sessions} 个（磁盘上有转录 = ${report.counts.tracked}，运行中 = ${report.counts.live}，残留 = ${report.counts.orphans}）`)
  for (const session of report.sessions) {
    const flags = []
    if (session.live) flags.push('运行中')
    if (session.orphan) flags.push('残留')
    if (session.traces.projectionCache) flags.push('缓存')
    if (session.traces.workspaces.length > 0) flags.push(`工作区:${session.traces.workspaces.length}`)
    if (session.traces.archived) flags.push('归档')
    if (session.traces.pinned) flags.push('置顶')
    if (session.traces.favorite) flags.push('收藏')
    if (session.traces.spill) flags.push('spill')
    lines.push(`- ${session.id} | ${session.title || '(无标题)'} | ${session.cwd || '(无 cwd)'} | ${formatBytes(session.bytes)}${flags.length > 0 ? ` | ${flags.join(',')}` : ''}`)
  }
  if (report.counts.orphans > 0) lines.push(`可用 action=cleanup 清理的残留目录：${report.cleanup.orphanSessionIds.join(', ')}`)
  if (report.counts.staleProjectionCaches > 0) lines.push(`过期投影缓存：${report.counts.staleProjectionCaches} 个（${formatBytes(report.cleanup.staleProjectionCacheBytes)}）`)
  if ((report.counts.staleIndexEntries ?? 0) > 0) lines.push(`archive-manager 失效索引：${report.counts.staleIndexEntries} 个（重建缓存时会显示为“跳过”）`)
  if (report.cleanup.emptyProjectDirs.length > 0) lines.push(`空项目目录：${report.cleanup.emptyProjectDirs.length} 个`)
  for (const warning of report.warnings) lines.push(`注意：${warning}`)
  return lines.join('\n')
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

function formatPurge(result) {
  const lines = [`${result.dryRun ? '预演' : '删除'}结果：${result.results.length} 个会话`]
  for (const entry of result.results) {
    if (entry.status === 'deleted') {
      lines.push(`- ${entry.sessionId}: 已彻底删除（${formatBytes(entry.bytes ?? 0)}）`)
      for (const path of entry.removed ?? []) lines.push(`  - 删除目录 ${path}`)
      if (entry.cacheRemoved) lines.push('  - 删除投影缓存')
      if (entry.spillRemoved) lines.push('  - 删除 spill 文件')
    } else if (entry.status === 'planned') {
      lines.push(`- ${entry.sessionId}: 将删除 ${formatBytes(entry.bytes ?? 0)}`)
      for (const path of entry.paths ?? []) lines.push(`  - ${path}`)
    } else if (entry.status === 'skipped') {
      lines.push(`- ${entry.sessionId}: 已跳过（${entry.reason}）`)
    } else if (entry.status === 'missing') {
      lines.push(`- ${entry.sessionId}: ${entry.reason}`)
    } else {
      lines.push(`- ${entry.sessionId}: 失败（${entry.error}）`)
    }
  }
  return lines.join('\n')
}

function formatCleanup(result) {
  if (result.ok === false) return `清理失败：${result.error ?? '未知错误'}`
  const lines = [`${result.dryRun ? '清理预演' : '清理结果'}：`]
  const deletedSessions = result.removedSessions.filter((entry) => entry.status === 'deleted' || entry.status === 'planned')
  lines.push(`- 残留会话目录：${deletedSessions.length} 个`)
  for (const entry of result.removedSessions) {
    if (entry.status === 'failed') lines.push(`  - ${entry.sessionId} 失败：${entry.error}`)
  }
  lines.push(`- 过期投影缓存：${result.removedCaches.length} 个`)
  lines.push(`- 失效工作区/收藏记录：${result.cleanedRefs.length} 个`)
  lines.push(`- archive-manager 失效索引：${(result.cleanedIndex ?? []).length} 个`)
  lines.push(`- 空项目目录：${result.cleanedProjects.length} 个`)
  lines.push(`- 预计释放：${formatBytes(result.bytes ?? 0)}`)
  return lines.join('\n')
}

function formatAuto(auto) {
  if (auto === null || typeof auto !== 'object' || auto.enabled !== true) return ''
  if (auto.lastAt === null) return '自动收尾：已挂接（任何插件执行永久删除后，本插件会自动清理它留下的残留文件）'
  const result = auto.lastResult ?? {}
  const statusText = result.status === 'deleted'
    ? '已清理残留'
    : result.status === 'skipped'
      ? `跳过（${result.reason ?? '会话仍在'}）`
      : result.status === 'missing'
        ? '无需清理'
        : result.status === 'failed'
          ? `失败（${result.error ?? '未知错误'}）`
          : String(result.status ?? '未知')
  let when = ''
  try {
    when = new Date(auto.lastAt).toLocaleString()
  } catch {
    when = String(auto.lastAt)
  }
  return `自动收尾：最近 ${when} 处理 ${auto.lastEvent ?? '（未知会话）'}：${statusText}`
}

function formatReconcile(results) {
  const lines = ['收尾清理结果：']
  for (const entry of results) {
    if (entry.status === 'deleted') lines.push(`- ${entry.sessionId}：已彻底清理（${formatBytes(entry.bytes ?? 0)}）`)
    else if (entry.status === 'skipped') lines.push(`- ${entry.sessionId}：已跳过（${entry.reason}）`)
    else if (entry.status === 'missing') lines.push(`- ${entry.sessionId}：没有残留，无需清理`)
    else if (entry.status === 'failed') lines.push(`- ${entry.sessionId}：失败（${entry.error}）`)
    else lines.push(`- ${entry.sessionId}：${entry.status}`)
  }
  return lines.join('\n')
}

/**
 * Register the host routes and the agent tool.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {{ sessionsRoot?: string }} [_config] - reserved for future overrides.
 */
export function apply(ctx, _config) {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh')

  const makeEngine = (currentSessionId) => createEngine({
    home,
    getService: (serviceName) => ctx.get(serviceName),
    emit: (event, ...args) => ctx.emit(event, ...args),
    warn: (message) => {
      try {
        ctx.logger?.warn?.(`session-purge: ${message}`)
      } catch {
        // diagnostics must never break deletion
      }
    },
    currentSessionId,
  })

  // ---------------------------------------------------------------------------
  // Automatic hook for other session managers (archive-manager and successors).
  //
  // Their permanent-delete buttons call their own code; that code emits the
  // official `api-session/removed` notification and/or exposes a delete method on
  // the `workspaceRegistry` service. Both seams are observed here. After the
  // other plugin reports a removal we wait briefly, verify that the session really
  // left the durable session list, and only then clean every remaining trace.
  // A normal agent disposal also emits `api-session/removed`; such a session is
  // still in the durable list, so it is skipped and never deleted.
  // ---------------------------------------------------------------------------
  const RECONCILE_DELAY_MS = 900
  const RECONCILE_COOLDOWN_MS = 5000
  const lastScheduled = new Map()
  const reconcileTimers = new Map()
  const wrappedServices = new WeakSet()
  const autoState = { enabled: true, eventListener: false, hooked: false, methods: [], count: 0, lastEvent: null, lastAt: null, lastResult: null }

  function scheduleReconcile(id) {
    if (!isSessionId(id)) return
    const now = Date.now()
    const previous = lastScheduled.get(id)
    if (typeof previous === 'number' && now - previous < RECONCILE_COOLDOWN_MS) return
    lastScheduled.set(id, now)
    if (reconcileTimers.has(id)) return
    const timer = setTimeout(async () => {
      reconcileTimers.delete(id)
      try {
        const result = await makeEngine(undefined).reconcile(id)
        autoState.count += 1
        autoState.lastEvent = id
        autoState.lastAt = Date.now()
        autoState.lastResult = result
        if (result?.live === true) markTombstone(id)
        if (result?.status === 'deleted') {
          try {
            ctx.logger?.info?.(`session-purge: 已自动清理会话 ${id} 的残留文件`)
          } catch {
            // logging must never break cleanup
          }
        }
      } catch (error) {
        autoState.count += 1
        autoState.lastEvent = id
        autoState.lastAt = Date.now()
        autoState.lastResult = { sessionId: id, status: 'failed', error: errorMessage(error) }
        try {
          ctx.logger?.warn?.(`session-purge: 自动清理会话 ${id} 失败：${errorMessage(error)}`)
        } catch {
          // logging must never break cleanup
        }
      }
    }, RECONCILE_DELAY_MS)
    if (typeof timer.unref === 'function') timer.unref()
    reconcileTimers.set(id, timer)
  }

  ctx.effect(() => () => {
    for (const timer of reconcileTimers.values()) clearTimeout(timer)
    reconcileTimers.clear()
  }, 'session-purge: auto reconcile timers')

  // A session that was deleted while still running keeps an in-memory writer, so
  // its files can be re-materialized by a later flush. Keep a tombstone for it and
  // remove the transcript again after every durability checkpoint until the live
  // Agent is finally disposed.
  const tombstones = new Map()

  function sweepTombstone(id) {
    if (!tombstones.has(id)) return
    makeEngine(undefined).reconcile(id).catch(() => {
      // a failed sweep is retried by the next flush/dispose
    })
  }

  function scheduleTombstoneSweep(id, delay) {
    const record = tombstones.get(id)
    if (record === undefined || record.timer !== undefined) return
    record.timer = setTimeout(() => {
      record.timer = undefined
      sweepTombstone(id)
    }, delay)
    if (typeof record.timer.unref === 'function') record.timer.unref()
  }

  function markTombstone(id) {
    if (!isSessionId(id)) return
    if (!tombstones.has(id)) tombstones.set(id, { timer: undefined })
    scheduleTombstoneSweep(id, 300)
  }

  try {
    ctx.on('session/flush', (session) => {
      const id = session?.id
      if (typeof id === 'string' && tombstones.has(id)) scheduleTombstoneSweep(id, 250)
    })
    ctx.on('session/disposed', (session) => {
      const id = session?.id
      if (typeof id !== 'string') return
      const record = tombstones.get(id)
      if (record === undefined) return
      tombstones.delete(id)
      if (record.timer !== undefined) clearTimeout(record.timer)
      // Final sweep after the writer closed.
      const timer = setTimeout(() => {
        makeEngine(undefined).reconcile(id).catch(() => {})
      }, 50)
      if (typeof timer.unref === 'function') timer.unref()
    })
  } catch (error) {
    try {
      ctx.logger?.warn?.(`session-purge: 无法监听会话写盘事件：${errorMessage(error)}`)
    } catch {
      // ignore
    }
  }

  ctx.effect(() => () => {
    for (const record of tombstones.values()) if (record.timer !== undefined) clearTimeout(record.timer)
    tombstones.clear()
  }, 'session-purge: tombstones')

  try {
    ctx.on('api-session/removed', (sessionId) => scheduleReconcile(sessionId))
    autoState.eventListener = true
  } catch (error) {
    try {
      ctx.logger?.warn?.(`session-purge: 无法监听 api-session/removed：${errorMessage(error)}`)
    } catch {
      // ignore
    }
  }

  function collectIdsFromArgs(args) {
    const ids = []
    for (const arg of args ?? []) {
      if (typeof arg === 'string' && isSessionId(arg)) {
        ids.push(arg)
        continue
      }
      if (arg !== null && typeof arg === 'object') {
        if (typeof arg.sessionId === 'string') ids.push(arg.sessionId)
        if (Array.isArray(arg.sessionIds)) {
          for (const id of arg.sessionIds) if (typeof id === 'string') ids.push(id)
        }
      }
    }
    return ids
  }

  function collectIdsFromResult(value) {
    if (value === null || typeof value !== 'object') return []
    const ids = []
    for (const key of ['deletedSessionIds', 'skippedSessionIds', 'requestedSessionIds', 'cleanedSessionIds']) {
      const list = value[key]
      if (Array.isArray(list)) {
        for (const id of list) if (typeof id === 'string') ids.push(id)
      }
    }
    return ids
  }

  function wrapDeleteMethod(service, name) {
    let original
    try {
      original = service[name]
    } catch {
      return false
    }
    if (typeof original !== 'function') return false
    try {
      service[name] = function wrappedDeleteMethod(...args) {
        let outcome
        try {
          outcome = original.apply(this, args)
        } catch (error) {
          for (const id of new Set(collectIdsFromArgs(args))) scheduleReconcile(id)
          throw error
        }
        if (outcome !== null && typeof outcome === 'object' && typeof outcome.then === 'function') {
          return outcome.then((value) => {
            for (const id of new Set([...collectIdsFromArgs(args), ...collectIdsFromResult(value)])) scheduleReconcile(id)
            return value
          }, (error) => {
            for (const id of new Set(collectIdsFromArgs(args))) scheduleReconcile(id)
            throw error
          })
        }
        for (const id of new Set(collectIdsFromArgs(args))) scheduleReconcile(id)
        return outcome
      }
      return true
    } catch {
      return false
    }
  }

  function wrapDeleteMethods(service) {
    if (service === null || typeof service !== 'object') return false
    if (wrappedServices.has(service)) return false
    const names = new Set(['deleteSession', 'deleteArchivedSessions', 'deleteArchivedSession', 'cleanOrphanSubagents', 'purgeSession', 'purgeArchivedSessions'])
    try {
      for (const name of Object.getOwnPropertyNames(service)) {
        if (name === 'constructor') continue
        if (/session/i.test(name) && /(delete|purge|clean|remove|erase)/i.test(name)) names.add(name)
      }
    } catch {
      // property enumeration is best effort
    }
    let wrapped = false
    const wrappedNames = []
    for (const name of names) {
      try {
        if (wrapDeleteMethod(service, name)) {
          wrapped = true
          wrappedNames.push(name)
        }
      } catch {
        // one uncooperative method must not stop the others
      }
    }
    if (wrapped) {
      wrappedServices.add(service)
      autoState.hooked = true
      autoState.methods = [...new Set([...autoState.methods, ...wrappedNames])]
      try {
        ctx.logger?.info?.(`session-purge: 已挂接 ${wrappedNames.join(', ')}，永久删除后会自动清理残留`)
      } catch {
        // ignore
      }
    }
    return wrapped
  }

  ctx.effect(() => {
    let timer
    let attempts = 0
    const attempt = () => {
      timer = undefined
      let service
      try {
        service = ctx.get('workspaceRegistry')
      } catch {
        service = undefined
      }
      const wrapped = wrapDeleteMethods(service)
      if (!wrapped && attempts < 20) {
        attempts += 1
        timer = setTimeout(attempt, 1500)
        if (typeof timer.unref === 'function') timer.unref()
      }
    }
    timer = setTimeout(attempt, 250)
    if (typeof timer.unref === 'function') timer.unref()
    return () => {
      if (timer !== undefined) clearTimeout(timer)
    }
  }, 'session-purge: delete hook')

  try {
    ctx.on('app-boot/config-reload', () => {
      try {
        wrapDeleteMethods(ctx.get('workspaceRegistry'))
      } catch {
        // ignore
      }
    })
  } catch {
    // older cores without that event simply keep the boot-time hook
  }

  const disposers = []
  const route = (path, handler) => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path,
      handler,
    })
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  route(LIST_ENDPOINT, async (request, response) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      sendJson(response, 405, { ok: false, error: '只支持 GET' })
      return
    }
    try {
      const report = await makeEngine(undefined).list()
      sendJson(response, 200, {
        ...report,
        auto: {
          enabled: true,
          eventListener: autoState.eventListener,
          hooked: autoState.hooked,
          methods: autoState.methods,
          count: autoState.count,
          lastEvent: autoState.lastEvent,
          lastAt: autoState.lastAt,
          lastResult: autoState.lastResult,
        },
      })
    } catch (error) {
      sendJson(response, 500, { ok: false, error: errorMessage(error) })
    }
  })

  route(PURGE_ENDPOINT, async (request, response) => {
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: '只支持 POST' })
      return
    }
    if (!isTrustedRequest(request)) {
      sendJson(response, 403, { ok: false, error: '拒绝跨站请求' })
      return
    }
    const body = await readJsonBody(request)
    if (body === undefined) {
      sendJson(response, 400, { ok: false, error: '请求体必须是 JSON 对象' })
      return
    }
    const sessionIds = Array.isArray(body.sessionIds) ? body.sessionIds.filter((id) => typeof id === 'string') : []
    if (sessionIds.length === 0) {
      sendJson(response, 400, { ok: false, error: '缺少 sessionIds' })
      return
    }
    try {
      const result = await makeEngine(undefined).purge(sessionIds, {
        dryRun: body.dryRun === true,
        allowLive: body.allowLive === true,
      })
      for (const entry of result.results ?? []) {
        if (entry.live === true && entry.status === 'deleted') markTombstone(entry.sessionId)
      }
      sendJson(response, 200, result)
    } catch (error) {
      sendJson(response, 500, { ok: false, error: errorMessage(error) })
    }
  })

  route(CLEANUP_ENDPOINT, async (request, response) => {
    if (request.method !== 'POST') {
      sendJson(response, 405, { ok: false, error: '只支持 POST' })
      return
    }
    if (!isTrustedRequest(request)) {
      sendJson(response, 403, { ok: false, error: '拒绝跨站请求' })
      return
    }
    const body = await readJsonBody(request)
    if (body === undefined) {
      sendJson(response, 400, { ok: false, error: '请求体必须是 JSON 对象' })
      return
    }
    try {
      const result = await makeEngine(undefined).cleanup({ dryRun: body.dryRun === true })
      sendJson(response, 200, result)
    } catch (error) {
      sendJson(response, 500, { ok: false, error: errorMessage(error) })
    }
  })

  ctx.effect(() => () => {
    for (const dispose of disposers.splice(0)) {
      try {
        dispose()
      } catch {
        // already disposed by the owning fiber
      }
    }
  }, 'session-purge: web routes')

  if (ctx.tools !== undefined && typeof ctx.tools.register === 'function') {
    const definition = {
      name: 'session_purge',
      description: '彻底删除 DSH 会话（不可恢复）：删除会话在磁盘上的转录目录、投影缓存、spill 文件、工作区记账以及归档/置顶/收藏记录。本插件会自动挂接其他会话管理插件（如 archive-manager）的永久删除操作，在其删除后清理残留，通常无需手动调用。action=list 查看会话与可清理残留；action=purge 按 sessionIds 永久删除；action=cleanup 清理此前删除会话遗留的孤儿目录、过期投影缓存和失效工作区记录；action=reconcile 手动收尾已被其他插件声明删除的会话。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'purge', 'cleanup', 'reconcile'],
            description: 'list：查看会话与残留；purge：永久删除 sessionIds；cleanup：清理孤儿转录目录、过期投影缓存和失效工作区记录；reconcile：其他插件声明删除后，仅清理已不在会话列表中的残留。',
          },
          sessionIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'action=purge 时要删除、或 action=reconcile 时要收尾的会话 ID 列表，例如 ["session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"]。',
          },
          dryRun: {
            type: 'boolean',
            description: '只预演并列出将被删除的内容，不真正删除。',
          },
          allowLive: {
            type: 'boolean',
            description: '是否允许删除运行中/当前会话（默认 true）。运行中会话会先刷新并从 Host 分离，再删除磁盘文件；当前窗口可能仍显示对话直到刷新或关闭。',
          },
        },
        required: ['action'],
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
      },
      presentCall(args) {
        const label = args.action === 'purge'
          ? '彻底删除会话'
          : args.action === 'cleanup'
            ? '清理会话残留'
            : '查看 DSH 会话'
        return { card: 'generic', title: label, kind: 'session_purge', rawInput: JSON.stringify(args) }
      },
      async execute(args, exec) {
        const currentSessionId = exec?.agent?.session?.id
          ?? exec?.agent?.sessionId
          ?? exec?.sessionId
        const engine = makeEngine(typeof currentSessionId === 'string' ? currentSessionId : undefined)
        try {
          if (args.action === 'list') {
            return `${formatList(await engine.list())}\n${formatAuto(autoState)}`
          }
          if (args.action === 'purge') {
            if (!Array.isArray(args.sessionIds) || args.sessionIds.length === 0) {
              return 'action=purge 需要提供 sessionIds。先用 action=list 查看会话 ID。'
            }
            const result = await engine.purge(args.sessionIds, {
              dryRun: args.dryRun === true,
              allowLive: args.allowLive !== false,
            })
            for (const entry of result.results ?? []) {
              if (entry.live === true && entry.status === 'deleted') markTombstone(entry.sessionId)
            }
            return formatPurge(result)
          }
          if (args.action === 'reconcile') {
            if (!Array.isArray(args.sessionIds) || args.sessionIds.length === 0) {
              return 'action=reconcile 需要提供 sessionIds。'
            }
            const results = []
            for (const id of args.sessionIds) {
              results.push(await engine.reconcile(String(id)))
            }
            return formatReconcile(results)
          }
          if (args.action === 'cleanup') {
            return formatCleanup(await engine.cleanup({ dryRun: args.dryRun === true }))
          }
          return `未知 action：${String(args.action)}`
        } catch (error) {
          return `session_purge 执行失败：${errorMessage(error)}`
        }
      },
    }
    const disposeTool = ctx.tools.register(definition)
    ctx.effect(() => () => {
      try {
        disposeTool()
      } catch {
        // already disposed by the owning fiber
      }
    }, 'session-purge: tool')
  }
}
