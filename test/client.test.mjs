import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

function loadClient() {
  let definition
  const fakeReact = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (value) => [typeof value === 'function' ? value() : value, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
  const sandbox = {
    window: { __ModuleLoader__: { load: (value) => { definition = value } } },
    console,
    require: (name) => (name === 'react' ? fakeReact : undefined),
    setTimeout: () => 0,
    clearTimeout: () => {},
    navigator: { clipboard: { writeText() {} } },
    document: undefined,
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  assert.equal(definition?.id, '@local/session-purge')
  return definition.factory(sandbox.require)
}

function createSlots() {
  const declared = new Set()
  const pending = new Map()
  const registered = []
  const disposed = []
  const slots = {
    register(options, component) {
      if (!declared.has(options.name)) throw new Error(`slot not declared: ${options.name}`)
      registered.push({ options, component })
      let gone = false
      return () => {
        if (gone) return
        gone = true
        disposed.push(options.name)
      }
    },
    inject(name, callback) {
      if (declared.has(name)) {
        const result = callback()
        return typeof result === 'function' ? result : () => {}
      }
      const list = pending.get(name) ?? []
      list.push(callback)
      pending.set(name, list)
      return () => {
        const current = pending.get(name) ?? []
        const index = current.indexOf(callback)
        if (index >= 0) current.splice(index, 1)
      }
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
    pendingCount(name) {
      return (pending.get(name) ?? []).length
    },
    registered,
    disposed,
  }
  return slots
}

function applyWith(slots, options = {}) {
  const mod = loadClient()
  let effectCleanup
  const ctx = {
    locale: {
      register() {},
      bind: () => (key) => key,
      getSnapshot: () => ({ active: 'zh' }),
      subscribe: () => () => {},
    },
    inject: (_deps, callback) => { callback({ sessions: null }) },
    slots,
    effect: (fn) => {
      effectCleanup = fn()
      return () => effectCleanup?.()
    },
    ...(options.ctx ?? {}),
  }
  mod.apply(ctx)
  return { module: mod, getCleanup: () => effectCleanup }
}

test('client boot defers settings.section and icon registration until their owners exist', () => {
  const slots = createSlots()
  const { module, getCleanup } = applyWith(slots)

  assert.equal(module.name, '@local/session-purge')
  // Cold boot: calling register here would throw because no owner has declared
  // the slot yet. apply must only enqueue an injection.
  assert.deepEqual(slots.registered, [])
  assert.equal(slots.pendingCount('settings.section'), 1)

  slots.declare('settings.section')
  assert.deepEqual(slots.registered.map((entry) => entry.options.name), ['settings.section'])
  assert.equal(slots.registered[0].options.label(), '彻底删除会话')
  assert.equal(slots.pendingCount('settings.section.icon'), 1)

  slots.declare('settings.section.icon')
  assert.deepEqual(slots.registered.map((entry) => entry.options.name), ['settings.section', 'settings.section.icon'])
  assert.equal(typeof slots.registered[0].component, 'function')

  getCleanup()()
  assert.deepEqual(slots.disposed.sort(), ['settings.section', 'settings.section.icon'])
})

test('an icon registration failure never prevents the settings section from registering', () => {
  const slots = createSlots()
  // Simulate the icon slot already being present but rejecting this registration.
  slots.declare('settings.section.icon')
  const originalRegister = slots.register
  slots.register = (options, component) => {
    if (options.name === 'settings.section.icon') throw new Error('icon registration rejected')
    return originalRegister(options, component)
  }

  const { getCleanup } = applyWith(slots)
  assert.doesNotThrow(() => slots.declare('settings.section'))
  assert.deepEqual(slots.registered.map((entry) => entry.options.name), ['settings.section'])
  assert.doesNotThrow(() => getCleanup()())
})
