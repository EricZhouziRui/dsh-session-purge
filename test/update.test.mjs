import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyUpdate, checkForUpdate, compareVersions } from '../update.js'

const REPO = 'EricZhouziRui/dsh-session-purge'
const TAG = 'v0.1.3'

function sha(text) {
  return createHash('sha256').update(text).digest('hex')
}

async function makePlugin() {
  const root = await mkdtemp(join(tmpdir(), 'dshsp-update-'))
  const pluginDir = join(root, 'plugin')
  await mkdir(join(pluginDir, 'locale'), { recursive: true })
  await writeFile(join(pluginDir, 'package.json'), JSON.stringify({
    name: '@local/session-purge',
    version: '0.1.2',
    type: 'module',
  }, null, 2))
  await writeFile(join(pluginDir, 'engine.js'), 'export const version = "old"\n')
  await writeFile(join(pluginDir, 'locale', 'zh.json'), '{}\n')
  return { root, pluginDir }
}

function makeFetch({ manifest, files, mismatch } = {}) {
  const requested = []
  const fetch = async (url) => {
    requested.push(String(url))
    if (String(url).endsWith('/releases/latest')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          tag_name: TAG,
          html_url: 'https://github.com/EricZhouziRui/dsh-session-purge/releases/tag/v0.1.3',
          published_at: '2026-11-07T00:00:00Z',
          body: 'test release',
        }),
      }
    }
    if (String(url).endsWith(`/${TAG}/update-manifest.json`)) {
      return { ok: true, status: 200, json: async () => manifest }
    }
    const marker = `/${TAG}/`
    const index = String(url).indexOf(marker)
    const relative = decodeURIComponent(String(url).slice(index + marker.length))
    const body = files[relative]
    if (body === undefined) return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(0) }
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(body) }
  }
  return { fetch, requested }
}

test('compareVersions handles v-prefixed dotted versions', () => {
  assert.equal(compareVersions('v0.1.2', '0.1.1'), 1)
  assert.equal(compareVersions('0.1.2', 'v0.1.2'), 0)
  assert.equal(compareVersions('0.1.2', '0.1.3'), -1)
})

test('checkForUpdate reports a newer GitHub release', async () => {
  const { fetch } = makeFetch({ manifest: {}, files: {} })
  const result = await checkForUpdate({ currentVersion: '0.1.2', repo: REPO, fetchImpl: fetch })
  assert.equal(result.ok, true)
  assert.equal(result.latestVersion, '0.1.3')
  assert.equal(result.updateAvailable, true)
})

test('checkForUpdate reports no update on the same version', async () => {
  const { fetch } = makeFetch({ manifest: {}, files: {} })
  const result = await checkForUpdate({ currentVersion: '0.1.3', repo: REPO, fetchImpl: fetch })
  assert.equal(result.ok, true)
  assert.equal(result.updateAvailable, false)
})

test('applyUpdate verifies hashes, replaces files, and keeps a backup', async () => {
  const { root, pluginDir } = await makePlugin()
  const files = {
    'package.json': JSON.stringify({ name: '@local/session-purge', version: '0.1.3', type: 'module' }, null, 2),
    'engine.js': 'export const version = "new"\n',
    'locale/zh.json': '{"updated":true}\n',
    'update.js': '// updater\n',
  }
  const manifest = {
    name: '@local/session-purge',
    version: '0.1.3',
    files: Object.fromEntries(Object.entries(files).map(([path, body]) => [path, sha(body)])),
  }
  const { fetch } = makeFetch({ manifest, files })
  const result = await applyUpdate({ pluginDir, currentVersion: '0.1.2', repo: REPO, fetchImpl: fetch })
  assert.equal(result.ok, true)
  assert.equal(result.updated, true)
  assert.equal(result.restartRequired, true)
  assert.equal(JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8')).version, '0.1.3')
  assert.equal(await readFile(join(pluginDir, 'engine.js'), 'utf8'), 'export const version = "new"\n')
  assert.equal(await readFile(join(pluginDir, 'locale', 'zh.json'), 'utf8'), '{"updated":true}\n')
  assert.ok((await stat(result.backupPath)).isDirectory())
  assert.equal(await readFile(join(result.backupPath, 'engine.js'), 'utf8'), 'export const version = "old"\n')
  assert.equal((await readdir(root)).some((name) => name.includes('.update-')), false)
  await rm(root, { recursive: true, force: true })
})

test('applyUpdate refuses a symlinked developer installation', async () => {
  const { root, pluginDir } = await makePlugin()
  const link = join(root, 'plugin-link')
  await symlink(pluginDir, link)
  const { fetch } = makeFetch({ manifest: {}, files: {} })
  const result = await applyUpdate({ pluginDir: link, currentVersion: '0.1.2', repo: REPO, fetchImpl: fetch })
  assert.equal(result.ok, false)
  assert.match(result.error, /开发链接|install\.mjs/)
  await rm(root, { recursive: true, force: true })
})

test('applyUpdate rejects a file whose hash does not match and leaves the plugin untouched', async () => {
  const { root, pluginDir } = await makePlugin()
  const files = {
    'package.json': JSON.stringify({ name: '@local/session-purge', version: '0.1.3', type: 'module' }, null, 2),
    'engine.js': 'export const version = "tampered"\n',
  }
  const manifest = {
    name: '@local/session-purge',
    version: '0.1.3',
    files: { 'package.json': sha(files['package.json']), 'engine.js': '0'.repeat(64) },
  }
  const { fetch } = makeFetch({ manifest, files })
  const result = await applyUpdate({ pluginDir, currentVersion: '0.1.2', repo: REPO, fetchImpl: fetch })
  assert.equal(result.ok, false)
  assert.match(result.error, /校验失败/)
  assert.equal(JSON.parse(await readFile(join(pluginDir, 'package.json'), 'utf8')).version, '0.1.2')
  assert.equal(await readFile(join(pluginDir, 'engine.js'), 'utf8'), 'export const version = "old"\n')
  await rm(root, { recursive: true, force: true })
})
