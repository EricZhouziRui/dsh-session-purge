import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const installer = fileURLToPath(new URL('../install.mjs', import.meta.url))
const installerOptions = existsSync(installer)
  ? {}
  : { skip: 'install.mjs 不在当前副本中（安装副本不包含安装器），跳过' }

async function makeHome() {
  const home = await mkdtemp(join(tmpdir(), 'dshsp-install-'))
  const profileDir = join(home, 'profiles', 'desktop')
  await mkdir(profileDir, { recursive: true })
  await writeFile(join(profileDir, 'package.json'), JSON.stringify({
    name: 'desktop-profile',
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
  }, null, 2))
  return { home, profileDir }
}

function install(home, args = []) {
  return spawnSync(process.execPath, [installer, '--home', home, '--profile', 'desktop', ...args], {
    encoding: 'utf8',
  })
}

test('installer dry-run leaves the profile untouched', installerOptions, async () => {
  const { home, profileDir } = await makeHome()
  const profileFile = join(profileDir, 'package.json')
  const before = await readFile(profileFile, 'utf8')
  const result = install(home, ['--dry-run'])
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /预演/)
  assert.equal(await readFile(profileFile, 'utf8'), before)
  assert.equal(existsSync(join(profileDir, 'local-plugins')), false)
  await rm(home, { recursive: true, force: true })
})

test('installer copies the bundle, updates dependencies and bundles, then is idempotent', installerOptions, async () => {
  const { home, profileDir } = await makeHome()
  const first = install(home)
  assert.equal(first.status, 0, first.stderr)

  const profileFile = join(profileDir, 'package.json')
  const profile = JSON.parse(await readFile(profileFile, 'utf8'))
  assert.deepEqual(Object.keys(profile.dependencies).sort(), ['@local/session-purge'])
  assert.match(profile.dependencies['@local/session-purge'], /^file:\.\/local-plugins\//)
  assert.equal(profile.dsh.profile.bundles.filter((name) => name === '@local/session-purge').length, 1)

  const pluginDir = join(profileDir, 'local-plugins', '@local', 'session-purge')
  assert.equal(existsSync(join(pluginDir, 'package.json')), true)
  assert.equal(existsSync(join(profileDir, 'node_modules', '@local', 'session-purge', 'engine.js')), true)
  assert.equal(existsSync(join(profileDir, 'package.json.session-purge.bak')), true)

  const second = install(home)
  assert.equal(second.status, 0, second.stderr)
  const again = JSON.parse(await readFile(profileFile, 'utf8'))
  assert.equal(again.dsh.profile.bundles.filter((name) => name === '@local/session-purge').length, 1)
  assert.deepEqual(Object.keys(again.dependencies).sort(), Object.keys(profile.dependencies).sort())
  await rm(home, { recursive: true, force: true })
})

test('installer --link keeps the checkout as the source', installerOptions, async () => {
  const { home, profileDir } = await makeHome()
  const result = install(home, ['--link'])
  assert.equal(result.status, 0, result.stderr)

  const profile = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  assert.match(profile.dependencies['@local/session-purge'], /^link:/)
  const pluginDir = join(profileDir, 'local-plugins', '@local', 'session-purge')
  assert.equal(lstatSync(pluginDir).isSymbolicLink(), true)
  assert.equal(existsSync(join(pluginDir, 'engine.js')), true)
  await rm(home, { recursive: true, force: true })
})

test('installer rejects missing flag values, unknown profiles and bad homes', installerOptions, async () => {
  const { home } = await makeHome()
  for (const args of [
    [installer, '--home'],
    [installer, '--profile'],
    [installer, '--home', home, '--profile', 'does-not-exist'],
    [installer, '--home', join(home, 'missing')],
  ]) {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8' })
    assert.notEqual(result.status, 0, `expected failure for ${args.slice(1).join(' ')}`)
  }
  await rm(home, { recursive: true, force: true })
})
