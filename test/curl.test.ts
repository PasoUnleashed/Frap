/**
 * cURL import/export. The import cases are real commands as produced by
 * Chrome, Firefox and people typing them by hand.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCurl, toCurl, tokenizeCurl } from '../src/main/curl.ts'
import { toMutable } from '../src/main/prepare.ts'
import { normalizeRequest } from '../src/main/workspace.ts'
import type { FrapRequest } from '../src/shared/types.ts'

const SCOPE = {
  BASE_URL: 'https://api.example.com',
  TOKEN: 'secret-token-value',
  USER_ID: '42'
}

const exportCurl = (partial: Partial<FrapRequest>, scope = SCOPE): string => {
  const request = normalizeRequest(partial, 'Test')
  const ctx = { root: '/ws', scope, missing: new Set<string>() }
  return toCurl(request, toMutable(request, ctx), {
    followRedirects: true,
    validateTls: true
  })
}

/* ------------------------------------------------------------------ */
/* Export                                                              */
/* ------------------------------------------------------------------ */

test('exports a multi-line command with variables resolved', () => {
  const command = exportCurl({
    method: 'POST',
    url: '{{BASE_URL}}/users/{{USER_ID}}',
    headers: [{ enabled: true, key: 'X-Trace', value: 'on' }],
    auth: { type: 'bearer', token: '{{TOKEN}}' },
    body: { mode: 'json', text: '{"name":"ada"}' }
  })

  assert.equal(
    command,
    [
      'curl \\',
      "  --request POST \\",
      "  --url 'https://api.example.com/users/42' \\",
      "  --header 'X-Trace: on' \\",
      "  --header 'Authorization: Bearer secret-token-value' \\",
      "  --header 'Content-Type: application/json' \\",
      `  --data-raw '{"name":"ada"}' \\`,
      '  --location \\',
      '  --compressed'
    ].join('\n')
  )
})

test('omits --request for a plain GET', () => {
  const command = exportCurl({ method: 'GET', url: '{{BASE_URL}}/ping' })
  assert.ok(!command.includes('--request'))
  assert.ok(command.includes("--url 'https://api.example.com/ping'"))
})

test('disabled rows are left out and params are folded into the URL', () => {
  const command = exportCurl({
    method: 'GET',
    url: '{{BASE_URL}}/search',
    params: [
      { enabled: true, key: 'q', value: 'hello world' },
      { enabled: false, key: 'debug', value: '1' }
    ]
  })
  assert.ok(command.includes('q=hello%20world'))
  assert.ok(!command.includes('debug'))
})

test('single quotes in a body are escaped for the shell', () => {
  const command = exportCurl({
    method: 'POST',
    url: 'https://x.test/',
    body: { mode: 'text', text: "it's fine" }
  })
  assert.ok(command.includes(`--data-raw 'it'\\''s fine'`))
})

test('file bodies stay as @path references instead of being inlined', () => {
  const form = exportCurl({
    method: 'POST',
    url: 'https://x.test/upload',
    body: {
      mode: 'form',
      form: [
        { enabled: true, key: 'note', type: 'text', value: 'hi' },
        { enabled: true, key: 'file', type: 'file', value: 'fixtures/a.png' }
      ]
    }
  })
  assert.ok(form.includes(`--form 'note=hi'`))
  assert.ok(form.includes(`--form 'file=@fixtures/a.png'`))
  // The boundary is generated per send, so no Content-Type is emitted.
  assert.ok(!form.includes('multipart/form-data'))

  const binary = exportCurl({
    method: 'PUT',
    url: 'https://x.test/blob',
    body: { mode: 'binary', filePath: 'fixtures/a.bin' }
  })
  assert.ok(binary.includes(`--data-binary '@fixtures/a.bin'`))
})

/* ------------------------------------------------------------------ */
/* Tokenising                                                          */
/* ------------------------------------------------------------------ */

test('tokenises the three line-continuation styles', () => {
  const bash = tokenizeCurl("curl 'https://x.test' \\\n  -H 'A: 1'")
  const cmd = tokenizeCurl('curl "https://x.test" ^\n  -H "A: 1"')
  const pwsh = tokenizeCurl('curl "https://x.test" `\n  -H "A: 1"')
  for (const tokens of [bash, cmd, pwsh]) {
    assert.deepEqual(tokens, ['curl', 'https://x.test', '-H', 'A: 1'])
  }
})

test('keeps escaped characters inside double quotes', () => {
  assert.deepEqual(tokenizeCurl('curl -d "{\\"a\\":1}" https://x.test'), [
    'curl',
    '-d',
    '{"a":1}',
    'https://x.test'
  ])
})

/* ------------------------------------------------------------------ */
/* Import                                                              */
/* ------------------------------------------------------------------ */

test('imports a Chrome-style copy-as-cURL', () => {
  const { request } = parseCurl(
    `curl 'https://api.example.com/v1/users?page=2&q=ada%20lovelace' \\
  -H 'accept: application/json' \\
  -H 'authorization: Bearer secret-token-value' \\
  -H 'content-length: 0' \\
  --compressed`,
    SCOPE
  )

  assert.equal(request.method, 'GET')
  // The origin matched BASE_URL, so it comes back as a variable.
  assert.equal(request.url, '{{BASE_URL}}/v1/users')
  assert.deepEqual(request.params, [
    { enabled: true, key: 'page', value: '2' },
    { enabled: true, key: 'q', value: 'ada lovelace' }
  ])
  assert.deepEqual(request.auth, { type: 'bearer', token: '{{TOKEN}}' })
  assert.deepEqual(request.headers, [{ enabled: true, key: 'accept', value: 'application/json' }])
})

test('data without -X implies POST, and JSON bodies are pretty-printed', () => {
  const { request } = parseCurl(
    `curl https://x.test/login -H 'Content-Type: application/json' --data '{"user":"ada","pw":"x"}'`
  )
  assert.equal(request.method, 'POST')
  assert.equal(request.body.mode, 'json')
  assert.equal(request.body.text, '{\n  "user": "ada",\n  "pw": "x"\n}')
  // Content-Type is implied by the body mode, so it is not duplicated.
  assert.deepEqual(request.headers, [])
})

test('form-urlencoded bodies become editable rows', () => {
  const { request } = parseCurl(
    `curl -X POST https://x.test/token -H 'content-type: application/x-www-form-urlencoded' -d 'grant_type=client_credentials&scope=read+write'`
  )
  assert.equal(request.body.mode, 'urlencoded')
  assert.deepEqual(request.body.urlencoded, [
    { enabled: true, key: 'grant_type', value: 'client_credentials' },
    { enabled: true, key: 'scope', value: 'read write' }
  ])
})

test('multipart forms and file fields are recognised', () => {
  const { request } = parseCurl(
    `curl https://x.test/upload -F 'note=hello' -F 'photo=@/tmp/a.png;type=image/png'`
  )
  assert.equal(request.method, 'POST')
  assert.equal(request.body.mode, 'form')
  assert.deepEqual(request.body.form, [
    { enabled: true, key: 'note', type: 'text', value: 'hello' },
    { enabled: true, key: 'photo', type: 'file', value: '/tmp/a.png', contentType: 'image/png' }
  ])
})

test('-u and a Basic header both become basic auth', () => {
  const fromFlag = parseCurl('curl -u ada:hunter2 https://x.test/').request
  assert.deepEqual(fromFlag.auth, { type: 'basic', username: 'ada', password: 'hunter2' })

  const encoded = Buffer.from('ada:hunter2').toString('base64')
  const fromHeader = parseCurl(`curl https://x.test/ -H "Authorization: Basic ${encoded}"`).request
  assert.deepEqual(fromHeader.auth, { type: 'basic', username: 'ada', password: 'hunter2' })
})

test('bundled and glued short flags are understood', () => {
  const { request } = parseCurl(`curl -sSL -XDELETE -H'X-A: 1' https://x.test/thing/9`)
  assert.equal(request.method, 'DELETE')
  assert.deepEqual(request.headers, [{ enabled: true, key: 'X-A', value: '1' }])
})

test('-G moves data into the query string', () => {
  const { request } = parseCurl(`curl -G https://x.test/search -d 'q=cats' -d 'page=3'`)
  assert.equal(request.method, 'GET')
  assert.equal(request.body.mode, 'none')
  assert.deepEqual(request.params, [
    { enabled: true, key: 'q', value: 'cats' },
    { enabled: true, key: 'page', value: '3' }
  ])
})

test('-I means HEAD and -T means a file body', () => {
  assert.equal(parseCurl('curl -I https://x.test/').request.method, 'HEAD')
  const upload = parseCurl('curl -T ./report.pdf https://x.test/docs').request
  assert.equal(upload.body.mode, 'binary')
  assert.equal(upload.body.filePath, './report.pdf')
})

test('substitution can be turned off', () => {
  const { request } = parseCurl(
    `curl 'https://api.example.com/ping' -H 'authorization: Bearer secret-token-value'`,
    SCOPE,
    false
  )
  assert.equal(request.url, 'https://api.example.com/ping')
  assert.deepEqual(request.auth, { type: 'bearer', token: 'secret-token-value' })
})

test('a bare URL with no scheme still imports', () => {
  const { request } = parseCurl('curl example.com/health')
  assert.equal(request.url, 'https://example.com/health')
})

test('imported requests get a readable name', () => {
  assert.equal(parseCurl('curl https://x.test/v1/users').request.name, 'GET users')
  // A numeric last segment is an id, so the collection name is used instead.
  assert.equal(parseCurl('curl https://x.test/v1/users/17').request.name, 'GET users')
  assert.equal(parseCurl('curl https://x.test/').request.name, 'GET x.test')
})

test('unsupported options are reported rather than silently dropped', () => {
  const { warnings } = parseCurl('curl -k --proxy http://p:8080 https://x.test/')
  assert.equal(warnings.length, 2)
  assert.ok(warnings.some((w) => w.includes('Verify TLS')))
  assert.ok(warnings.some((w) => w.includes('Proxy')))
})

test('a command with no URL is rejected', () => {
  assert.throws(() => parseCurl('curl -X POST -H "a: b"'), /No URL/)
})

/* ------------------------------------------------------------------ */
/* Round trip                                                          */
/* ------------------------------------------------------------------ */

test('export then import reproduces the request', () => {
  const original = normalizeRequest(
    {
      method: 'PUT',
      url: '{{BASE_URL}}/users/{{USER_ID}}',
      headers: [{ enabled: true, key: 'X-Trace', value: 'on' }],
      auth: { type: 'bearer', token: '{{TOKEN}}' },
      body: { mode: 'json', text: '{"name":"ada"}' }
    },
    'Original'
  )

  const command = toCurl(
    original,
    toMutable(original, { root: '/ws', scope: SCOPE, missing: new Set() }),
    { followRedirects: true, validateTls: true }
  )
  const { request } = parseCurl(command, SCOPE)

  assert.equal(request.method, 'PUT')
  assert.equal(request.url, '{{BASE_URL}}/users/42')
  assert.deepEqual(request.auth, { type: 'bearer', token: '{{TOKEN}}' })
  assert.equal(request.body.mode, 'json')
  assert.deepEqual(JSON.parse(request.body.text!), { name: 'ada' })
  assert.deepEqual(request.headers, [{ enabled: true, key: 'X-Trace', value: 'on' }])
})
