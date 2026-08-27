/**
 * Folder settings: the headers, auth and scripts a folder contributes to
 * every request beneath it.
 *
 * The rule these all check is the same one: the innermost thing runs last and
 * so wins - folder, then nearer folder, then the request.
 */
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import { execute } from '../src/main/execute.ts'
import {
  DEFAULT_SETTINGS,
  createFolder,
  createRequest,
  folderChain,
  isEmptyFolderMeta,
  normalizeFolderMeta,
  normalizeRequest,
  readFolderMeta,
  serializeFolderMeta,
  writeFolderMeta
} from '../src/main/workspace.ts'
import { INHERIT_ALL } from '../src/shared/types.ts'
import type {
  FolderMeta,
  FolderScope,
  FrapRequest,
  InheritFlags
} from '../src/shared/types.ts'

let server: http.Server
let dir = ''
let baseUrl = ''

before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: req.url, headers: req.headers }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frap-folders-'))
  await fs.writeFile(path.join(dir, '.env'), `BASE_URL=${baseUrl}\nTOKEN=env-token\n`, 'utf8')
})

after(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await fs.rm(dir, { recursive: true, force: true })
})

/** A folder scope built from partial settings, the way the tree supplies it. */
const scope = (name: string, meta: Partial<FolderMeta>): FolderScope => ({
  relPath: name,
  name,
  meta: normalizeFolderMeta(meta)
})

/** Sends a request as though it sat inside `folders`, outermost first. */
const runIn = (folders: FolderScope[], partial: Partial<FrapRequest>) =>
  execute({
    root: dir,
    request: normalizeRequest(partial, 'Test'),
    envPath: path.join(dir, '.env'),
    settings: DEFAULT_SETTINGS,
    vars: new Map<string, string>(),
    folders
  })

const sentHeaders = async (
  folders: FolderScope[],
  partial: Partial<FrapRequest>
): Promise<Record<string, string>> => {
  const result = await runIn(folders, { url: '{{BASE_URL}}/echo', method: 'GET', ...partial })
  assert.equal(result.error, undefined)
  return JSON.parse(result.response!.bodyText).headers
}

/* -- headers ------------------------------------------------------- */

test('a folder header reaches every request below it', async () => {
  const headers = await sentHeaders(
    [scope('Api', { headers: [{ enabled: true, key: 'X-Tenant', value: 'acme' }] })],
    {}
  )
  assert.equal(headers['x-tenant'], 'acme')
})

test('a nearer folder overrides a further one, and the request beats both', async () => {
  const headers = await sentHeaders(
    [
      scope('Collection', {
        headers: [
          { enabled: true, key: 'X-Tier', value: 'collection' },
          { enabled: true, key: 'X-From-Root', value: 'yes' }
        ]
      }),
      scope('Api', { headers: [{ enabled: true, key: 'X-Tier', value: 'folder' }] })
    ],
    { headers: [{ enabled: true, key: 'X-Own', value: 'request' }] }
  )
  assert.equal(headers['x-tier'], 'folder')
  assert.equal(headers['x-from-root'], 'yes')
  assert.equal(headers['x-own'], 'request')
})

test('a request header wins over a folder one differing only by case', async () => {
  const headers = await sentHeaders(
    [scope('Api', { headers: [{ enabled: true, key: 'x-tenant', value: 'folder' }] })],
    { headers: [{ enabled: true, key: 'X-Tenant', value: 'request' }] }
  )
  assert.equal(headers['x-tenant'], 'request')
})

test('folder headers resolve {{variables}} like everything else', async () => {
  const headers = await sentHeaders(
    [
      scope('Api', {
        headers: [{ enabled: true, key: 'Authorization', value: 'Bearer {{TOKEN}}' }]
      })
    ],
    {}
  )
  assert.equal(headers.authorization, 'Bearer env-token')
})

test('a disabled folder header is not sent', async () => {
  const headers = await sentHeaders(
    [scope('Api', { headers: [{ enabled: false, key: 'X-Off', value: 'no' }] })],
    {}
  )
  assert.equal(headers['x-off'], undefined)
})

/* -- auth ---------------------------------------------------------- */

test('a request with no auth of its own inherits the folder', async () => {
  const headers = await sentHeaders(
    [scope('Api', { auth: { type: 'bearer', token: 'folder-token' } })],
    {}
  )
  assert.equal(headers.authorization, 'Bearer folder-token')
})

test('the nearest folder with auth wins', async () => {
  const headers = await sentHeaders(
    [
      scope('Collection', { auth: { type: 'bearer', token: 'outer' } }),
      scope('Api', { auth: { type: 'bearer', token: 'inner' } })
    ],
    {}
  )
  assert.equal(headers.authorization, 'Bearer inner')
})

test('a folder that says nothing passes the question further out', async () => {
  const headers = await sentHeaders(
    [scope('Collection', { auth: { type: 'bearer', token: 'outer' } }), scope('Api', {})],
    {}
  )
  assert.equal(headers.authorization, 'Bearer outer')
})

test('a request can opt out of folder auth', async () => {
  const headers = await sentHeaders(
    [scope('Api', { auth: { type: 'bearer', token: 'folder' } })],
    { auth: { type: 'none' } }
  )
  assert.equal(headers.authorization, undefined)
})

test('a folder can opt a whole subtree out of an outer auth', async () => {
  const headers = await sentHeaders(
    [
      scope('Collection', { auth: { type: 'bearer', token: 'outer' } }),
      scope('Public', { auth: { type: 'none' } })
    ],
    {}
  )
  assert.equal(headers.authorization, undefined)
})

test('a request with its own auth ignores every folder', async () => {
  const headers = await sentHeaders(
    [scope('Api', { auth: { type: 'bearer', token: 'folder' } })],
    { auth: { type: 'bearer', token: 'mine' } }
  )
  assert.equal(headers.authorization, 'Bearer mine')
})

test('folder API-key auth is applied like the request kind', async () => {
  const headers = await sentHeaders(
    [scope('Api', { auth: { type: 'apikey', key: 'X-Api-Key', value: '{{TOKEN}}', in: 'header' } })],
    {}
  )
  assert.equal(headers['x-api-key'], 'env-token')
})

/* -- scripts ------------------------------------------------------- */

test('pre-request scripts run outermost first, the request last', async () => {
  const headers = await sentHeaders(
    [
      scope('Collection', {
        scripts: { preRequest: "frap.vars.set('trace', 'root')", postResponse: '' }
      }),
      scope('Api', {
        scripts: {
          preRequest: "frap.vars.set('trace', frap.vars.get('trace') + '>folder')",
          postResponse: ''
        }
      })
    ],
    {
      scripts: {
        preRequest: [
          "frap.vars.set('trace', frap.vars.get('trace') + '>request')",
          "frap.request.setHeader('X-Trace', frap.vars.get('trace'))"
        ].join('\n'),
        postResponse: ''
      }
    }
  )
  assert.equal(headers['x-trace'], 'root>folder>request')
})

test('a folder pre-request script can set a header for everything below', async () => {
  const headers = await sentHeaders(
    [
      scope('Api', {
        scripts: { preRequest: "frap.request.setHeader('X-Signed', 'yes')", postResponse: '' }
      })
    ],
    {}
  )
  assert.equal(headers['x-signed'], 'yes')
})

test('folder tests run alongside the request own tests, folder first', async () => {
  const result = await runIn(
    [
      scope('Api', {
        scripts: {
          preRequest: '',
          postResponse:
            "frap.test('folder: not a server error', () => frap.expect(frap.response.status).toBeLessThan(500))"
        }
      })
    ],
    {
      method: 'GET',
      url: '{{BASE_URL}}/echo',
      scripts: {
        preRequest: '',
        postResponse:
          "frap.test('request: is 200', () => frap.expect(frap.response.status).toBe(200))"
      }
    }
  )
  assert.deepEqual(
    result.tests.map((t) => [t.name, t.passed]),
    [
      ['folder: not a server error', true],
      ['request: is 200', true]
    ]
  )
})

test('each script gets its own sandbox, so declarations cannot collide', async () => {
  const result = await runIn(
    [scope('Api', { scripts: { preRequest: "const shared = 1", postResponse: '' } })],
    {
      method: 'GET',
      url: '{{BASE_URL}}/echo',
      scripts: { preRequest: "const shared = 2", postResponse: '' }
    }
  )
  assert.equal(result.error, undefined)
  assert.equal(result.response?.status, 200)
})

test('a failing folder script says which folder it came from', async () => {
  const result = await runIn(
    [scope('Api', { scripts: { preRequest: 'this is not valid javascript {', postResponse: '' } })],
    { method: 'GET', url: '{{BASE_URL}}/echo' }
  )
  assert.equal(result.scriptError, 'pre')
  assert.match(result.error!, /^Api folder: /)
  assert.equal(result.response, undefined)
})

test('a folder script can skip the request entirely', async () => {
  const result = await runIn(
    [scope('Api', { scripts: { preRequest: 'frap.skipRequest()', postResponse: '' } })],
    { method: 'GET', url: '{{BASE_URL}}/echo' }
  )
  assert.equal(result.skipped, true)
  assert.equal(result.response, undefined)
})

/* -- on disk ------------------------------------------------------- */

test('settings that say nothing leave no file behind', async () => {
  const folder = await createFolder(dir, dir, 'Empty Settings')
  assert.equal(isEmptyFolderMeta(normalizeFolderMeta({})), true)
  await writeFolderMeta(folder, normalizeFolderMeta({}))
  await assert.rejects(() => fs.access(path.join(folder, '_folder.frap.json')))
})

test('clearing every setting removes the file again', async () => {
  const folder = await createFolder(dir, dir, 'Cleared')
  const file = path.join(folder, '_folder.frap.json')
  await writeFolderMeta(
    folder,
    normalizeFolderMeta({ headers: [{ enabled: true, key: 'X-A', value: '1' }] })
  )
  await fs.access(file)
  await writeFolderMeta(folder, normalizeFolderMeta({}))
  await assert.rejects(() => fs.access(file))
})

test('folder settings round-trip through the file', async () => {
  const folder = await createFolder(dir, dir, 'Round Trip')
  const meta = normalizeFolderMeta({
    order: 2,
    headers: [{ enabled: true, key: 'X-Tenant', value: 'acme' }],
    auth: { type: 'bearer', token: '{{TOKEN}}' },
    scripts: { preRequest: "frap.console.log('hi')", postResponse: '' },
    docs: 'Everything under here is tenant-scoped.'
  })
  await writeFolderMeta(folder, meta)
  assert.deepEqual(await readFolderMeta(folder), meta)
})

test('the folder file has a fixed key order and drops empty sections', async () => {
  const text = serializeFolderMeta(
    normalizeFolderMeta({ order: 1, headers: [{ enabled: true, key: 'A', value: 'b' }] })
  )
  assert.deepEqual(Object.keys(JSON.parse(text)), ['frap', 'order', 'headers'])
  assert.ok(!text.includes('"auth"'))
  assert.ok(!text.includes('"scripts"'))
  assert.ok(text.endsWith('}\n'))
})

test('the chain runs from the workspace root down to the request', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frap-chain-'))
  try {
    const api = await createFolder(root, root, 'Api')
    const users = await createFolder(root, api, 'Users')
    await createRequest(root, users, 'Get user')

    // The root counts as a folder: that is how collection-wide settings work.
    await writeFolderMeta(root, normalizeFolderMeta({ headers: [{ enabled: true, key: 'A', value: '1' }] }))
    await writeFolderMeta(api, normalizeFolderMeta({ headers: [{ enabled: true, key: 'B', value: '2' }] }))

    const chain = await folderChain(root, users)
    assert.deepEqual(
      chain.map((f) => f.name),
      ['Collection', 'Api']
    )
    // `Users` has no settings file, so it contributes nothing and is absent.
    assert.deepEqual(chain[0].meta.headers[0], { enabled: true, key: 'A', value: '1' })
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('the chain refuses a path outside the workspace', async () => {
  await assert.rejects(() => folderChain(dir, path.join(dir, '..', 'elsewhere')))
})

/* -- unsaved settings ---------------------------------------------- */

test('an unsaved override beats what is on disk', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frap-override-'))
  try {
    const api = await createFolder(root, root, 'Api')
    await writeFolderMeta(
      api,
      normalizeFolderMeta({ headers: [{ enabled: true, key: 'X-Tier', value: 'saved' }] })
    )

    const overrides = new Map([
      [api, normalizeFolderMeta({ headers: [{ enabled: true, key: 'X-Tier', value: 'editing' }] })]
    ])
    const chain = await folderChain(root, api, overrides)
    assert.equal(chain[0].meta.headers[0].value, 'editing')

    // Without the override, the file still wins.
    const fromDisk = await folderChain(root, api)
    assert.equal(fromDisk[0].meta.headers[0].value, 'saved')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('an override introduces a folder that has no file yet', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frap-override-'))
  try {
    const api = await createFolder(root, root, 'Api')
    // Nothing on disk, so the folder contributes nothing at all...
    assert.deepEqual(await folderChain(root, api), [])

    // ...until its settings tab is opened and something typed into it.
    const overrides = new Map([
      [api, normalizeFolderMeta({ auth: { type: 'bearer', token: 'typed-just-now' } })]
    ])
    const chain = await folderChain(root, api, overrides)
    assert.equal(chain.length, 1)
    assert.equal(chain[0].meta.auth.token, 'typed-just-now')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

/* -- blocking inheritance ------------------------------------------ */

/** A folder that blocks one property for everything at or below it. */
const barrier = (name: string, meta: Partial<FolderMeta>, blocked: keyof InheritFlags) =>
  scope(name, { ...meta, inherit: { ...INHERIT_ALL, [blocked]: false } })

test('a request can refuse folder headers and keep its own', async () => {
  const headers = await sentHeaders(
    [scope('Api', { headers: [{ enabled: true, key: 'X-Tier', value: 'folder' }] })],
    {
      headers: [{ enabled: true, key: 'X-Own', value: 'mine' }],
      inherit: { ...INHERIT_ALL, headers: false }
    }
  )
  assert.equal(headers['x-tier'], undefined)
  assert.equal(headers['x-own'], 'mine')
})

test('a folder blocking headers hides the ones above it, not its own', async () => {
  const headers = await sentHeaders(
    [
      scope('Collection', { headers: [{ enabled: true, key: 'X-Root', value: 'yes' }] }),
      barrier('Api', { headers: [{ enabled: true, key: 'X-Api', value: 'yes' }] }, 'headers')
    ],
    {}
  )
  assert.equal(headers['x-root'], undefined)
  assert.equal(headers['x-api'], 'yes')
})

test('blocking one property leaves the others inherited', async () => {
  const headers = await sentHeaders(
    [
      scope('Collection', {
        headers: [{ enabled: true, key: 'X-Root', value: 'yes' }],
        auth: { type: 'bearer', token: 'root-token' }
      }),
      barrier('Api', {}, 'headers')
    ],
    {}
  )
  assert.equal(headers['x-root'], undefined)
  assert.equal(headers.authorization, 'Bearer root-token')
})

test('a request can refuse folder auth', async () => {
  const headers = await sentHeaders(
    [scope('Api', { auth: { type: 'bearer', token: 'folder' } })],
    { inherit: { ...INHERIT_ALL, auth: false } }
  )
  assert.equal(headers.authorization, undefined)
})

test('a folder blocking auth still provides its own to its subtree', async () => {
  const headers = await sentHeaders(
    [
      scope('Collection', { auth: { type: 'bearer', token: 'root' } }),
      barrier('Api', { auth: { type: 'bearer', token: 'api' } }, 'auth')
    ],
    {}
  )
  assert.equal(headers.authorization, 'Bearer api')
})

test('a folder blocking auth with none of its own leaves no auth', async () => {
  const headers = await sentHeaders(
    [scope('Collection', { auth: { type: 'bearer', token: 'root' } }), barrier('Api', {}, 'auth')],
    {}
  )
  assert.equal(headers.authorization, undefined)
})

test('a request can refuse folder pre-request scripts', async () => {
  const headers = await sentHeaders(
    [
      scope('Api', {
        scripts: { preRequest: "frap.request.setHeader('X-Folder', 'ran')", postResponse: '' }
      })
    ],
    {
      inherit: { ...INHERIT_ALL, preRequest: false },
      scripts: { preRequest: "frap.request.setHeader('X-Own', 'ran')", postResponse: '' }
    }
  )
  assert.equal(headers['x-folder'], undefined)
  assert.equal(headers['x-own'], 'ran')
})

test('a folder blocking pre-request scripts stops the ones above it', async () => {
  const headers = await sentHeaders(
    [
      scope('Collection', {
        scripts: { preRequest: "frap.request.setHeader('X-Root', 'ran')", postResponse: '' }
      }),
      barrier(
        'Api',
        { scripts: { preRequest: "frap.request.setHeader('X-Api', 'ran')", postResponse: '' } },
        'preRequest'
      )
    ],
    {}
  )
  assert.equal(headers['x-root'], undefined)
  assert.equal(headers['x-api'], 'ran')
})

test('a request can refuse folder tests', async () => {
  const result = await runIn(
    [
      scope('Api', {
        scripts: {
          preRequest: '',
          postResponse: "frap.test('folder test', () => frap.expect(1).toBe(1))"
        }
      })
    ],
    {
      method: 'GET',
      url: '{{BASE_URL}}/echo',
      inherit: { ...INHERIT_ALL, postResponse: false },
      scripts: {
        preRequest: '',
        postResponse: "frap.test('own test', () => frap.expect(1).toBe(1))"
      }
    }
  )
  assert.deepEqual(
    result.tests.map((t) => t.name),
    ['own test']
  )
})

test('blocking pre-request scripts does not block tests', async () => {
  const result = await runIn(
    [
      scope('Api', {
        scripts: {
          preRequest: "frap.request.setHeader('X-Folder', 'ran')",
          postResponse: "frap.test('folder test', () => frap.expect(1).toBe(1))"
        }
      })
    ],
    {
      method: 'GET',
      url: '{{BASE_URL}}/echo',
      inherit: { ...INHERIT_ALL, preRequest: false }
    }
  )
  const headers = JSON.parse(result.response!.bodyText).headers
  assert.equal(headers['x-folder'], undefined)
  assert.deepEqual(
    result.tests.map((t) => t.name),
    ['folder test']
  )
})

test('the flags round-trip, and the default is not written to disk', async () => {
  const folder = await createFolder(dir, dir, 'Blocking')
  const meta = normalizeFolderMeta({
    headers: [{ enabled: true, key: 'X-A', value: '1' }],
    inherit: { ...INHERIT_ALL, headers: false }
  })
  await writeFolderMeta(folder, meta)
  assert.deepEqual(await readFolderMeta(folder), meta)
  assert.ok(serializeFolderMeta(meta).includes('"inherit"'))

  // Inheriting everything is the default, so it leaves no trace.
  const plain = normalizeFolderMeta({ headers: [{ enabled: true, key: 'X-A', value: '1' }] })
  assert.ok(!serializeFolderMeta(plain).includes('"inherit"'))
})

test('a folder that only blocks inheritance is still worth a file', () => {
  const blocking = normalizeFolderMeta({ inherit: { ...INHERIT_ALL, auth: false } })
  assert.equal(isEmptyFolderMeta(blocking), false)
  assert.equal(isEmptyFolderMeta(normalizeFolderMeta({})), true)
})
