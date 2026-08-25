import type { JSX } from 'react'
import { useStore } from '../store'

const ROWS: Array<[string, string]> = [
  ['frap.request.method', 'Read or set the HTTP method.'],
  ['frap.request.url', 'The fully interpolated URL. Assign to change it.'],
  ['frap.request.headers', 'Plain object of headers.'],
  ['frap.request.setHeader(name, value)', 'Sets a header, replacing any existing one case-insensitively.'],
  ['frap.request.getHeader(name)', 'Reads a header, case-insensitively.'],
  ['frap.request.removeHeader(name)', 'Removes a header.'],
  ['frap.request.body', 'The request body as a string, or null.'],
  ['frap.request.json()', 'Parses the body as JSON.'],
  ['frap.request.setJson(value)', 'Replaces the body with JSON and sets the content type.'],
  ['frap.env.get(key)', 'Reads a value from the active .env file.'],
  ['frap.env.set(key, value)', 'Writes to the active .env file, keeping every comment.'],
  ['frap.env.unset(key)', 'Removes a key from the active .env file.'],
  ['frap.env.all()', 'Every resolved variable as an object.'],
  ['frap.vars.set(key, value)', 'Session-only value. Usable as {{key}}, never written to disk.'],
  ['frap.vars.get(key)', 'Reads a session value.'],
  ['frap.console.log(...)', 'Writes to the Console tab. log / info / warn / error.'],
  ['frap.skipRequest()', 'Pre-request only: stop without sending.'],
  ['frap.response.status', 'Status code.'],
  ['frap.response.headers', 'Response headers, lower-cased keys.'],
  ['frap.response.json()', 'Parses the response body as JSON.'],
  ['frap.response.body', 'Raw response text.'],
  ['frap.response.time', 'Round-trip time in milliseconds.'],
  ['frap.test(name, fn)', 'Records a test. `fn` may be async.'],
  ['frap.expect(value)', 'Assertions, with .not for the inverse.'],
  ['await sleep(ms)', 'Pauses the script.']
]

const MATCHERS =
  'toBe · toEqual · toBeTruthy · toBeFalsy · toBeDefined · toBeUndefined · toBeNull · ' +
  'toContain · toMatch · toHaveProperty · toHaveLength · toBeGreaterThan · ' +
  'toBeGreaterThanOrEqual · toBeLessThan · toBeLessThanOrEqual · toBeOneOf · toBeTypeOf'

export function ScriptingHelp(): JSX.Element {
  const { actions } = useStore()
  const close = (): void => actions.toggle('showHelp', false)

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" style={{ width: 'min(820px, 100%)', height: '80vh' }}>
        <header>
          <h2>Scripting reference</h2>
          <span className="spacer" />
          <button className="ghost" onClick={close}>
            ✕
          </button>
        </header>

        <div className="content">
          <div className="doc">
            <h3>How scripts run</h3>
            <p>
              Pre-request and post-response scripts are ordinary JavaScript. The body is wrapped in
              an async function, so <code>await</code> works at the top level. Scripts get{' '}
              <code>fetch</code>, <code>crypto</code>, <code>Buffer</code>,{' '}
              <code>TextEncoder</code>, <code>URL</code> and the usual built-ins.
            </p>

            <h3>Chaining a login into every other request</h3>
            <pre>{`// Tests tab of your "Login" request
const data = frap.response.json()

frap.test('login succeeded', () => {
  frap.expect(frap.response.status).toBe(200)
  frap.expect(data.token).toBeTruthy()
})

// Written into the active .env file. Comments are kept.
frap.env.set('TOKEN', data.token)
frap.env.set('TOKEN_EXPIRES_AT', String(Date.now() + data.expires * 1000))`}</pre>
            <p>
              Every other request can then use <code>{'{{TOKEN}}'}</code> in a header or in the Auth
              tab, and the value survives restarts because it lives in the file.
            </p>

            <h3>Refreshing a token only when it has expired</h3>
            <pre>{`// Pre-request tab
const expiresAt = Number(frap.env.get('TOKEN_EXPIRES_AT') || 0)

if (Date.now() > expiresAt - 30000) {
  const res = await fetch(frap.env.get('BASE_URL') + '/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh: frap.env.get('REFRESH_TOKEN') })
  })
  const data = await res.json()
  frap.env.set('TOKEN', data.token)
  frap.env.set('TOKEN_EXPIRES_AT', String(Date.now() + data.expires * 1000))
  frap.console.log('token refreshed')
}

frap.request.setHeader('Authorization', 'Bearer ' + frap.env.get('TOKEN'))`}</pre>

            <h3>Environment writes</h3>
            <p>
              <code>frap.env.set</code> targets the environment selected in the toolbar. Writes are
              buffered and flushed once, after the script finishes, so a script that throws
              half-way never leaves the file partly updated. Only the lines you touch are rewritten
              — comments, blank lines, quoting style, <code>export</code> prefixes and CRLF endings
              are all preserved, which keeps the git diff to exactly what changed.
            </p>

            <h3>Variables</h3>
            <p>
              <code>{'{{NAME}}'}</code> works in the URL, params, headers, auth fields and the body.
              Values come from the active .env file, then anything{' '}
              <code>frap.vars.set()</code> has set this session. A few are generated per request:
            </p>
            <pre>{`{{$uuid}}  {{$timestamp}}  {{$isoTimestamp}}  {{$randomInt}}  {{$randomHex}}`}</pre>
            <p>
              .env files may also reference each other with <code>{'${OTHER_VAR}'}</code>, including{' '}
              <code>{'${MISSING:-fallback}'}</code>.
            </p>

            <h3>Assertions</h3>
            <pre>{MATCHERS}</pre>
            <p>
              Each takes <code>.not</code>, for example{' '}
              <code>frap.expect(body.error).not.toBeDefined()</code>. A failing assertion fails that
              one test; the rest still run.
            </p>

            <h3>API</h3>
            <table>
              <tbody>
                {ROWS.map(([name, description]) => (
                  <tr key={name}>
                    <td>{name}</td>
                    <td className="dim">{description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <footer>
          <span className="spacer" />
          <button className="primary" onClick={close}>
            Close
          </button>
        </footer>
      </div>
    </div>
  )
}
