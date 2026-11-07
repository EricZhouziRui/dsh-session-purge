import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const packageData = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

const files = [
  'package.json',
  'engine.js',
  'index.js',
  'client.js',
  'update.js',
  'cordis.patch.yml',
  'install.mjs',
  'README.md',
  'INSTALL.md',
  'LICENSE',
  'icon.svg',
  'locale/zh.json',
  'locale/en.json',
]

const manifest = {
  name: packageData.name,
  version: packageData.version,
  files: {},
}

for (const relative of files) {
  const bytes = await readFile(join(root, relative))
  manifest.files[relative] = createHash('sha256').update(bytes).digest('hex')
}

await writeFile(join(root, 'update-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
console.log(`wrote update-manifest.json (${packageData.name}@${packageData.version}, ${files.length} files)`)
