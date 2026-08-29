/**
 * The three value stores and how `{{name}}` resolves across them.
 *
 * The rule: session beats user, user beats the environment file. Scripts can
 * write to any of the three; session lives in memory, user is persisted by
 * the caller, and the environment is the .env file.
 */
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { promises as fs } from 'node:fs'
import { execute } from '../src/main/execute.ts'
import { DEFAULT_SETTINGS, normalizeRequest } from '../src/main/workspace.ts'
import type { ExecResult, FrapRequest } from '../src/shared/types.ts'

let server: http.Server
let dir = ''
let baseUrl = ''

const ENV_SOURCE = ['# Local', 'BASE_URL=__BASE__', 'WHO=from-env', 'ONLY_ENV=env-only', ''].join(
  '\n'
)

before(async () => {
  server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ url: req.url, headers: req.headers }))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`

  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'frap-stores-'))
  await fs.writeFile(path.join(dir, '.env'), ENV_SOURCE.replace('__BASE__', baseUrl), 'utf8')
})

after(async () => {
  await new Promise<void>((r) => server.close(() => r()))
  await fs.rm(dir, { recursive: true, force: true })
})

interface RunOptions {
  session?: Map<string, string>
  user?: Map<string, string>
}

const run = (partial: Partial<FrapRequest>, opts: RunOptions = {}): Promise<ExecResult> =>
  execute({
    root: dir,
    request: normalizeRequest(partial, 'Test'),
    envPath: path.join(dir, '.env'),
    settings: DEFAULT_SETTINGS,
    vars: opts.session ?? new Map(),
    user: opts.user ?? new Map()
  })

/** Sends a request whose header echoes one variable, and returns its value. */
const resolve = async (name: string, opts: RunOptions = {}): Promise<string | undefined> => {
  const result = await run(
    {
      method: 'GET',
      url: '{{BASE_URL}}/echo',
      headers: [{ enabled: true, key: 'X-Probe', value: `{{${name}}}` }]
    },
    opts
  )
  assert.equal(result.error, undefined)
  return JSON.parse(result.response!.bodyText).headers['x-probe']
}

/* -- precedence ----------------------------------------------------- */

test('a value only in the environment resolves from there', async () => {
  assert.equal(await resolve('ONLY_ENV'), 'env-only')
})

test('the user store beats the environment file', async () => {
  assert.equal(await resolve('WHO', { user: new Map([['WHO', 'from-user']]) }), 'from-user')
})

test('the session store beats the user store', async () => {
  assert.equal(
    await resolve('WHO', {
      user: new Map([['WHO', 'from-user']]),
      session: new Map([['WHO', 'from-session']])
    }),
    'from-session'
  )
})

test('session beats the environment with no user value in between', async () => {
  assert.equal(await resolve('WHO', { session: new Map([['WHO', 'from-session']]) }), 'from-session')
})

test('a value only in the user store resolves', async () => {
  assert.equal(await resolve('ONLY_USER', { user: new Map([['ONLY_USER', 'yes']]) }), 'yes')
})

/* -- scripts writing ------------------------------------------------ */

test('a script can read all three stores', async () => {
  const result = await run(
    {
      method: 'GET',
      url: '{{BASE_URL}}/echo',
      scripts: {
        preRequest: [
          "frap.request.setHeader('X-Env', frap.env.get('ONLY_ENV'))",
          "frap.request.setHeader('X-User', frap.user.get('U'))",
          "frap.request.setHeader('X-Session', frap.session.get('S'))"
        ].join('\n'),
        postResponse: ''
      }
    },
    { user: new Map([['U', 'u-value']]), session: new Map([['S', 's-value']]) }
  )
  const headers = JSON.parse(result.response!.bodyText).headers
  assert.equal(headers['x-env'], 'env-only')
  assert.equal(headers['x-user'], 'u-value')
  assert.equal(headers['x-session'], 's-value')
})

test('a session write is visible as {{name}} in the same send', async () => {
  const result = await run({
    method: 'GET',
    url: '{{BASE_URL}}/echo',
    headers: [{ enabled: true, key: 'X-Probe', value: '{{MADE_UP}}' }],
    scripts: { preRequest: "frap.session.set('MADE_UP', 'now')", postResponse: '' }
  })
  assert.equal(JSON.parse(result.response!.bodyText).headers['x-probe'], 'now')
})

test('a user write is visible as {{name}} in the same send', async () => {
  const result = await run({
    method: 'GET',
    url: '{{BASE_URL}}/echo',
    headers: [{ enabled: true, key: 'X-Probe', value: '{{MADE_UP}}' }],
    scripts: { preRequest: "frap.user.set('MADE_UP', 'now')", postResponse: '' }
  })
  assert.equal(JSON.parse(result.response!.bodyText).headers['x-probe'], 'now')
})

test('a user write does not shadow a session value of the same name', async () => {
  const result = await run(
    {
      method: 'GET',
      url: '{{BASE_URL}}/echo',
      headers: [{ enabled: true, key: 'X-Probe', value: '{{WHO}}' }],
      scripts: { preRequest: "frap.user.set('WHO', 'user-wrote-this')", postResponse: '' }
    },
    { session: new Map([['WHO', 'session-wins']]) }
  )
  assert.equal(JSON.parse(result.response!.bodyText).headers['x-probe'], 'session-wins')
})

test('removing a session value falls back to the user store', async () => {
  const result = await run(
    {
      method: 'GET',
      url: '{{BASE_URL}}/echo',
      scripts: {
        preRequest: [
          "frap.session.unset('WHO')",
          // `all()` is the merged view, so this is what {{WHO}} would resolve to.
          "frap.request.setHeader('X-Probe', frap.env.all().WHO)"
        ].join('\n'),
        postResponse: ''
      }
    },
    { session: new Map([['WHO', 'session']]), user: new Map([['WHO', 'user']]) }
  )
  assert.equal(JSON.parse(result.response!.bodyText).headers['x-probe'], 'user')
})

test('removing the last value for a name leaves it unresolved', async () => {
  const result = await run(
    {
      method: 'GET',
      url: '{{BASE_URL}}/echo',
      scripts: {
        preRequest: [
          "frap.session.unset('WHO')",
          "frap.request.setHeader('X-Probe', String(frap.env.all().WHO))"
        ].join('\n'),
        postResponse: ''
      }
    },
    { session: new Map([['WHO', 'session']]) }
  )
  // The .env file still defines WHO, so it falls all the way back to that.
  assert.equal(JSON.parse(result.response!.bodyText).headers['x-probe'], 'from-env')
})

/**
 * Variables resolve once before the pre-request scripts, so a script sees a
 * resolved url and headers rather than raw braces. Anything still unresolved
 * gets a second pass afterwards, which is what makes "fetch a token, then use
 * {{TOKEN}}" work. A script that wants to change an already-resolved value
 * edits the request directly instead.
 */
test('an already-resolved variable is not re-resolved after the script', async () => {
  const result = await run(
    {
      method: 'GET',
      url: '{{BASE_URL}}/echo',
      headers: [{ enabled: true, key: 'X-Probe', value: '{{WHO}}' }],
      scripts: { preRequest: "frap.session.set('WHO', 'changed-too-late')", postResponse: '' }
    },
    { session: new Map([['WHO', 'resolved-first']]) }
  )
  assert.equal(JSON.parse(result.response!.bodyText).headers['x-probe'], 'resolved-first')
})

test('user writes are reported, not written by execute itself', async () => {
  const user = new Map<string, string>()
  const result = await run(
    {
      method: 'GET',
      url: '{{BASE_URL}}/echo',
      scripts: {
        preRequest: '',
        postResponse: ["frap.user.set('TOKEN', 'abc')", "frap.user.unset('OLD')"].join('\n')
      }
    },
    { user }
  )
  assert.deepEqual(result.writes, [
    { store: 'user', target: 'user store', key: 'TOKEN', value: 'abc' },
    { store: 'user', target: 'user store', key: 'OLD', value: null }
  ])
  // The in-memory map is updated so later scripts in the same send see it;
  // persisting is the caller's job.
  assert.equal(user.get('TOKEN'), 'abc')
})

test('session writes persist across sends within the run', async () => {
  const session = new Map<string, string>()
  await run(
    {
      method: 'GET',
      url: '{{BASE_URL}}/echo',
      scripts: { preRequest: '', postResponse: "frap.session.set('CHAIN', 'first')" }
    },
    { session }
  )
  assert.equal(session.get('CHAIN'), 'first')
  assert.equal(await resolve('CHAIN', { session }), 'first')
})

test('session writes are not reported as writes to persist', async () => {
  const result = await run({
    method: 'GET',
    url: '{{BASE_URL}}/echo',
    scripts: { preRequest: '', postResponse: "frap.session.set('EPHEMERAL', 'x')" }
  })
  assert.deepEqual(result.writes, [])
})

test('frap.vars still works as the session store', async () => {
  const session = new Map<string, string>()
  await run(
    {
      method: 'GET',
      url: '{{BASE_URL}}/echo',
      scripts: { preRequest: '', postResponse: "frap.vars.set('LEGACY', 'ok')" }
    },
    { session }
  )
  assert.equal(session.get('LEGACY'), 'ok')
})

test('the three stores are separate: writing one leaves the others alone', async () => {
  const session = new Map<string, string>()
  const user = new Map<string, string>()
  const result = await run(
    {
      method: 'GET',
      url: '{{BASE_URL}}/echo',
      scripts: {
        preRequest: '',
        postResponse: [
          "frap.session.set('S_ONLY', '1')",
          "frap.user.set('U_ONLY', '2')"
        ].join('\n')
      }
    },
    { session, user }
  )
  assert.deepEqual([...session.keys()], ['S_ONLY'])
  assert.deepEqual([...user.keys()], ['U_ONLY'])
  assert.deepEqual(
    result.writes.map((w) => [w.store, w.key]),
    [['user', 'U_ONLY']]
  )
  // The .env file was not touched.
  const envText = await fs.readFile(path.join(dir, '.env'), 'utf8')
  assert.ok(!envText.includes('S_ONLY'))
  assert.ok(!envText.includes('U_ONLY'))
})
