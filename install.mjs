#!/usr/bin/env node
/**
 * Installer for the "彻底删除会话 / DSH session purge" bundle.
 *
 * It deliberately has no fixed user name or install path. Everything is
 * resolved at runtime:
 *   DSH_HOME: --home > $DSH_HOME > ~/.dsh (plus APPDATA/LOCALAPPDATA on Windows)
 *   profile:  --profile > $DSH_PROFILE > desktop > web > first existing profile
 *
 * Default mode copies the plugin into <profile>/local-plugins so the repo can be
 * moved/deleted afterwards. --link instead keeps the profile linked to this
 * checkout for development.
 *
 * Usage:
 *   node install.mjs
 *   node install.mjs --dry-run
 *   node install.mjs --profile web
 *   node install.mjs --home /path/to/.dsh
 *   node install.mjs --link
 */

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const SOURCE_ROOT = dirname(fileURLToPath(import.meta.url))
const PACKAGE_NAME = '@local/session-purge'
const PACKAGE_PARTS = PACKAGE_NAME.split('/')
const BACKUP_NAME = 'package.json.session-purge.bak'

function fail(message) {
  console.error(`\n[安装失败] ${message}\n`)
  process.exit(1)
}

function info(message) {
  console.log(message)
}

function nextValue(argv, index, flag) {
  const value = argv[index + 1]
  if (value === undefined || value.length === 0 || value.startsWith('--')) {
    fail(`${flag} 需要一个值，但没有提供。`)
  }
  return value
}

function parseArgs(argv) {
  const args = { dryRun: false, home: undefined, profile: undefined, link: false }
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]
    if (item === '--dry-run') args.dryRun = true
    else if (item === '--link') args.link = true
    else if (item === '--home') {
      args.home = nextValue(argv, index, '--home')
      index += 1
    } else if (item === '--profile') {
      args.profile = nextValue(argv, index, '--profile')
      index += 1
    } else if (item === '--help' || item === '-h') {
      console.log('用法：node install.mjs [--dry-run] [--link] [--home <DSH_HOME>] [--profile <name>]')
      process.exit(0)
    } else {
      fail(`未知参数：${item}`)
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

function writeJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
}

function candidateHomes() {
  const candidates = [join(homedir(), '.dsh')]
  if (typeof process.env.APPDATA === 'string' && process.env.APPDATA.length > 0) {
    candidates.push(join(process.env.APPDATA, 'dsh'))
  }
  if (typeof process.env.LOCALAPPDATA === 'string' && process.env.LOCALAPPDATA.length > 0) {
    candidates.push(join(process.env.LOCALAPPDATA, 'dsh'))
  }
  return candidates
}

function hasUsableProfiles(candidate) {
  try {
    const root = join(candidate, 'profiles')
    if (!statSync(root).isDirectory()) return false
    return readdirSync(root).some((name) => {
      try {
        return statSync(join(root, name)).isDirectory()
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

let home
if (args.home !== undefined) {
  home = resolve(args.home)
} else if (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim().length > 0) {
  home = resolve(process.env.DSH_HOME)
} else {
  const candidates = candidateHomes()
  home = candidates.find(hasUsableProfiles)
    ?? candidates.find((candidate) => existsSync(candidate))
    ?? candidates[0]
}

if (!existsSync(home)) {
  fail(`没有找到 DSH 数据目录：${home}\n请先启动一次 DeepSeek Harness Desktop 后再运行本安装脚本。`)
}
if (!statSync(home).isDirectory()) fail(`DSH 数据目录不是文件夹：${home}`)

const profilesRoot = join(home, 'profiles')
if (!existsSync(profilesRoot)) {
  fail(`没有找到 profile 目录：${profilesRoot}\n请先启动一次 DSH，然后重试。`)
}
const profiles = readdirSync(profilesRoot).filter((name) => {
  try {
    return statSync(join(profilesRoot, name)).isDirectory()
  } catch {
    return false
  }
})
if (profiles.length === 0) fail(`profile 目录为空：${profilesRoot}\n请先启动一次 DSH，然后重试。`)

let profile = args.profile
if (profile === undefined || profile.length === 0) {
  const fromEnv = process.env.DSH_PROFILE
  if (typeof fromEnv === 'string' && profiles.includes(fromEnv)) profile = fromEnv
  else if (profiles.includes('desktop')) profile = 'desktop'
  else if (profiles.includes('web')) profile = 'web'
  else profile = profiles[0]
}
if (!profiles.includes(profile)) fail(`profile "${profile}" 不存在。可用 profile：${profiles.join(', ')}`)

const profileDir = join(profilesRoot, profile)
const profileFile = join(profileDir, 'package.json')
if (!existsSync(profileFile)) fail(`profile 缺少 package.json：${profileFile}\n请先启动一次 DSH，然后重试。`)

const pluginTarget = join(profileDir, 'local-plugins', ...PACKAGE_PARTS)
const nodeModulesTarget = join(profileDir, 'node_modules', ...PACKAGE_PARTS)

if (!existsSync(join(SOURCE_ROOT, 'package.json'))) fail(`源码目录不完整，缺少 package.json：${SOURCE_ROOT}`)

info('')
info('DSH 会话彻底删除插件安装器')
info(`  DSH_HOME : ${home}`)
info(`  profile  : ${profile}（${profileDir}）`)
info(`  来源     : ${SOURCE_ROOT}`)
info(`  安装到   : ${pluginTarget}`)
info(`  模式     : ${args.link ? '链接当前源码（开发模式）' : '复制到 local-plugins'}`)
info('')

if (args.dryRun) {
  info('这是预演（--dry-run），没有修改任何文件。')
  process.exit(0)
}

let profileJson
try {
  profileJson = JSON.parse(readFileSync(profileFile, 'utf8'))
} catch (error) {
  fail(`无法解析 ${profileFile}：${error instanceof Error ? error.message : String(error)}`)
}
if (profileJson === null || typeof profileJson !== 'object' || Array.isArray(profileJson)) {
  fail(`profile 配置不是 JSON 对象：${profileFile}`)
}

const backupFile = join(profileDir, BACKUP_NAME)
try {
  writeFileSync(backupFile, readFileSync(profileFile, 'utf8'), 'utf8')
} catch (error) {
  info(`提示：无法写入备份 ${backupFile}（继续安装）：${error instanceof Error ? error.message : String(error)}`)
}

function removeIfPresent(path) {
  try {
    const stats = lstatSync(path)
    if (stats.isDirectory() && !stats.isSymbolicLink()) rmSync(path, { recursive: true, force: true })
    else rmSync(path, { force: true })
  } catch {
    // missing is fine
  }
}

function copyPluginSource(target) {
  removeIfPresent(target)
  mkdirSync(dirname(target), { recursive: true })
  cpSync(SOURCE_ROOT, target, {
    recursive: true,
    filter: (entry) => {
      const name = basename(entry)
      return name !== '.git'
        && name !== 'node_modules'
        && name !== '.DS_Store'
        && name !== '.github'
        && name !== 'install.mjs'
    },
  })
}

function linkPluginSource(target) {
  removeIfPresent(target)
  mkdirSync(dirname(target), { recursive: true })
  try {
    symlinkSync(SOURCE_ROOT, target, process.platform === 'win32' ? 'junction' : 'dir')
  } catch (error) {
    fail(`无法创建符号链接（${target} → ${SOURCE_ROOT}）：${error instanceof Error ? error.message : String(error)}\nWindows 上请去掉 --link，使用默认复制模式。`)
  }
}

if (args.link) {
  linkPluginSource(pluginTarget)
  linkPluginSource(nodeModulesTarget)
  info(`✓ 已链接 ${PACKAGE_NAME} → ${pluginTarget}`)
} else {
  copyPluginSource(pluginTarget)
  info(`✓ 已复制 ${PACKAGE_NAME} → ${pluginTarget}`)
  removeIfPresent(nodeModulesTarget)
  copyPluginSource(nodeModulesTarget)
  info(`✓ 已写入 ${nodeModulesTarget}`)
}

const dependencies = profileJson.dependencies !== null && typeof profileJson.dependencies === 'object' && !Array.isArray(profileJson.dependencies)
  ? profileJson.dependencies
  : {}
if (args.link) {
  dependencies[PACKAGE_NAME] = `link:${SOURCE_ROOT}`
} else {
  const relativePath = relative(profileDir, pluginTarget).split(sep).join('/')
  dependencies[PACKAGE_NAME] = `file:./${relativePath}`
}
profileJson.dependencies = dependencies

profileJson.dsh = profileJson.dsh !== null && typeof profileJson.dsh === 'object' && !Array.isArray(profileJson.dsh) ? profileJson.dsh : {}
profileJson.dsh.profile = profileJson.dsh.profile !== null && typeof profileJson.dsh.profile === 'object' && !Array.isArray(profileJson.dsh.profile)
  ? profileJson.dsh.profile
  : {}
const bundles = Array.isArray(profileJson.dsh.profile.bundles) ? [...profileJson.dsh.profile.bundles] : []
if (!bundles.includes(PACKAGE_NAME)) bundles.push(PACKAGE_NAME)
profileJson.dsh.profile.bundles = bundles

writeJsonAtomic(profileFile, profileJson)
info('✓ 已更新 profile/package.json（dependencies + dsh.profile.bundles）')
info('')
info('安装完成！')
info('请完全退出 DeepSeek Harness Desktop（macOS：Cmd+Q；Windows：托盘退出）后重新启动。')
info('重新启动后打开：设置 → 彻底删除会话。')
info('')
info(`如需回滚 profile 配置，备份在：${backupFile}`)
