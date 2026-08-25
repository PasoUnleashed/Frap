/**
 * Tests for the on-disk collection format. The point of these is the merge
 * story: one file per request, stable key order, no churn on re-save.
 */
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import {
  createFolder,
  createRequest,
  duplicateRequest,
  moveNode,
  normalizeRequest,
  openWorkspace,
  readRequest,
  renameNode,
  reorder,
  sanitizeName,
  scanTree,
  serializeRequest,
  writeRequest,
  assertInside
} from '../src/main/workspace.ts'

let root = ''

before(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'frap-ws-'))
})

after(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

test('opening a folder adopts any .env files already in it', async () => {
  await fs.writeFile(path.join(root, '.env'), 'A=1\n', 'utf8')
  await fs.writeFile(path.join(root, '.env.staging'), 'A=2\n', 'utf8')

  const workspace = await openWorkspace(root)
  assert.equal(workspace.config.name, path.basename(root))
  assert.deepEqual(
    workspace.config.environments.map((e) => e.file).sort(),
    ['.env', '.env.staging']
  )
  // The config file is written so the workspace is shareable straight away.
  await fs.access(path.join(root, 'frap.workspace.json'))
})

test('each request is its own file, named after the request', async () => {
  const folder = await createFolder(root, root, 'Users')
  const created = await createRequest(root, folder, 'Get User')
  assert.equal(path.basename(created), 'Get User.frap.json')

  const tree = await scanTree(root)
  const users = tree.find((n) => n.name === 'Users')
  assert.equal(users?.kind, 'folder')
  assert.equal(users?.children?.[0].name, 'Get User')
  assert.equal(users?.children?.[0].method, 'GET')
})

test('serialisation is stable, so re-saving produces no diff', async () => {
  const request = normalizeRequest(
    {
      id: 'fixed-id',
      name: 'Stable',
      order: 3,
      method: 'post',
      url: '{{BASE_URL}}/things',
      headers: [{ enabled: true, key: 'Accept', value: 'application/json' }],
      body: { mode: 'json', text: '{"a":1}' },
      scripts: { preRequest: '', postResponse: 'frap.test("ok", () => {})' }
    },
    'Stable'
  )

  const once = serializeRequest(request)
  const twice = serializeRequest(normalizeRequest(JSON.parse(once), 'Stable'))
  assert.equal(once, twice)

  // Key order is fixed, not insertion- or hash-dependent.
  assert.deepEqual(Object.keys(JSON.parse(once)), [
    'frap',
    'id',
    'name',
    'order',
    'method',
    'url',
    'headers',
    'body',
    'scripts'
  ])
  // Method is normalised, and empty sections are omitted entirely.
  assert.equal(JSON.parse(once).method, 'POST')
  assert.ok(!once.includes('"params"'))
  assert.ok(!once.includes('"auth"'))
  // Trailing newline keeps the file POSIX-clean and diff-friendly.
  assert.ok(once.endsWith('}\n'))
})

test('saving an unchanged request does not touch the file', async () => {
  const file = await createRequest(root, root, 'Untouched')
  const before = await fs.stat(file)
  const request = await readRequest(file)
  await new Promise((r) => setTimeout(r, 20))
  await writeRequest(file, request)
  const after = await fs.stat(file)
  assert.equal(before.mtimeMs, after.mtimeMs)
})

test('a partial hand-written file still loads', async () => {
  const file = path.join(root, 'Minimal.frap.json')
  await fs.writeFile(file, '{ "method": "delete", "url": "https://example.com" }\n', 'utf8')
  const request = await readRequest(file)
  assert.equal(request.method, 'DELETE')
  assert.equal(request.name, 'Minimal')
  assert.equal(request.auth.type, 'none')
  assert.deepEqual(request.params, [])
  assert.ok(request.id, 'an id is generated for files that lack one')
})

test('the file name is the source of truth for the request name', async () => {
  const file = path.join(root, 'Renamed On Disk.frap.json')
  await fs.writeFile(file, '{ "name": "Stale Name", "method": "GET", "url": "" }\n', 'utf8')
  const request = await readRequest(file)
  assert.equal(request.name, 'Renamed On Disk')
})

test('renaming moves the file and updates the name inside it', async () => {
  const file = await createRequest(root, root, 'Before')
  const next = await renameNode(root, file, 'After')
  assert.equal(path.basename(next), 'After.frap.json')
  assert.equal((await readRequest(next)).name, 'After')
  await assert.rejects(() => fs.access(file))
})

test('duplicating gives the copy a fresh id', async () => {
  const file = await createRequest(root, root, 'Original')
  const copy = await duplicateRequest(root, file)
  assert.equal(path.basename(copy), 'Original copy.frap.json')
  assert.notEqual((await readRequest(copy)).id, (await readRequest(file)).id)
})

test('name clashes get a numeric suffix instead of overwriting', async () => {
  const first = await createRequest(root, root, 'Clash')
  const second = await createRequest(root, root, 'Clash')
  assert.notEqual(first, second)
  assert.equal(path.basename(second), 'Clash 2.frap.json')
})

test('moving a request into a folder relocates the file', async () => {
  const folder = await createFolder(root, root, 'Archive')
  const file = await createRequest(root, root, 'To Move')
  const moved = await moveNode(root, file, folder)
  assert.equal(path.dirname(moved), folder)
})

test('reordering writes the position into each file', async () => {
  const folder = await createFolder(root, root, 'Ordered')
  const a = await createRequest(root, folder, 'A')
  const b = await createRequest(root, folder, 'B')
  await reorder(root, folder, [b, a])
  assert.equal((await readRequest(b)).order, 1)
  assert.equal((await readRequest(a)).order, 2)

  const tree = await scanTree(root, folder)
  assert.deepEqual(tree.map((n) => n.name), ['B', 'A'])
})

test('paths outside the workspace are refused', () => {
  assert.throws(() => assertInside(root, path.join(root, '..', 'escape.frap.json')))
  assert.doesNotThrow(() => assertInside(root, path.join(root, 'fine.frap.json')))
})

test('names keep spaces but lose characters the filesystem rejects', () => {
  assert.equal(sanitizeName('Get User By Id'), 'Get User By Id')
  assert.equal(sanitizeName('a/b:c*d?'), 'a-b-c-d-')
  assert.equal(sanitizeName('   '), 'Untitled')
})

test('dot-folders and node_modules are skipped when scanning', async () => {
  await fs.mkdir(path.join(root, '.git'), { recursive: true })
  await fs.writeFile(path.join(root, '.git', 'Hidden.frap.json'), '{}', 'utf8')
  await fs.mkdir(path.join(root, 'node_modules'), { recursive: true })
  await fs.writeFile(path.join(root, 'node_modules', 'Dep.frap.json'), '{}', 'utf8')

  const names: string[] = []
  const walk = (nodes: Awaited<ReturnType<typeof scanTree>>): void => {
    for (const node of nodes) {
      names.push(node.name)
      if (node.children) walk(node.children)
    }
  }
  walk(await scanTree(root))
  assert.ok(!names.includes('Hidden'))
  assert.ok(!names.includes('Dep'))
})
