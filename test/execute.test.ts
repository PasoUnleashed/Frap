/**
 * End-to-end tests for the request pipeline: variable resolution, scripts,
 * the HTTP engine, assertions and environment write-back.
 */
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import { execute } from '../src/main/execute.ts'
import { normalizeRequest, DEFAULT_SETTINGS } from '../src/main/workspace.ts'
import type { FrapRequest } from '../src/shared/types.ts'

let server: http.Server
let baseUrl = ''
let dir = ''

const ENV_SOURCE = [
  '# Local development',
  '# Do not commit real secrets here.',
  '',
  '# Where the API lives',
  'BASE_URL=__BASE__',
  'USER_ID=42',
  'TOKEN=stale-token   # refreshed by the login request',
  ''
].join('\n')

before(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      if (req.url === '/login') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ token: 'fresh-token-123', expires: 3600 }))
        return
      }
      if (req.url === '/boom') {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'kaboom' }))
        return
      }
      if (req.url === '/redirect') {
        res.writeHead(302, { location: '/echo?after=redirect' })
        res.end()
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body
        })
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const address = server.address() as { port: number }
  baseUrl = `http://127.0.0.1:${address.port}`

  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frap-test-'))
  await fs.writeFile(path.join(dir, '.env'), ENV_SOURCE.replace('__BASE__', baseUrl), 'utf8')
})

after(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await fs.rm(dir, { recursive: true, force: true })
})

const run = (
  partial: Partial<FrapRequest>,
  vars = new Map<string, string>(),
  userAgent?: string
) =>
  execute({
    root: dir,
    request: normalizeRequest(partial, 'Test'),
    envPath: path.join(dir, '.env'),
    settings: DEFAULT_SETTINGS,
    vars,
    userAgent
  })

test('interpolates {{VARS}} from the .env file', async () => {
  const result = await run({
    method: 'GET',
    url: '{{BASE_URL}}/echo/{{USER_ID}}',
    headers: [{ enabled: true, key: 'X-Token', value: '{{TOKEN}}' }]
  })
  assert.equal(result.error, undefined)
  assert.equal(result.response?.status, 200)
  const echoed = JSON.parse(result.response!.bodyText)
  assert.equal(echoed.url, '/echo/42')
  assert.equal(echoed.headers['x-token'], 'stale-token')
})

test('query params and auth are applied', async () => {
  const result = await run({
    method: 'GET',
    url: '{{BASE_URL}}/echo',
    params: [
      { enabled: true, key: 'page', value: '2' },
      { enabled: false, key: 'skipped', value: 'no' }
    ],
    auth: { type: 'bearer', token: '{{TOKEN}}' }
  })
  const echoed = JSON.parse(result.response!.bodyText)
  assert.equal(echoed.url, '/echo?page=2')
  assert.equal(echoed.headers.authorization, 'Bearer stale-token')
})

test('sends a JSON body with the right content type', async () => {
  const result = await run({
    method: 'POST',
    url: '{{BASE_URL}}/echo',
    body: { mode: 'json', text: '{"id": {{USER_ID}}}' }
  })
  const echoed = JSON.parse(result.response!.bodyText)
  assert.equal(echoed.method, 'POST')
  assert.equal(echoed.headers['content-type'], 'application/json')
  assert.deepEqual(JSON.parse(echoed.body), { id: 42 })
})

test('pre-request scripts can rewrite the request', async () => {
  const result = await run({
    method: 'GET',
    url: '{{BASE_URL}}/echo',
    scripts: {
      preRequest: [
        "frap.request.setHeader('X-Signature', 'sig-' + frap.env.get('USER_ID'))",
        "frap.request.url += '?from=script'",
        "frap.console.log('signing as', frap.env.get('USER_ID'))"
      ].join('\n'),
      postResponse: ''
    }
  })
  assert.equal(result.error, undefined)
  const echoed = JSON.parse(result.response!.bodyText)
  assert.equal(echoed.headers['x-signature'], 'sig-42')
  assert.equal(echoed.url, '/echo?from=script')
  assert.equal(result.logs[0].message, 'signing as 42')
})

test('post-response tests pass and fail independently', async () => {
  const result = await run({
    method: 'GET',
    url: '{{BASE_URL}}/echo',
    scripts: {
      preRequest: '',
      postResponse: [
        "frap.test('status is 200', () => frap.expect(frap.response.status).toBe(200))",
        "frap.test('is json', () => frap.expect(frap.response.headers['content-type']).toContain('application/json'))",
        "frap.test('this one fails', () => frap.expect(frap.response.status).toBe(404))"
      ].join('\n')
    }
  })
  assert.equal(result.tests.length, 3)
  assert.deepEqual(
    result.tests.map((t) => t.passed),
    [true, true, false]
  )
  assert.match(result.tests[2].error!, /expected 200 to be 404/)
  // A failing assertion is a failing test, not a broken script.
  assert.equal(result.error, undefined)
})

test('scripts write to the .env file and keep every comment', async () => {
  const before = await fs.readFile(path.join(dir, '.env'), 'utf8')
  assert.ok(before.includes('# Do not commit real secrets here.'))

  const result = await run({
    method: 'POST',
    url: '{{BASE_URL}}/login',
    scripts: {
      preRequest: '',
      postResponse: [
        'const data = frap.response.json()',
        "frap.env.set('TOKEN', data.token)",
        "frap.env.set('TOKEN_EXPIRES', String(data.expires))",
        "frap.test('got a token', () => frap.expect(data.token).toBeTruthy())"
      ].join('\n')
    }
  })

  assert.equal(result.error, undefined)
  assert.equal(result.tests[0].passed, true)
  assert.deepEqual(result.writes, [
    { store: 'environment', target: '.env', key: 'TOKEN', value: 'fresh-token-123' },
    { store: 'environment', target: '.env', key: 'TOKEN_EXPIRES', value: '3600' }
  ])

  const after = await fs.readFile(path.join(dir, '.env'), 'utf8')
  assert.ok(after.includes('# Local development'))
  assert.ok(after.includes('# Do not commit real secrets here.'))
  assert.ok(after.includes('# Where the API lives'))
  // Value replaced in place, inline comment untouched.
  assert.match(after, /^TOKEN=fresh-token-123\s+# refreshed by the login request$/m)
  // New key appended.
  assert.match(after, /^TOKEN_EXPIRES=3600$/m)
  // Untouched keys are byte-identical.
  assert.match(after, /^USER_ID=42$/m)
})

test('the next request sees the value the previous one wrote', async () => {
  const result = await run({
    method: 'GET',
    url: '{{BASE_URL}}/echo',
    headers: [{ enabled: true, key: 'Authorization', value: 'Bearer {{TOKEN}}' }]
  })
  const echoed = JSON.parse(result.response!.bodyText)
  assert.equal(echoed.headers.authorization, 'Bearer fresh-token-123')
})

test('session variables chain without touching disk', async () => {
  const vars = new Map<string, string>()
  await run(
    {
      method: 'GET',
      url: '{{BASE_URL}}/echo',
      scripts: { preRequest: '', postResponse: "frap.vars.set('requestId', 'abc-123')" }
    },
    vars
  )
  assert.equal(vars.get('requestId'), 'abc-123')

  const second = await run(
    {
      method: 'GET',
      url: '{{BASE_URL}}/echo',
      headers: [{ enabled: true, key: 'X-Request-Id', value: '{{requestId}}' }]
    },
    vars
  )
  const echoed = JSON.parse(second.response!.bodyText)
  assert.equal(echoed.headers['x-request-id'], 'abc-123')

  const envText = await fs.readFile(path.join(dir, '.env'), 'utf8')
  assert.ok(!envText.includes('requestId'))
})

test('await works inside scripts', async () => {
  const result = await run({
    method: 'GET',
    url: '{{BASE_URL}}/echo',
    scripts: {
      preRequest: [
        `const res = await fetch(frap.env.get('BASE_URL') + '/login', { method: 'POST' })`,
        'const data = await res.json()',
        "frap.request.setHeader('Authorization', 'Bearer ' + data.token)"
      ].join('\n'),
      postResponse: ''
    }
  })
  assert.equal(result.error, undefined)
  const echoed = JSON.parse(result.response!.bodyText)
  assert.equal(echoed.headers.authorization, 'Bearer fresh-token-123')
})

test('a broken script is reported as a script error, not a request error', async () => {
  const result = await run({
    method: 'GET',
    url: '{{BASE_URL}}/echo',
    scripts: { preRequest: 'this is not valid javascript {', postResponse: '' }
  })
  assert.equal(result.scriptError, 'pre')
  assert.ok(result.error)
  assert.equal(result.response, undefined)
})

test('skipRequest stops before anything is sent', async () => {
  const result = await run({
    method: 'GET',
    url: '{{BASE_URL}}/echo',
    scripts: { preRequest: 'frap.skipRequest()', postResponse: '' }
  })
  assert.equal(result.skipped, true)
  assert.equal(result.response, undefined)
  assert.equal(result.error, undefined)
})

test('redirects are followed and recorded', async () => {
  const result = await run({ method: 'GET', url: '{{BASE_URL}}/redirect' })
  assert.equal(result.response?.status, 200)
  assert.equal(result.response?.redirects.length, 1)
  assert.match(result.response!.finalUrl, /\/echo\?after=redirect$/)
})

test('an unreachable host produces an error, not a crash', async () => {
  const result = await run({ method: 'GET', url: 'http://127.0.0.1:1/nope' })
  assert.ok(result.error)
  assert.equal(result.response, undefined)
})

test('unresolved variables are surfaced as a warning', async () => {
  const result = await run({ method: 'GET', url: '{{BASE_URL}}/echo/{{NOT_SET}}' })
  assert.ok(result.logs.some((l) => l.level === 'warn' && l.message.includes('{{NOT_SET}}')))
})

test('the caller supplies the User-Agent, so it cannot drift from the app', async () => {
  const result = await run(
    { method: 'GET', url: '{{BASE_URL}}/echo' },
    new Map(),
    'Frap/9.9.9'
  )
  const echoed = JSON.parse(result.response!.bodyText)
  assert.equal(echoed.headers['user-agent'], 'Frap/9.9.9')
})

test('a request setting its own User-Agent keeps it', async () => {
  const result = await run(
    {
      method: 'GET',
      url: '{{BASE_URL}}/echo',
      headers: [{ enabled: true, key: 'User-Agent', value: 'mine/1.0' }]
    },
    new Map(),
    'Frap/9.9.9'
  )
  const echoed = JSON.parse(result.response!.bodyText)
  assert.equal(echoed.headers['user-agent'], 'mine/1.0')
})

test('timings are recorded', async () => {
  const result = await run({ method: 'GET', url: '{{BASE_URL}}/echo' })
  assert.ok(result.response!.timings.totalMs >= 0)
  assert.ok(result.response!.timings.firstByteMs !== undefined)
})
