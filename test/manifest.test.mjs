import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The updater downloads the committed (LF) bytes from GitHub, so the manifest
 * must hash those bytes no matter whether this checkout uses CRLF or LF.
 */
function canonicalDigest(bytes) {
  const canonical = bytes.toString('utf8').replace(/\r\n/g, '\n')
  return createHash('sha256').update(Buffer.from(canonical, 'utf8')).digest('hex')
}

test('update-manifest.json lists every published file with canonical LF SHA-256', async () => {
  const manifest = JSON.parse(await readFile(join(root, 'update-manifest.json'), 'utf8'))
  const packageData = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

  assert.equal(manifest.name, '@local/session-purge')
  assert.equal(manifest.version, packageData.version)
  assert.ok(manifest.files !== null && typeof manifest.files === 'object')

  for (const [relative, expected] of Object.entries(manifest.files)) {
    assert.match(expected, /^[0-9a-f]{64}$/, `invalid hash for ${relative}`)
    const bytes = await readFile(join(root, relative))
    assert.equal(
      canonicalDigest(bytes),
      expected,
      `update-manifest.json is stale for ${relative}; run npm run manifest`,
    )
  }
})
