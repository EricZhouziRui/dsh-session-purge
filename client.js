/**
 * Browser half of the "彻底删除会话 / Session purge" bundle.
 *
 * Contributes one settings page. All data comes from the Host routes so the
 * page and the `session_purge` agent tool share one deletion implementation;
 * the browser never touches the filesystem itself.
 *
 * @module session-purge/client
 */

window.__ModuleLoader__.load({
  id: '@local/session-purge',
  factory(require) {
    const React = require('react')
    const { createElement: h, useCallback, useEffect, useRef, useState } = React

    const NS = '@local/session-purge'
    const CLIENT_ID = 'session-purge'
    const API = '/api/session-purge'

    const ZH = {
      title: '彻底删除会话',
      desc: '自动接住其他会话管理插件的永久删除并清理磁盘残留；也可以在这里按工作区查看会话、逐个删除。',
      refresh: '刷新',
      cleanup: '清理残留',
      cleanupCount: '清理残留（{n} 项）',
      cleanupConfirm: '将删除 {n} 项残留（残留会话目录、过期投影缓存、失效工作区记录、空项目目录），共约 {size}。此操作不可恢复。',
      cleanupRunning: '正在清理…',
      cleanupDone: '清理完成：残留会话 {sessions} 个，缓存 {caches} 个，记录 {refs} 个，失效索引 {indices} 个，空目录 {dirs} 个，释放 {size}。',
      cleanupNone: '没有可清理的残留。',
      deleteBlanks: '删除空白会话（{n}）',
      blankDeleteConfirm: '将彻底删除 {n} 个空白会话（共约 {size}），此操作不可恢复；正在运行的空白会话会先刷新并从 Host 分离，再删除磁盘数据。',
      blankDeleting: '正在删除空白会话…',
      blankDeleteDone: '已删除 {n} 个空白会话，释放 {size}。',
      blankDeleteFailed: '有 {n} 个空白会话删除失败：{error}',
      blankDeleteNone: '没有可删除的空白会话。',
      checkUpdate: '检查更新',
      checkingUpdate: '正在检查…',
      currentVersion: '当前版本 v{version}',
      updateAvailable: '更新到 v{version}',
      updateRepair: '修复安装 v{version}',
      updateLatest: '已是最新版本',
      updating: '正在更新…',
      updateConfirm: '将把插件更新到 v{version}。更新会替换当前安装副本，完成后再完全退出并重新打开 DSH 才生效。继续？',
      updateRepairConfirm: '发布内容已修复（版本号不变），将重新下载并替换当前安装副本，完成后再完全退出并重新打开 DSH 才生效。继续？',
      updateDone: '已更新到 v{version}，请完全退出并重新打开 DSH。',
      updateFailed: '更新失败：{error}',
      loading: '正在扫描会话…',
      sessionsTitle: '会话',
      orphansTitle: '磁盘残留（不在会话列表中）',
      ungroupedTitle: '未分组 / 磁盘残留',
      groupSessions: '{n} 个会话',
      groupWorkspace: '工作区',
      copyId: '复制 ID',
      copied: '已复制',
      details: '详情',
      hideDetails: '收起详情',
      sessionIdLabel: '会话 ID',
      cwdLabel: '工作目录',
      dirLabel: '转录目录',
      summarySessions: '{n} 个会话',
      summaryBlanks: '{n} 个空白',
      summaryCleanable: '{n} 项可清理',
      emptySessions: '没有找到任何会话。',
      live: '运行中',
      orphan: '残留',
      blank: '空白会话',
      tracked: '可删除',
      bytes: '大小',
      files: '{n} 个文件',
      created: '创建',
      traces: '痕迹',
      traceCache: '投影缓存',
      traceWorkspace: '工作区',
      traceArchived: '归档',
      tracePinned: '置顶',
      traceFavorite: '收藏',
      traceSpill: 'spill',
      traceNone: '仅有转录目录',
      noCwd: '（无工作目录）',
      untitled: '（无标题）',
      delete: '彻底删除',
      deleteConfirm: '确认删除',
      cancel: '取消',
      deletePending: '正在删除…',
      deleteDone: '已彻底删除会话「{name}」，释放 {size}。',
      deleteDoneLive: '已彻底删除运行中的会话「{name}」，释放 {size}。当前窗口可能仍显示这段对话，刷新页面或关闭标签后消失。',
      deleteSkipped: '未删除：{reason}',
      deleteFailed: '删除失败：{error}',
      liveHint: '该会话正在运行/打开中。仍然可以彻底删除：会先刷新并从 Host 分离，再清除磁盘数据。',
      liveDeleteConfirm: '该会话正在运行/打开中。彻底删除会立即清除磁盘数据，但当前窗口可能仍显示这段对话，刷新或关闭后消失。确定继续？',
      reloadHint: '若左侧列表仍显示已删除的会话，请刷新页面。',
      refreshPage: '刷新页面',
      warnings: '注意',
      home: 'DSH 主目录',
      autoIdle: '自动收尾已开启',
      autoWaiting: '自动收尾：正在等待挂接删除插件…',
      autoLast: '自动收尾 · 上次处理：{status}',
      autoStatusDeleted: '已清理残留',
      autoStatusSkipped: '跳过（{reason}）',
      autoStatusMissing: '无需清理',
      autoStatusFailed: '失败（{error}）',
    }

    const EN = {
      title: 'Permanently delete sessions',
      desc: 'Automatically finishes permanent deletes from other session managers and cleans leftovers on disk. Sessions can also be reviewed and deleted one by one per workspace.',
      refresh: 'Refresh',
      cleanup: 'Clean leftovers',
      cleanupCount: 'Clean leftovers ({n})',
      cleanupConfirm: 'This deletes {n} leftovers (orphan session directories, stale projection caches, stale workspace records, empty project directories), about {size}. This cannot be undone.',
      cleanupRunning: 'Cleaning…',
      cleanupDone: 'Cleanup finished: {sessions} orphan sessions, {caches} caches, {refs} records, {indices} index entries, {dirs} empty directories, freeing {size}.',
      cleanupNone: 'There is nothing to clean up.',
      deleteBlanks: 'Delete blank sessions ({n})',
      blankDeleteConfirm: 'This permanently deletes {n} blank sessions (about {size}). This cannot be undone; running blank sessions are flushed and detached from the Host before their disk data is removed.',
      blankDeleting: 'Deleting blank sessions…',
      blankDeleteDone: 'Deleted {n} blank sessions, freeing {size}.',
      blankDeleteFailed: '{n} blank sessions failed to delete: {error}',
      blankDeleteNone: 'There are no blank sessions to delete.',
      checkUpdate: 'Check for updates',
      checkingUpdate: 'Checking…',
      currentVersion: 'Current version v{version}',
      updateAvailable: 'Update to v{version}',
      updateRepair: 'Repair install v{version}',
      updateLatest: 'Up to date',
      updating: 'Updating…',
      updateConfirm: 'Update the plugin to v{version}? This replaces the installed copy; restart DSH after it finishes. Continue?',
      updateRepairConfirm: 'The released content was repaired (same version). Re-download and replace the installed copy, then quit and reopen DSH. Continue?',
      updateDone: 'Updated to v{version}. Quit and reopen DSH to finish.',
      updateFailed: 'Update failed: {error}',
      loading: 'Scanning sessions…',
      sessionsTitle: 'Sessions',
      orphansTitle: 'Leftovers on disk (not in the session list)',
      ungroupedTitle: 'Ungrouped / leftovers',
      groupSessions: '{n} sessions',
      groupWorkspace: 'Workspace',
      copyId: 'Copy ID',
      copied: 'Copied',
      details: 'Details',
      hideDetails: 'Hide details',
      sessionIdLabel: 'Session ID',
      cwdLabel: 'Working dir',
      dirLabel: 'Transcript dir',
      summarySessions: '{n} sessions',
      summaryBlanks: '{n} blank',
      summaryCleanable: '{n} cleanable',
      emptySessions: 'No sessions found.',
      live: 'running',
      orphan: 'leftover',
      blank: 'blank',
      tracked: 'deletable',
      bytes: 'size',
      files: '{n} files',
      created: 'created',
      traces: 'traces',
      traceCache: 'projection cache',
      traceWorkspace: 'workspace',
      traceArchived: 'archived',
      tracePinned: 'pinned',
      traceFavorite: 'favorite',
      traceSpill: 'spill',
      traceNone: 'transcript directory only',
      noCwd: '(no working directory)',
      untitled: '(untitled)',
      delete: 'Delete permanently',
      deleteConfirm: 'Confirm deletion',
      cancel: 'Cancel',
      deletePending: 'Deleting…',
      deleteDone: 'Permanently deleted session "{name}", freeing {size}.',
      deleteDoneLive: 'Permanently deleted running session "{name}", freeing {size}. The current window may still show the conversation until it is refreshed or closed.',
      deleteSkipped: 'Not deleted: {reason}',
      deleteFailed: 'Deletion failed: {error}',
      liveHint: 'This session is still running/open. It can still be deleted: it is flushed and detached from the Host before its files are removed.',
      liveDeleteConfirm: 'This session is still running/open. Deleting it removes the on-disk data immediately, but the current window may keep showing the conversation until it is refreshed or closed. Continue?',
      reloadHint: 'If the sidebar still shows a deleted session, reload the page.',
      refreshPage: 'Reload page',
      warnings: 'Notes',
      home: 'DSH home',
      autoIdle: 'Auto cleanup is on',
      autoWaiting: 'Auto cleanup: waiting for a session manager to hook into…',
      autoLast: 'Auto cleanup · last run: {status}',
      autoStatusDeleted: 'leftovers cleaned',
      autoStatusSkipped: 'skipped ({reason})',
      autoStatusMissing: 'nothing to clean',
      autoStatusFailed: 'failed ({error})',
    }

    let localeApi = null
    let sessionsApi = null

    function interpolate(text, vars) {
      if (vars === undefined || vars === null) return text
      let out = text
      for (const [key, value] of Object.entries(vars)) out = out.split(`{${key}}`).join(String(value))
      return out
    }

    // This bundle is delivered for a Chinese-speaking user: visible copy stays
    // Chinese regardless of the shell locale. The English dictionary remains as
    // a fallback for keys the Chinese dictionary does not define yet.
    function t(key, vars) {
      return interpolate(ZH[key] ?? EN[key] ?? key, vars)
    }

    function formatBytes(bytes) {
      if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) return '0 B'
      const units = ['B', 'KB', 'MB', 'GB']
      let value = bytes
      let unit = 0
      while (value >= 1024 && unit < units.length - 1) {
        value /= 1024
        unit += 1
      }
      return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
    }

    function formatWhen(timestamp) {
      if (typeof timestamp !== 'number' || timestamp <= 0) return '—'
      try {
        const date = new Date(timestamp)
        const now = new Date()
        return date.getFullYear() === now.getFullYear()
          ? `${date.toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })} ${date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
          : date.toLocaleDateString()
      } catch {
        return '—'
      }
    }

    function formatDate(timestamp) {
      if (typeof timestamp !== 'number' || timestamp <= 0) return '—'
      try {
        return new Date(timestamp).toLocaleString()
      } catch {
        return '—'
      }
    }

    async function callApi(path, options) {
      let response
      try {
        response = await fetch(`${API}${path}`, options)
      } catch (error) {
        throw new Error(error instanceof Error ? error.message : String(error))
      }
      let data = null
      try {
        data = await response.json()
      } catch {
        data = null
      }
      if (!response.ok || data === null || data.ok === false) {
        throw new Error(data !== null && typeof data.error === 'string' ? data.error : `HTTP ${response.status}`)
      }
      return data
    }

    const postJson = (path, body) => callApi(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    })

    function refreshSessionList() {
      try {
        sessionsApi?.refresh?.()
      } catch {
        // best effort
      }
    }

    function useLocaleRevision() {
      const [, force] = useState(0)
      useEffect(() => {
        if (localeApi === null || typeof localeApi.subscribe !== 'function') return undefined
        return localeApi.subscribe(() => force((value) => value + 1))
      }, [])
    }

    function IconTrash(size) {
      const dimension = size ?? 16
      return h('svg', {
        width: dimension,
        height: dimension,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M2.5 4.5h11' }),
        h('path', { d: 'M6 4.5V2.9c0-.5.4-.9.9-.9h2.2c.5 0 .9.4.9.9v1.6' }),
        h('path', { d: 'M4 4.5l.6 8.4c.05.7.6 1.1 1.3 1.1h4.2c.7 0 1.25-.4 1.3-1.1L12 4.5' }),
        h('path', { d: 'M6.6 7v4.2M9.4 7v4.2' }),
      )
    }

    function IconChevron(direction) {
      const path = direction === 'up'
        ? 'M4 10l4-4 4 4'
        : direction === 'right'
          ? 'M6 4l4 4-4 4'
          : 'M4 6l4 4 4-4'
      return h('svg', {
        width: 12,
        height: 12,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.6,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      }, h('path', { d: path }))
    }

    function IconFolder(size) {
      const dimension = size ?? 16
      return h('svg', {
        width: dimension,
        height: dimension,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M1.8 4.2h3.9l1.4 1.6h7.1c.4 0 .8.3.8.8v5.6c0 .4-.3.8-.8.8H2.6c-.4 0-.8-.3-.8-.8V4.2z' }),
      )
    }

    function Badge(props) {
      return h('span', { className: `dshsp_badge ${props.className ?? ''}`.trim() }, props.children)
    }

    function SectionPage() {
      useLocaleRevision()
      const [report, setReport] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [busyId, setBusyId] = useState(null)
      const [cleaning, setCleaning] = useState(false)
      const [deletingBlanks, setDeletingBlanks] = useState(false)
      const [updateChecking, setUpdateChecking] = useState(false)
      const [updateApplying, setUpdateApplying] = useState(false)
      const [updateInfo, setUpdateInfo] = useState(null)
      const [updateNotice, setUpdateNotice] = useState(null)
      const [updateError, setUpdateError] = useState(null)
      const [confirm, setConfirm] = useState(null)
      const [collapsedGroups, setCollapsedGroups] = useState({})
      const [copiedId, setCopiedId] = useState(null)
      const [expandedSessions, setExpandedSessions] = useState({})
      const rootRef = useRef(null)

      // The settings shell scrolls in an ancestor element. Capture every
      // scrollable ancestor plus the window before a destructive action, then
      // restore after React has committed the refreshed list. Refreshes never
      // unmount the list (that was what made the page jump to the top).
      const captureScroll = () => {
        const positions = []
        if (typeof window !== 'undefined') positions.push({ element: null, top: window.scrollY })
        let element = rootRef.current?.parentElement ?? null
        while (element) {
          if (element.scrollHeight > element.clientHeight + 1) {
            positions.push({ element, top: element.scrollTop })
          }
          element = element.parentElement
        }
        return positions
      }

      const restoreScroll = (positions) => {
        if (positions.length === 0) return undefined
        const apply = () => {
          for (const position of positions) {
            if (position.element === null) {
              if (typeof window !== 'undefined') window.scrollTo(0, position.top)
            } else if (position.element.isConnected) {
              position.element.scrollTop = position.top
            }
          }
        }
        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(() => {
            apply()
            requestAnimationFrame(apply)
          })
          return undefined
        }
        apply()
        return undefined
      }

      const load = useCallback(async (options) => {
        const showLoading = options?.showLoading === true
        if (showLoading) {
          setLoading(true)
          setError(null)
        }
        try {
          const next = await callApi('/list', { method: 'GET' })
          setReport(next)
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          if (showLoading) setLoading(false)
        }
      }, [])

      useEffect(() => {
        load({ showLoading: true })
      }, [load])

      const checkForUpdate = useCallback(async (silent) => {
        setUpdateChecking(true)
        if (silent !== true) {
          setUpdateError(null)
          setUpdateNotice(null)
        }
        try {
          const info = await callApi('/update', { method: 'GET' })
          setUpdateInfo(info)
          if (silent !== true) {
            if (info?.updateAvailable === true) setUpdateNotice(null)
            else if (info?.ok !== false) setUpdateNotice(t('updateLatest'))
          }
        } catch (failure) {
          if (silent !== true) {
            setUpdateError(t('updateFailed', { error: failure instanceof Error ? failure.message : String(failure) }))
          }
        } finally {
          setUpdateChecking(false)
        }
      }, [])

      useEffect(() => {
        checkForUpdate(true)
      }, [checkForUpdate])

      const runUpdate = async () => {
        const version = updateInfo?.latestVersion ?? ''
        if (updateInfo?.updateAvailable !== true) {
          await checkForUpdate(false)
          return
        }
        let confirmed = true
        try {
          if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
            confirmed = window.confirm(
              updateInfo?.contentDrift === true
                ? t('updateRepairConfirm')
                : t('updateConfirm', { version }),
            )
          }
        } catch {
          confirmed = true
        }
        if (confirmed !== true) return
        setUpdateApplying(true)
        setUpdateError(null)
        setUpdateNotice(null)
        try {
          const result = await postJson('/update', {})
          if (result?.ok === false) throw new Error(result.error ?? 'update failed')
          setUpdateInfo((current) => ({ ...(current ?? {}), updateAvailable: false, latestVersion: result?.latestVersion ?? version }))
          setUpdateNotice(t('updateDone', { version: result?.latestVersion ?? version }))
        } catch (failure) {
          setUpdateError(t('updateFailed', { error: failure instanceof Error ? failure.message : String(failure) }))
        } finally {
          setUpdateApplying(false)
        }
      }

      useEffect(() => {
        if (notice === null) return undefined
        const timer = setTimeout(() => setNotice(null), 8000)
        return () => clearTimeout(timer)
      }, [notice])

      const sessionName = (session) => (session.title && session.title.length > 0
        ? session.title
        : (session.blank ? t('blank') : t('untitled')))

      const cleanupCount = report === null
        ? 0
        : (report.cleanup.orphanSessionIds.length
          + report.cleanup.staleProjectionCacheIds.length
          + report.cleanup.staleWorkspaceRefIds.length
          + ((report.cleanup.staleIndexIds ?? []).length)
          + report.cleanup.emptyProjectDirs.length)

      const runPurge = async (session) => {
        const scroll = captureScroll()
        setConfirm(null)
        setBusyId(session.id)
        setError(null)
        try {
          const result = await postJson('/purge', { sessionIds: [session.id], allowLive: session.live === true })
          const entry = result.results?.[0]
          if (entry?.status === 'deleted') {
            setNotice(t(entry.live === true ? 'deleteDoneLive' : 'deleteDone', { name: sessionName(session), size: formatBytes(entry.bytes ?? 0) }))
          } else if (entry?.status === 'skipped') {
            setNotice(t('deleteSkipped', { reason: entry.reason ?? '' }))
          } else if (entry?.status === 'missing') {
            setNotice(t('deleteSkipped', { reason: entry.reason ?? '' }))
          } else if (entry?.status === 'failed') {
            setError(t('deleteFailed', { error: entry.error ?? '' }))
          } else {
            setNotice(t('deleteDone', { name: sessionName(session), size: formatBytes(entry?.bytes ?? 0) }))
          }
          refreshSessionList()
          await load()
        } catch (failure) {
          setError(t('deleteFailed', { error: failure instanceof Error ? failure.message : String(failure) }))
        } finally {
          setBusyId(null)
          restoreScroll(scroll)
        }
      }

      const runCleanup = async () => {
        const scroll = captureScroll()
        setConfirm(null)
        setCleaning(true)
        setError(null)
        try {
          const result = await postJson('/cleanup', {})
          if (result.ok === false) {
            setError(result.error ?? 'cleanup failed')
          } else {
            setNotice(t('cleanupDone', {
              sessions: result.removedSessions?.length ?? 0,
              caches: result.removedCaches?.length ?? 0,
              refs: result.cleanedRefs?.length ?? 0,
              indices: result.cleanedIndex?.length ?? 0,
              dirs: result.cleanedProjects?.length ?? 0,
              size: formatBytes(result.bytes ?? 0),
            }))
          }
          refreshSessionList()
          await load()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setCleaning(false)
          restoreScroll(scroll)
        }
      }

      const runBlankPurge = async () => {
        const targets = sessions.filter((session) => session.blank === true)
        if (targets.length === 0) {
          setConfirm(null)
          setNotice(t('blankDeleteNone'))
          return
        }
        const scroll = captureScroll()
        setConfirm(null)
        setDeletingBlanks(true)
        setError(null)
        try {
          const result = await postJson('/purge', {
            sessionIds: targets.map((session) => session.id),
            allowLive: targets.some((session) => session.live === true),
          })
          const entries = Array.isArray(result.results) ? result.results : []
          const deleted = entries.filter((entry) => entry.status === 'deleted')
          const failed = entries.filter((entry) => entry.status === 'failed')
          const bytes = deleted.reduce((total, entry) => total + (entry.bytes ?? 0), 0)
          if (deleted.length > 0) {
            setNotice(t('blankDeleteDone', { n: deleted.length, size: formatBytes(bytes) }))
          } else if (failed.length === 0) {
            setNotice(t('blankDeleteNone'))
          }
          if (failed.length > 0) {
            setError(t('blankDeleteFailed', { n: failed.length, error: failed[0].error ?? '' }))
          }
          refreshSessionList()
          await load()
        } catch (failure) {
          setError(failure instanceof Error ? failure.message : String(failure))
        } finally {
          setDeletingBlanks(false)
          restoreScroll(scroll)
        }
      }

      const autoText = (auto) => {
        if (auto === null || typeof auto !== 'object' || auto.enabled !== true) return ''
        if (!auto.lastAt) return auto.hooked === true || auto.eventListener === true ? t('autoIdle') : t('autoWaiting')
        const result = auto.lastResult ?? {}
        let status
        if (result.status === 'deleted') status = t('autoStatusDeleted')
        else if (result.status === 'skipped') status = t('autoStatusSkipped', { reason: result.reason ?? '' })
        else if (result.status === 'missing') status = t('autoStatusMissing')
        else if (result.status === 'failed') status = t('autoStatusFailed', { error: result.error ?? '' })
        else status = String(result.status ?? '')
        return t('autoLast', { time: formatDate(auto.lastAt), id: auto.lastEvent ?? '—', status })
      }

      const sessions = report === null ? [] : report.sessions
      const blankSessions = sessions.filter((session) => session.blank === true)
      const blankBytes = blankSessions.reduce((total, session) => total + (session.bytes ?? 0), 0)
      const workspaceList = report === null ? [] : (report.workspaces ?? [])
      const workspaceById = new Map(workspaceList.map((workspace) => [workspace.id, workspace]))
      const grouped = new Map()
      const ungrouped = []
      for (const session of sessions) {
        const workspaceId = Array.isArray(session.workspaceIds) ? session.workspaceIds[0] : undefined
        if (typeof workspaceId === 'string' && workspaceById.has(workspaceId)) {
          if (!grouped.has(workspaceId)) grouped.set(workspaceId, [])
          grouped.get(workspaceId).push(session)
        } else {
          ungrouped.push(session)
        }
      }
      const groups = []
      for (const workspace of workspaceList) {
        const list = grouped.get(workspace.id)
        if (list === undefined || list.length === 0) continue
        groups.push({
          key: `ws:${workspace.id}`,
          kind: 'workspace',
          title: workspace.title || workspace.path || workspace.id,
          path: workspace.path || '',
          bytes: list.reduce((total, session) => total + (session.bytes ?? 0), 0),
          sessions: list,
        })
      }
      if (ungrouped.length > 0) {
        groups.push({
          key: 'ungrouped',
          kind: 'ungrouped',
          title: t('ungroupedTitle'),
          path: '',
          bytes: ungrouped.reduce((total, session) => total + (session.bytes ?? 0), 0),
          sessions: ungrouped,
        })
      }
      const toggleGroup = (key) => setCollapsedGroups((current) => ({ ...current, [key]: current[key] !== true }))
      const copySessionId = (id) => {
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
            navigator.clipboard.writeText(id)
          }
        } catch {
          // clipboard may be unavailable; the id stays selectable in the row
        }
        setCopiedId(id)
        setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1600)
      }

      const toggleDetails = (id) => setExpandedSessions((current) => ({ ...current, [id]: current[id] !== true }))
      const summaryText = (current) => {
        const parts = [t('summarySessions', { n: current.counts.sessions })]
        const blanks = current.sessions.filter((session) => session.blank).length
        if (blanks > 0) parts.push(t('summaryBlanks', { n: blanks }))
        if (cleanupCount > 0) parts.push(t('summaryCleanable', { n: cleanupCount }))
        if ((current.cleanup?.reclaimableBytes ?? 0) > 0) parts.push(formatBytes(current.cleanup.reclaimableBytes))
        return parts.join(' · ')
      }

      const renderRow = (session) => {
        const traces = []
        if (session.traces.projectionCache) traces.push(t('traceCache'))
        if (session.traces.workspaces.length > 0) traces.push(t('traceWorkspace'))
        if (session.traces.archived) traces.push(t('traceArchived'))
        if (session.traces.pinned) traces.push(t('tracePinned'))
        if (session.traces.favorite) traces.push(t('traceFavorite'))
        if (session.traces.spill) traces.push(t('traceSpill'))
        const confirming = confirm !== null && confirm.kind === 'purge' && confirm.id === session.id
        const busy = busyId === session.id
        const expanded = expandedSessions[session.id] === true
        const detailRow = (label, value) => h('div', { className: 'dshsp_detailRow' },
          h('span', { className: 'dshsp_detailLabel' }, label),
          h('span', { className: 'dshsp_detailValue' }, value),
        )
        return h('div', { className: `dshsp_row${session.orphan ? ' dshsp_rowOrphan' : ''}`, key: session.id },
          h('div', { className: 'dshsp_rowMain' },
            h('div', { className: 'dshsp_rowTitle' },
              h('span', { className: 'dshsp_rowName' }, sessionName(session)),
              session.live ? h(Badge, { className: 'dshsp_badgeLive' }, t('live')) : null,
              session.orphan ? h(Badge, { className: 'dshsp_badgeWarn' }, t('orphan')) : null,
            ),
            h('div', { className: 'dshsp_rowSub' },
              h('span', null, formatWhen(session.createdAt)),
              h('span', { className: 'dshsp_dot', 'aria-hidden': 'true' }),
              h('span', null, formatBytes(session.bytes)),
            ),
            confirming && session.live
              ? h('div', { className: 'dshsp_rowWarn' }, t('liveDeleteConfirm'))
              : null,
            expanded
              ? h('div', { className: 'dshsp_details' },
                detailRow(t('sessionIdLabel'), h('span', { className: 'dshsp_mono' }, session.id,
                  h('button', {
                    type: 'button',
                    className: 'dshsp_copyBtn',
                    onClick: (event) => {
                      event.stopPropagation()
                      copySessionId(session.id)
                    },
                  }, copiedId === session.id ? t('copied') : t('copyId')),
                )),
                session.cwd && session.cwd.length > 0 ? detailRow(t('cwdLabel'), session.cwd) : null,
                session.dirPaths.length > 0 ? detailRow(t('dirLabel'), session.dirPaths.join('\n')) : null,
                detailRow(t('traces'), traces.length > 0 ? traces.join(' · ') : t('traceNone')),
              )
              : null,
          ),
          h('div', { className: 'dshsp_rowActions' },
            confirming
              ? [
                h('button', {
                  type: 'button',
                  key: 'cancel',
                  className: 'dshsp_btn',
                  disabled: busy || deletingBlanks,
                  onClick: () => setConfirm(null),
                }, t('cancel')),
                h('button', {
                  type: 'button',
                  key: 'confirm',
                  className: 'dshsp_btn dshsp_btnDangerSolid',
                  disabled: busy || deletingBlanks,
                  onClick: () => runPurge(session),
                }, busy ? t('deletePending') : t('deleteConfirm')),
              ]
              : [
                h('button', {
                  type: 'button',
                  key: 'details',
                  className: 'dshsp_iconBtn',
                  title: expanded ? t('hideDetails') : t('details'),
                  'aria-expanded': expanded ? 'true' : 'false',
                  onClick: () => toggleDetails(session.id),
                }, IconChevron(expanded ? 'up' : 'down')),
                h('button', {
                  type: 'button',
                  key: 'delete',
                  className: 'dshsp_iconBtn dshsp_iconBtnDanger',
                  title: t('delete'),
                  disabled: busy || deletingBlanks,
                  onClick: () => setConfirm({ kind: 'purge', id: session.id }),
                }, IconTrash(15)),
              ],
          ),
        )
      }

      return h('div', { className: 'dshsp_root', ref: rootRef },
        h('h2', { className: 'dshsp_title' }, t('title')),
        h('p', { className: 'dshsp_desc' }, t('desc')),

        error !== null ? h('div', { className: 'dshsp_error', role: 'alert' }, error) : null,
        notice !== null ? h('div', { className: 'dshsp_notice', role: 'status' }, notice) : null,

        h('div', { className: 'dshsp_toolbar' },
          h('button', {
            type: 'button',
            className: 'dshsp_btn',
            disabled: loading || cleaning || deletingBlanks,
            onClick: async () => {
              const scroll = captureScroll()
              await load()
              restoreScroll(scroll)
            },
          }, loading ? t('loading') : t('refresh')),
          h('button', {
            type: 'button',
            className: `dshsp_btn${cleanupCount > 0 ? ' dshsp_btnDanger' : ''}`,
            disabled: loading || cleaning || deletingBlanks || cleanupCount === 0,
            onClick: () => setConfirm({ kind: 'cleanup' }),
          }, cleaning ? t('cleanupRunning') : (cleanupCount > 0 ? t('cleanupCount', { n: cleanupCount }) : t('cleanup'))),
          h('button', {
            type: 'button',
            className: `dshsp_btn${blankSessions.length > 0 ? ' dshsp_btnDanger' : ''}`,
            disabled: loading || cleaning || deletingBlanks || blankSessions.length === 0,
            onClick: () => setConfirm({ kind: 'purgeBlanks' }),
          }, deletingBlanks ? t('blankDeleting') : t('deleteBlanks', { n: blankSessions.length })),
          report !== null ? h('span', { className: 'dshsp_summary' }, summaryText(report)) : null,
        ),

        report !== null && report.auto !== undefined && (report.auto.lastAt !== null || report.auto.hooked !== true)
          ? h('div', { className: 'dshsp_auto' }, autoText(report.auto))
          : null,

        h('div', { className: 'dshsp_update' },
          report?.pluginVersion !== undefined
            ? h('span', { className: 'dshsp_currentVersion' }, t('currentVersion', { version: report.pluginVersion }))
            : null,
          updateNotice !== null ? h('span', { className: 'dshsp_updateNotice' }, updateNotice) : null,
          updateError !== null ? h('span', { className: 'dshsp_updateError' }, updateError) : null,
          h('button', {
            type: 'button',
            className: `dshsp_linkBtn${updateInfo?.updateAvailable === true ? ' dshsp_updateAction' : ''}`,
            disabled: updateChecking || updateApplying,
            onClick: runUpdate,
          }, updateApplying
            ? t('updating')
            : updateChecking
              ? t('checkingUpdate')
              : updateInfo?.updateAvailable === true
                ? updateInfo.contentDrift === true
                  ? t('updateRepair', { version: updateInfo.latestVersion ?? '' })
                  : t('updateAvailable', { version: updateInfo.latestVersion ?? '' })
                : t('checkUpdate')),
        ),

        confirm !== null && confirm.kind === 'cleanup'
          ? h('div', { className: 'dshsp_confirm' },
            h('span', { className: 'dshsp_confirmText' }, t('cleanupConfirm', {
              n: cleanupCount,
              size: formatBytes(report?.cleanup.reclaimableBytes ?? 0),
            })),
            h('button', { type: 'button', className: 'dshsp_btn', onClick: () => setConfirm(null) }, t('cancel')),
            h('button', { type: 'button', className: 'dshsp_btn dshsp_btnDangerSolid', onClick: runCleanup }, t('cleanup')),
          )
          : null,

        confirm !== null && confirm.kind === 'purgeBlanks'
          ? h('div', { className: 'dshsp_confirm' },
            h('span', { className: 'dshsp_confirmText' }, t('blankDeleteConfirm', {
              n: blankSessions.length,
              size: formatBytes(blankBytes),
            })),
            h('button', { type: 'button', className: 'dshsp_btn', onClick: () => setConfirm(null) }, t('cancel')),
            h('button', { type: 'button', className: 'dshsp_btn dshsp_btnDangerSolid', onClick: runBlankPurge }, t('deleteBlanks', { n: blankSessions.length })),
          )
          : null,

        report !== null && !loading
          ? h('div', null,
            groups.map((group) => {
              const collapsed = collapsedGroups[group.key] === true
              return h('div', { className: 'dshsp_group', key: group.key },
                h('button', {
                  type: 'button',
                  className: 'dshsp_groupHeader',
                  onClick: () => toggleGroup(group.key),
                  'aria-expanded': collapsed ? 'false' : 'true',
                  title: group.path || undefined,
                },
                  h('span', { className: 'dshsp_chevron' }, IconChevron(collapsed ? 'right' : 'down')),
                  h('span', { className: 'dshsp_groupIcon' }, IconFolder(17)),
                  h('span', { className: 'dshsp_groupTitle' }, group.title),
                  h('span', { className: 'dshsp_groupCount' }, t('groupSessions', { n: group.sessions.length })),
                ),
                collapsed
                  ? null
                  : h('div', { className: 'dshsp_groupBody' }, group.sessions.map(renderRow)),
              )
            }),
            sessions.length === 0
              ? h('div', { className: 'dshsp_empty' }, t('emptySessions'))
              : null,
          )
          : null,

        report !== null && report.warnings.length > 0
          ? h('div', { className: 'dshsp_warnings' },
            report.warnings.map((warning, index) => h('div', { key: index }, warning)),
          )
          : null,
      )
    }

    function ensureStyles() {
      const STYLE_ID = 'dshsp-styles'
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = [
        '.dshsp_root{box-sizing:border-box;padding:24px 28px 40px;max-width:900px;font-size:14px;line-height:1.55;color:var(--dsw-alias-label-primary)}',
        '.dshsp_title{margin:0 0 6px;font-size:18px;font-weight:600;color:var(--dsw-alias-label-primary)}',
        '.dshsp_desc{margin:0 0 18px;font-size:13px;color:var(--dsw-alias-label-secondary);max-width:72ch}',
        '.dshsp_stats{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}',
        '.dshsp_chip{padding:4px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
        '.dshsp_chip strong{color:var(--dsw-alias-label-primary);font-weight:600}',
        '.dshsp_toolbar{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 14px}',
        '.dshsp_auto{margin:0 0 14px;padding-left:8px;border-left:2px solid var(--dsw-alias-state-success-primary);font-size:12px;color:var(--dsw-alias-label-secondary)}',
        '.dshsp_update{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0 0 14px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
        '.dshsp_currentVersion{color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
        '.dshsp_updateNotice{color:var(--dsw-alias-state-success-primary)}',
        '.dshsp_updateError{color:var(--dsw-alias-state-error-primary)}',
        '.dshsp_updateAction{font-size:13px;font-weight:600}',
        '.dshsp_summary{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
        '.dshsp_hint{margin:0 0 14px;font-size:12px;color:var(--dsw-alias-label-secondary);opacity:.9}',
        '.dshsp_btn{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;transition:background 120ms ease,border-color 120ms ease}',
        '.dshsp_btn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l2)}',
        '.dshsp_btn:disabled{opacity:.5;cursor:default}',
        '.dshsp_btnDanger{color:var(--dsw-alias-state-error-primary)}',
        '.dshsp_btnDangerSolid{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:#fff}',
        '.dshsp_btnDangerSolid:hover:not(:disabled){background:var(--dsw-alias-state-error-primary);filter:brightness(1.05)}',
        '.dshsp_linkBtn{border:none;background:none;padding:0;font:inherit;font-size:12px;color:var(--dsw-alias-brand-primary);cursor:pointer;text-decoration:underline}',
        '.dshsp_row{display:flex;align-items:flex-start;gap:14px;padding:12px 14px;margin:0 0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);transition:border-color 120ms ease}',
        '.dshsp_row:hover{border-color:var(--dsw-alias-border-l2)}',
        '.dshsp_rowOrphan{border-color:var(--dsw-alias-state-warn-primary)}',
        '.dshsp_rowMain{flex:1;min-width:0}',
        '.dshsp_rowTitle{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:14px;font-weight:600;line-height:1.4}',
        '.dshsp_rowName{overflow-wrap:anywhere}',
        '.dshsp_rowSub{display:flex;align-items:center;gap:8px;margin-top:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
        '.dshsp_iconBtn{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid transparent;border-radius:7px;background:none;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11px;line-height:1}',
        '.dshsp_iconBtn:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);color:var(--dsw-alias-label-primary)}',
        '.dshsp_iconBtn:disabled{opacity:.5;cursor:default}',
        '.dshsp_iconBtnDanger:hover:not(:disabled){color:var(--dsw-alias-state-error-primary);border-color:currentColor}',
        '.dshsp_details{display:flex;flex-direction:column;gap:6px;margin-top:9px;padding:9px 11px;border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px}',
        '.dshsp_detailRow{display:flex;align-items:flex-start;gap:10px}',
        '.dshsp_detailLabel{flex:none;width:64px;color:var(--dsw-alias-label-secondary)}',
        '.dshsp_detailValue{min-width:0;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary);white-space:pre-wrap}',
        '.dshsp_detailValue .dshsp_copyBtn{margin-left:8px}',
        '.dshsp_rowMeta{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:6px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
        '.dshsp_cwd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}',
        '.dshsp_dot{width:3px;height:3px;border-radius:999px;background:currentColor;opacity:.45;flex:none}',
        '.dshsp_rowId{display:flex;align-items:center;gap:8px;margin-top:5px;font-size:11px;color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere}',
        '.dshsp_traceLine{margin-top:4px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
        '.dshsp_rowWarn{margin-top:6px;padding:6px 8px;border-radius:6px;border:1px solid var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary);font-size:12px}',
        '.dshsp_path{margin-top:4px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:var(--dsw-alias-label-secondary);word-break:break-all;opacity:.85}',
        '.dshsp_mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
        '.dshsp_copyBtn{border:none;background:none;padding:0;font:inherit;font-size:11px;color:var(--dsw-alias-brand-primary);cursor:pointer;text-decoration:underline;flex:none}',
        '.dshsp_badge{display:inline-flex;align-items:center;padding:1px 7px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:11px;font-weight:400;color:var(--dsw-alias-label-secondary)}',
        '.dshsp_badgeLive{color:var(--dsw-alias-state-success-primary);border-color:currentColor}',
        '.dshsp_badgeWarn{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}',
        '.dshsp_badgeMuted{opacity:.85}',
        '.dshsp_rowActions{display:flex;gap:4px;flex:none;align-items:flex-start;opacity:.85;transition:opacity 120ms ease}',
        '.dshsp_row:hover .dshsp_rowActions,.dshsp_rowActions:focus-within{opacity:1}',
        '.dshsp_group{margin:0 0 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-base)}',
        '.dshsp_groupHeader{display:grid;grid-template-columns:14px 18px minmax(0,1fr) auto;align-items:center;gap:10px;width:100%;padding:12px 14px;border:none;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer;text-align:left}',
        '.dshsp_groupHeader:hover{background:var(--dsw-alias-bg-layer-1)}',
        '.dshsp_chevron{display:inline-flex;align-items:center;justify-content:center;flex:none;color:var(--dsw-alias-label-secondary)}',
        '.dshsp_groupIcon{display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-brand-primary)}',
        '.dshsp_groupText{display:flex;flex-direction:column;gap:3px;min-width:0}',
        '.dshsp_groupEyebrow{font-size:10px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--dsw-alias-label-secondary);opacity:.85}',
        '.dshsp_groupTitle{font-size:15px;font-weight:600;line-height:1.35;overflow-wrap:anywhere}',
        '.dshsp_groupPath{font-size:11.5px;color:var(--dsw-alias-label-secondary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.dshsp_groupMeta{display:flex;flex-direction:column;align-items:flex-end;gap:4px;flex:none}',
        '.dshsp_groupCount{padding:2px 9px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
        '.dshsp_groupSize{font-size:11px;color:var(--dsw-alias-label-secondary);opacity:.75}',
        '.dshsp_groupBody{padding:12px 12px 4px}',
        '.dshsp_sectionTitle{margin:18px 0 8px;font-size:12px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-secondary)}',
        '.dshsp_confirm{display:flex;align-items:center;gap:10px;padding:10px 14px;margin:0 0 12px;border:1px solid var(--dsw-alias-state-warn-primary);border-radius:10px;background:var(--dsw-alias-bg-layer-2);font-size:13px}',
        '.dshsp_confirmText{flex:1;min-width:0}',
        '.dshsp_error,.dshsp_notice{padding:9px 12px;margin:0 0 12px;border-radius:8px;font-size:13px;border:1px solid}',
        '.dshsp_error{color:var(--dsw-alias-state-error-primary);border-color:currentColor;background:var(--dsw-alias-bg-layer-1)}',
        '.dshsp_notice{color:var(--dsw-alias-state-success-primary);border-color:currentColor;background:var(--dsw-alias-bg-layer-1)}',
        '.dshsp_empty{padding:24px 0;font-size:13px;color:var(--dsw-alias-label-secondary)}',
        '.dshsp_footer{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin-top:14px;font-size:12px;color:var(--dsw-alias-label-secondary)}',
        '.dshsp_muted{opacity:.7;margin-top:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}',
        '.dshsp_warnings{margin-top:20px;font-size:12px;color:var(--dsw-alias-state-warn-primary)}',
      ].join('\n')
      document.head.appendChild(style)
    }

    function SectionIcon(props) {
      const dimension = typeof props?.size === 'number' && props.size > 0 ? props.size : 16
      return h('svg', {
        width: dimension,
        height: dimension,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        strokeWidth: 1.3,
        strokeLinecap: 'round',
        strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M2.5 4.5h11' }),
        h('path', { d: 'M6 4.5V2.9c0-.5.4-.9.9-.9h2.2c.5 0 .9.4.9.9v1.6' }),
        h('path', { d: 'M4 4.5l.6 8.4c.05.7.6 1.1 1.3 1.1h4.2c.7 0 1.25-.4 1.3-1.1L12 4.5' }),
        h('path', { d: 'M6.6 7v4.2M9.4 7v4.2' }),
      )
    }

    return {
      name: NS,
      inject: ['slots', 'locale'],
      apply(ctx) {
        ensureStyles()
        try {
          localeApi = ctx.locale ?? null
          if (ctx.locale !== undefined && typeof ctx.locale.register === 'function') {
            // Registered so the shell's locale service also knows these strings;
            // the page itself always renders the Chinese dictionary.
            ctx.locale.register(NS, 'zh', ZH)
            ctx.locale.register(NS, 'en', EN)
          }
        } catch (error) {
          console.warn('[session-purge] locale init failed:', error)
        }
        try {
          if (typeof ctx.inject === 'function') {
            ctx.inject(['sessions'], (scope) => {
              sessionsApi = scope?.sessions ?? null
            })
          }
        } catch (error) {
          console.warn('[session-purge] sessions inject failed:', error)
        }
        ctx.effect(() => {
          const disposers = []
          const disposeInjection = ctx.slots.inject('settings.section', () => {
            const sectionDispose = ctx.slots.register({
              name: 'settings.section',
              id: CLIENT_ID,
              order: 100,
              label: () => t('title'),
              locale: NS,
              inject: () => ({}),
            }, SectionPage)
            if (typeof sectionDispose === 'function') disposers.push(sectionDispose)
            // The icon belongs to the same settings-shell owner as the section
            // above, so the owner is declared by the time this callback runs. A
            // direct registration during page boot could run before the owner
            // existed and blocked the whole client plugin; keep it inside the
            // deferred callback and never let an icon failure take the section
            // down with it.
            try {
              const iconDispose = ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
                name: 'settings.section.icon',
                id: CLIENT_ID,
                locale: NS,
              }, SectionIcon))
              if (typeof iconDispose === 'function') disposers.push(iconDispose)
            } catch (error) {
              console.warn('[session-purge] settings icon registration failed:', error)
            }
            return sectionDispose
          })
          if (typeof disposeInjection === 'function') disposers.push(disposeInjection)
          return () => {
            for (const dispose of disposers.splice(0)) {
              try {
                dispose?.()
              } catch {
                // owning fiber already disposed it
              }
            }
          }
        }, 'session-purge: settings section')
      },
    }
  },
})
