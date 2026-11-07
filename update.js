/**
 * In-app self-update support.
 *
 * The updater talks to the public GitHub repository, reads the file manifest
 * attached to a release tag, verifies every file hash and then replaces the
 * copied plugin files inside the DSH profile. It deliberately refuses symlink
 * (developer `--link`) installations: those must be updated with git/install.mjs
 * so a running checkout is never rewritten behind the developer's back.
 *
 * @module session-purge/update
 */

import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

export const DEFAULT_REPO = 'EricZhouziRui/dsh-session-purge'
export const MANIFEST_NAME = 'update-manifest.json'

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex')
}

function stripVersion(value) {
  return String(value ?? '').trim().replace(/^v/i, '')
}

/** Numeric semver comparison; enough for this plugin's `x.y.z` releases. */
export function compareVersions(left, right) {
  const a = stripVersion(left).split('.').map((part) => Number.parseInt(part, 10) || 0)
  const b = stripVersion(right).split('.').map((part) => Number.parseInt(part, 10) || 0)
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0)
    if (difference !== 0) return difference > 0 ? 1 : -1
  }
  return 0
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function encodePath(path) {
  return path.split('/').map((part) => encodeURIComponent(part)).join('/')
}

/** Reject absolute paths and traversal in a release manifest. */
function safeRelativePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.length > 240) throw new Error('更新清单包含非法路径')
  const normalized = path.replace(/\\/g, '/')
  const parts = normalized.split('/')
  if (normalized.startsWith('/') || parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`更新清单包含非法路径：${path}`)
  }
  return normalized
}

async function readJson(response, label) {
  let data
  try {
    data = await response.json()
  } catch {
    throw new Error(`${label} 不是合法 JSON`)
  }
  return data
}

async function getJson(url, fetchImpl, label) {
  const response = await fetchImpl(url, {
    headers: {
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-session-purge-updater',
    },
  })
  if (!response.ok) throw new Error(`${label} 请求失败：HTTP ${response.status}`)
  return readJson(response, label)
}

async function hasGitAncestor(directory) {
  let current = directory
  for (let depth = 0; depth < 4; depth += 1) {
    try {
      if ((await lstat(join(current, '.git'))).isDirectory()) return true
    } catch {
      // keep walking up
    }
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return false
}

async function getRaw(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { 'user-agent': 'dsh-session-purge-updater' },
  })
  if (!response.ok) throw new Error(`下载更新文件失败：HTTP ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/**
 * Ask GitHub for the latest published release.
 *
 * @param {object} options
 * @param {string} options.currentVersion - installed version.
 * @param {string} [options.repo] - `owner/name`.
 * @param {typeof fetch} [options.fetchImpl] - injected for tests.
 * @returns {Promise<object>} check result.
 */
export async function checkForUpdate(options) {
  const currentVersion = stripVersion(options.currentVersion)
  const repo = options.repo ?? DEFAULT_REPO
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') return { ok: false, error: '当前运行环境不支持网络请求' }
  try {
    const release = await getJson(
      `https://api.github.com/repos/${repo}/releases/latest`,
      fetchImpl,
      '读取 GitHub Release',
    )
    const tag = typeof release?.tag_name === 'string' ? release.tag_name : ''
    const latestVersion = stripVersion(tag)
    if (latestVersion.length === 0) return { ok: false, error: 'GitHub Release 没有 tag' }
    return {
      ok: true,
      currentVersion,
      latestVersion,
      updateAvailable: compareVersions(latestVersion, currentVersion) > 0,
      tag,
      releaseUrl: typeof release.html_url === 'string' ? release.html_url : undefined,
      publishedAt: typeof release.published_at === 'string' ? release.published_at : undefined,
      notes: typeof release.body === 'string' ? release.body.slice(0, 2000) : '',
    }
  } catch (error) {
    return { ok: false, error: errorMessage(error) }
  }
}

/**
 * Download and install the latest release into an existing copy installation.
 *
 * @param {object} options
 * @param {string} options.pluginDir - directory containing the running plugin.
 * @param {string} options.currentVersion - installed version.
 * @param {string} [options.repo] - `owner/name`.
 * @param {typeof fetch} [options.fetchImpl] - injected for tests.
 * @returns {Promise<object>} update result.
 */
export async function applyUpdate(options) {
  const repo = options.repo ?? DEFAULT_REPO
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  const pluginDir = options.pluginDir
  if (typeof pluginDir !== 'string' || pluginDir.length === 0) return { ok: false, error: '无法定位插件安装目录' }
  if (typeof fetchImpl !== 'function') return { ok: false, error: '当前运行环境不支持网络请求' }

  let target
  try {
    const entry = await lstat(pluginDir)
    if (entry.isSymbolicLink()) {
      return { ok: false, error: '当前是开发链接安装，不能在应用内更新；请用 install.mjs 更新，或重新以复制模式安装。' }
    }
    target = await realpath(pluginDir)
    if (await hasGitAncestor(target)) {
      return { ok: false, error: '当前是源码/Git 安装，不能在应用内更新；请在源码目录 pull 后用 install.mjs 更新。' }
    }
    const packageData = JSON.parse(await readFile(join(target, 'package.json'), 'utf8'))
    if (packageData?.name !== '@local/session-purge') {
      return { ok: false, error: '安装目录不是 session-purge 插件，已取消更新' }
    }
  } catch (error) {
    return { ok: false, error: `读取当前插件失败：${errorMessage(error)}` }
  }

  const check = await checkForUpdate({ currentVersion: options.currentVersion, repo, fetchImpl })
  if (check.ok !== true) return check
  if (check.updateAvailable !== true) {
    return { ok: true, updated: false, currentVersion: check.currentVersion, latestVersion: check.latestVersion }
  }

  const tag = check.tag
  const staging = `${target}.update-${process.pid}-${Date.now()}`
  const backup = `${target}.backup-${Date.now()}`
  try {
    const manifestResponse = await fetchImpl(
      `https://raw.githubusercontent.com/${repo}/${encodePath(tag)}/${MANIFEST_NAME}`,
      { headers: { 'user-agent': 'dsh-session-purge-updater' } },
    )
    if (!manifestResponse.ok) throw new Error(`读取更新清单失败：HTTP ${manifestResponse.status}`)
    const manifest = await readJson(manifestResponse, '更新清单')
    if (manifest?.name !== '@local/session-purge') throw new Error('更新清单属于其他插件')
    if (stripVersion(manifest.version) !== check.latestVersion) throw new Error('更新清单版本与 Release 不一致')
    if (manifest?.files === null || typeof manifest.files !== 'object') throw new Error('更新清单缺少文件列表')

    await mkdir(staging, { recursive: true })
    const files = []
    for (const [rawPath, expected] of Object.entries(manifest.files)) {
      const relative = safeRelativePath(rawPath)
      if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/i.test(expected)) {
        throw new Error(`更新清单中的哈希非法：${relative}`)
      }
      const url = `https://raw.githubusercontent.com/${repo}/${encodePath(tag)}/${encodePath(relative)}`
      const bytes = await getRaw(url, fetchImpl)
      const actual = digest(bytes)
      if (actual !== expected.toLowerCase()) throw new Error(`文件校验失败：${relative}`)
      const destination = join(staging, relative)
      await mkdir(dirname(destination), { recursive: true })
      await writeFile(destination, bytes)
      files.push(relative)
    }
    if (!files.includes('package.json')) throw new Error('更新清单缺少 package.json')

    const stagedPackage = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8'))
    if (stagedPackage?.name !== '@local/session-purge') throw new Error('更新包不是 session-purge')
    if (stripVersion(stagedPackage.version) !== check.latestVersion) throw new Error('更新包版本不匹配')

    await cp(target, backup, { recursive: true, force: true })
    for (const relative of files) {
      const source = join(staging, relative)
      const destination = join(target, relative)
      await mkdir(dirname(destination), { recursive: true })
      await cp(source, destination, { force: true })
    }
    await rm(staging, { recursive: true, force: true })
    return {
      ok: true,
      updated: true,
      currentVersion: check.currentVersion,
      latestVersion: check.latestVersion,
      releaseUrl: check.releaseUrl,
      backupPath: backup,
      restartRequired: true,
    }
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    return { ok: false, error: `更新失败：${errorMessage(error)}` }
  }
}
