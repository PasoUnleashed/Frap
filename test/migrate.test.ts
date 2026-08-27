/**
 * The format-version machinery. The point of these is that opening an older
 * collection keeps working, and that a file from a newer Frap is refused
 * rather than quietly mangled.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import { FORMAT_VERSION } from '../src/shared/types.ts'
import { FormatTooNewError, migrateDocument, versionOf } from '../src/main/migrate.ts'
import { readFolderMeta, readRequest, serializeRequest } from '../src/main/workspace.ts'

test('a file with no version marker is treated as the first format', () => {
  assert.equal(versionOf({ name: 'Old' }), 1)
  assert.equal(versionOf({ frap: 1 }), 1)
  assert.equal(versionOf({ frap: 2 }), 2)
  // Junk in the field must not be trusted as a version.
  assert.equal(versionOf({ frap: 'banana' }), 1)
  assert.equal(versionOf(null), 1)
})

test('migrating stamps the current version', () => {
  const { doc, from, upgraded } = migrateDocument('request', { method: 'GET' }, 'x.frap.json')
  assert.equal(from, 1)
  assert.equal(upgraded, true)
  assert.equal(doc.frap, FORMAT_VERSION)
})

test('a current-version file is left alone', () => {
  const { from, upgraded } = migrateDocument(
    'request',
    { frap: FORMAT_VERSION, method: 'GET' },
    'x.frap.json'
  )
  assert.equal(from, FORMAT_VERSION)
  assert.equal(upgraded, false)
})

test('a file from a newer Frap is refused, not guessed at', () => {
  assert.throws(
    () => migrateDocument('request', { frap: FORMAT_VERSION + 1 }, 'Future.frap.json'),
    (err: unknown) => {
      assert.ok(err instanceof FormatTooNewError)
      assert.match((err as Error).message, /Future\.frap\.json/)
      assert.match((err as Error).message, /Update Frap/)
      return true
    }
  )
})

test('something that is not an object is not a Frap file', () => {
  assert.throws(() => migrateDocument('request', [1, 2, 3], 'x'), /not a Frap file/)
  assert.throws(() => migrateDocument('request', 'nope', 'x'), /not a Frap file/)
})

test('a v1 request on disk still loads, and keeps its meaning', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frap-migrate-'))
  try {
    const file = path.join(dir, 'Legacy.frap.json')
    // Exactly what v1 wrote: no `auth`, which meant "no auth" back then.
    await fs.writeFile(
      file,
      JSON.stringify(
        {
          frap: 1,
          id: 'legacy-id',
          name: 'Legacy',
          order: 3,
          method: 'POST',
          url: 'https://example.com',
          headers: [{ enabled: true, key: 'Accept', value: 'application/json' }]
        },
        null,
        2
      ) + '\n',
      'utf8'
    )

    const request = await readRequest(file)
    assert.equal(request.id, 'legacy-id')
    assert.equal(request.method, 'POST')
    assert.equal(request.headers[0].value, 'application/json')
    // v1 had no folder settings, so inheriting nothing is the same as none.
    assert.equal(request.auth.type, 'inherit')

    // Reading does not rewrite: a pull of old files is not a diff.
    const onDisk = JSON.parse(await fs.readFile(file, 'utf8'))
    assert.equal(onDisk.frap, 1)

    // Saving does restamp it.
    assert.match(serializeRequest(request), /"frap": 2/)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('a v1 folder file still loads and keeps its order', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frap-migrate-'))
  try {
    await fs.writeFile(
      path.join(dir, '_folder.frap.json'),
      JSON.stringify({ frap: 1, order: 7 }, null, 2) + '\n',
      'utf8'
    )
    const meta = await readFolderMeta(dir)
    assert.equal(meta?.order, 7)
    // The v2 fields arrive empty rather than missing.
    assert.deepEqual(meta?.headers, [])
    assert.equal(meta?.auth.type, 'inherit')
    assert.equal(meta?.scripts.preRequest, '')
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
