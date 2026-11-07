import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function createSlots() {
  const declared = new Set()
  const pending = new Map()
  const registered = []
  return {
    registered,
    register(options, component) {
      if (!declared.has(options.name)) throw new Error(`slot not declared: ${options.name}`)
      registered.push({ options, component })
      return () => {}
    },
    inject(name, callback) {
      if (declared.has(name)) {
        const result = callback()
        return typeof result === 'function' ? result : () => {}
      }
      const list = pending.get(name) ?? []
      list.push(callback)
      pending.set(name, list)
      return () => {}
    },
    declare(name) {
      declared.add(name)
      const list = pending.get(name) ?? []
      pending.delete(name)
      for (const callback of list) {
        const result = callback()
        if (typeof result === 'function') result()
      }
    },
  }
}

const sameDeps = (left, right) => Array.isArray(left) && Array.isArray(right)
  && left.length === right.length && left.every((value, index) => Object.is(value, right[index]))

function createHookRuntime() {
  const state = []
  const effects = []
  const callbacks = []
  const refs = []
  let cursor = 0
  let component
  let tree
  let scheduled = false
  let running = false

  const render = () => {
    if (component === undefined) return
    cursor = 0
    running = true
    tree = component()
    running = false
    for (const effect of effects) {
      if (effect === undefined || effect.pending === false) continue
      effect.pending = false
      effect.fn()
    }
  }
  const schedule = () => {
    if (running || scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      render()
    })
  }

  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const index = cursor++
      if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial
      return [state[index], (next) => {
        const value = typeof next === 'function' ? next(state[index]) : next
        if (Object.is(value, state[index])) return
        state[index] = value
        schedule()
      }]
    },
    useEffect(fn, deps) {
      const index = cursor++
      const existing = effects[index]
      if (existing === undefined) effects[index] = { fn, deps, pending: true }
      else if (!sameDeps(existing.deps, deps)) {
        existing.fn = fn
        existing.deps = deps
        existing.pending = true
      }
    },
    useCallback(fn, deps) {
      const index = cursor++
      const existing = callbacks[index]
      if (existing === undefined || !sameDeps(existing.deps, deps)) {
        callbacks[index] = { fn, deps }
        return fn
      }
      return existing.fn
    },
    useRef(value) {
      const index = cursor++
      if (refs[index] === undefined) refs[index] = { current: value }
      return refs[index]
    },
  }

  return {
    React,
    setComponent(next) { component = next },
    render,
    getTree: () => tree,
  }
}

function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object') return textOf(node.children)
  return ''
}

function walk(node, visit) {
  if (node === null || node === undefined || node === false) return
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit)
    return
  }
  if (typeof node !== 'object') return
  visit(node)
  walk(node.children, visit)
}

function findButtons(tree, text) {
  const found = []
  walk(tree, (node) => {
    if (node.type === 'button' && textOf(node).includes(text)) found.push(node)
  })
  return found
}

function fixture() {
  const sessions = [
    {
      id: 'session-blank01',
      title: '',
      blank: true,
      live: false,
      orphan: false,
      bytes: 100,
      createdAt: 1700000000000,
      mtimeMs: 0,
      files: 1,
      turns: 0,
      cwd: '',
      dirPaths: [],
      projectPaths: [],
      workspaceIds: [],
      traces: { projectionCache: true, workspaces: [], archived: false, pinned: false, favorite: false, spill: false },
    },
    {
      id: 'session-live01',
      title: 'keep me',
      blank: false,
      live: true,
      orphan: false,
      bytes: 200,
      createdAt: 1700000001000,
      mtimeMs: 0,
      files: 1,
      turns: 2,
      cwd: '/tmp/keep',
      dirPaths: [],
      projectPaths: [],
      workspaceIds: [],
      traces: { projectionCache: true, workspaces: [], archived: false, pinned: false, favorite: false, spill: false },
    },
  ]
  return {
    ok: true,
    pluginVersion: '0.1.2',
    home: '/tmp/home',
    sessionsRoot: '/tmp/home/sessions',
    sessions,
    workspaces: [],
    counts: { sessions: 2, tracked: 2, live: 1, orphans: 0, staleProjectionCaches: 0, staleWorkspaceRefs: 0, staleIndexEntries: 0 },
    cleanup: {
      orphanSessionIds: [],
      orphanBytes: 0,
      staleProjectionCacheIds: [],
      staleProjectionCacheBytes: 0,
      staleWorkspaceRefIds: [],
      staleFavoriteIds: [],
      staleIndexIds: [],
      emptyProjectDirs: [],
      reclaimableBytes: 0,
    },
    auto: { enabled: true, eventListener: true, hooked: true, methods: [], count: 0, lastEvent: null, lastAt: null, lastResult: null },
    warnings: [],
  }
}

test('blank-session delete runs in one click and keeps the settings page scroll position', async () => {
  const slots = createSlots()
  const hooks = createHookRuntime()
  let definition
  let purgedBody

  const fetch = async (url, init) => {
    if (init?.method === 'POST' && String(url).endsWith('/purge')) {
      purgedBody = JSON.parse(init.body)
      const ids = purgedBody.sessionIds ?? []
      return {
        ok: true,
        json: async () => ({
          ok: true,
          results: ids.map((sessionId) => ({ sessionId, status: 'deleted', bytes: 100 })),
        }),
      }
    }
    return { ok: true, json: async () => fixture() }
  }

  const sandbox = {
    window: {
      __ModuleLoader__: { load: (value) => { definition = value } },
      scrollY: 320,
      scrollTo: (_x, y) => { sandbox.window.scrolledTo = y },
    },
    console: { warn() {} },
    require: (name) => (name === 'react' ? hooks.React : undefined),
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch,
    navigator: { clipboard: { writeText() {} } },
    document: undefined,
    queueMicrotask,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.equal(definition?.id, '@local/session-purge')
  const module = definition.factory(sandbox.require)
  const ctx = {
    locale: { register() {}, subscribe: () => () => {} },
    inject: (_deps, callback) => { callback({ sessions: null }) },
    slots,
    effect: (fn) => { fn() },
  }
  module.apply(ctx)
  slots.declare('settings.section')
  const SectionPage = slots.registered[0].component

  hooks.setComponent(SectionPage)
  hooks.render()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const toolbarButtons = findButtons(hooks.getTree(), '删除空白会话（1）')
  assert.equal(toolbarButtons.length, 1)
  assert.equal(toolbarButtons[0].props.disabled, false)
  assert.equal(sandbox.window.scrolledTo, undefined)

  toolbarButtons[0].props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  const confirmation = findButtons(hooks.getTree(), '删除空白会话（1）')
    .find((button) => String(button.props.className ?? '').includes('dshsp_btnDangerSolid'))
  assert.ok(confirmation, 'confirmation button should be rendered')

  confirmation.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  assert.deepEqual(purgedBody?.sessionIds, ['session-blank01'])
  assert.equal(purgedBody?.allowLive, false)
  assert.equal(sandbox.window.scrolledTo, 320)
  assert.ok(textOf(hooks.getTree()).includes('已删除 1 个空白会话'))
})

test('update button downloads and applies the latest release', async () => {
  const slots = createSlots()
  const hooks = createHookRuntime()
  let definition
  let updatePosted = false

  const fetch = async (url, init) => {
    if (String(url).endsWith('/update')) {
      if (init?.method === 'POST') {
        updatePosted = true
        return { ok: true, json: async () => ({ ok: true, updated: true, latestVersion: '0.1.3', restartRequired: true }) }
      }
      return { ok: true, json: async () => ({ ok: true, currentVersion: '0.1.2', latestVersion: '0.1.3', updateAvailable: true }) }
    }
    return { ok: true, json: async () => fixture() }
  }

  const sandbox = {
    window: {
      __ModuleLoader__: { load: (value) => { definition = value } },
      scrollY: 0,
      scrollTo: () => {},
      confirm: () => true,
    },
    console: { warn() {} },
    require: (name) => (name === 'react' ? hooks.React : undefined),
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch,
    navigator: { clipboard: { writeText() {} } },
    document: undefined,
    queueMicrotask,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  const module = definition.factory(sandbox.require)
  const ctx = {
    locale: { register() {}, subscribe: () => () => {} },
    inject: (_deps, callback) => { callback({ sessions: null }) },
    slots,
    effect: (fn) => { fn() },
  }
  module.apply(ctx)
  slots.declare('settings.section')
  hooks.setComponent(slots.registered[0].component)
  hooks.render()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const updateButton = findButtons(hooks.getTree(), '更新到 v0.1.3')[0]
  assert.ok(updateButton, 'update button should be visible')
  updateButton.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(updatePosted, true)
  assert.ok(textOf(hooks.getTree()).includes('已更新到 v0.1.3'))
})

test('same-version content drift shows 修复安装 button and repair confirmation', async () => {
  const slots = createSlots()
  const hooks = createHookRuntime()
  let definition
  let updatePosted = false
  let confirmMessage = ''

  const fetch = async (url, init) => {
    if (String(url).endsWith('/update')) {
      if (init?.method === 'POST') {
        updatePosted = true
        return { ok: true, json: async () => ({ ok: true, updated: true, latestVersion: '0.1.2', restartRequired: true }) }
      }
      return { ok: true, json: async () => ({ ok: true, currentVersion: '0.1.2', latestVersion: '0.1.2', updateAvailable: true, contentDrift: true }) }
    }
    return { ok: true, json: async () => fixture() }
  }

  const sandbox = {
    window: {
      __ModuleLoader__: { load: (value) => { definition = value } },
      scrollY: 0,
      scrollTo: () => {},
      confirm: (message) => { confirmMessage = message; return true },
    },
    console: { warn() {} },
    require: (name) => (name === 'react' ? hooks.React : undefined),
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch,
    navigator: { clipboard: { writeText() {} } },
    document: undefined,
    queueMicrotask,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  const module = definition.factory(sandbox.require)
  const ctx = {
    locale: { register() {}, subscribe: () => () => {} },
    inject: (_deps, callback) => { callback({ sessions: null }) },
    slots,
    effect: (fn) => { fn() },
  }
  module.apply(ctx)
  slots.declare('settings.section')
  hooks.setComponent(slots.registered[0].component)
  hooks.render()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))

  const repairButton = findButtons(hooks.getTree(), '修复安装 v0.1.2')[0]
  assert.ok(repairButton, 'repair button should be visible on content drift')
  repairButton.props.onClick()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(confirmMessage, /发布内容已修复（版本号不变）/, 'confirmation should use the repair wording')
  assert.equal(updatePosted, true)
  assert.ok(textOf(hooks.getTree()).includes('已更新到 v0.1.2'))
})

test('settings page shows the installed plugin version', async () => {
  const slots = createSlots()
  const hooks = createHookRuntime()
  let definition
  const fetch = async () => ({ ok: true, json: async () => fixture() })
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (value) => { definition = value } },
      scrollY: 0,
      scrollTo: () => {},
      confirm: () => true,
    },
    console: { warn() {} },
    require: (name) => (name === 'react' ? hooks.React : undefined),
    setTimeout: () => 0,
    clearTimeout: () => {},
    fetch,
    navigator: { clipboard: { writeText() {} } },
    document: undefined,
    queueMicrotask,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  const module = definition.factory(sandbox.require)
  const ctx = {
    locale: { register() {}, subscribe: () => () => {} },
    inject: (_deps, callback) => { callback({ sessions: null }) },
    slots,
    effect: (fn) => { fn() },
  }
  module.apply(ctx)
  slots.declare('settings.section')
  hooks.setComponent(slots.registered[0].component)
  hooks.render()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(textOf(hooks.getTree()).includes('当前版本 v0.1.2'), 'installed version should be visible')
})
