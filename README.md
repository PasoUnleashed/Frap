# Frap

An API client whose collections are just files.

Postman-style workflow, but the collection is a folder of plain JSON — one file
per request — and environments are ordinary `.env` files you point at. Commit
them, branch them, review them in a pull request, and merge them without a
proprietary sync service in the middle.

Ships as a single portable `.exe`.

---

## Why the file layout matters

A collection is a folder:

```
my-api/
  frap.workspace.json          shared settings + which .env files exist
  .env                         an environment
  .env.staging                 another one
  Auth/
    Log in.frap.json           one request = one file
    Whoami.frap.json
  Users/
    _folder.frap.json          optional: just sort order for the folder
    Get user.frap.json
```

Two people editing different requests touch different files, so git merges them
with no conflict at all. A conflict inside one request is a small, readable
diff rather than a wall of minified JSON.

Files are written with a fixed key order, empty sections omitted, and a
trailing newline. Saving a request you did not change writes nothing, so the
working tree stays clean.

The file name is the source of truth for the request name — rename the file in
your editor or in git and Frap follows.

## Environments are `.env` files

No proprietary environment format, no separate secrets store. Point Frap at the
same `.env` your application already reads.

Use values anywhere with `{{NAME}}` — in the URL, query params, headers, auth
fields and the body.

**Writes preserve everything else in the file.** Given:

```env
# Local development environment
# ------------------------------

# The API under test
BASE_URL=https://api.example.com

# Filled in by the Log in request
TOKEN=stale       # rotated automatically
USER_ID=42
```

a script calling `frap.env.set('TOKEN', 'fresh-abc')` produces a one-line diff:

```diff
-TOKEN=stale       # rotated automatically
+TOKEN=fresh-abc       # rotated automatically
```

Comments, blank lines, ordering, quote style, `export ` prefixes, indentation,
CRLF vs LF and a BOM all survive untouched. Untouched lines are written back
byte for byte — Frap never re-serialises a line it did not change.

`.env` files may also reference each other with `${OTHER}` and
`${MISSING:-fallback}`.

## Scripts

Every request has a **Pre-request** and a **Tests** (post-response) script, both
plain JavaScript. The body is wrapped in an async function, so top-level
`await` works.

```js
// Tests tab of your Login request
const data = frap.response.json()

frap.test('login succeeded', () => {
  frap.expect(frap.response.status).toBe(200)
  frap.expect(data.token).toBeTruthy()
})

// Straight into the active .env file, comments intact.
frap.env.set('TOKEN', data.token)
frap.env.set('TOKEN_EXPIRES_AT', String(Date.now() + data.expires * 1000))
```

```js
// Pre-request tab of everything else
const expiresAt = Number(frap.env.get('TOKEN_EXPIRES_AT') || 0)

if (Date.now() > expiresAt - 30_000) {
  const res = await fetch(frap.env.get('BASE_URL') + '/auth/refresh', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refresh: frap.env.get('REFRESH_TOKEN') })
  })
  const data = await res.json()
  frap.env.set('TOKEN', data.token)
  frap.console.log('token refreshed')
}

frap.request.setHeader('Authorization', 'Bearer ' + frap.env.get('TOKEN'))
```

Environment writes are buffered and flushed once, after the script finishes, so
a script that throws half-way never leaves the file partly updated.

### API

| | |
|---|---|
| `frap.request` | `.method` `.url` `.headers` `.body`, plus `setHeader` / `getHeader` / `removeHeader` / `json()` / `setJson()` |
| `frap.response` | `.status` `.headers` `.body` `.time` `.size`, plus `json()` / `header(name)` |
| `frap.env` | `get` `set` `unset` `has` `all` — `set`/`unset` write to the active `.env` |
| `frap.vars` | same shape, but session-only; usable as `{{name}}`, never written to disk |
| `frap.test(name, fn)` | records a test; `fn` may be async |
| `frap.expect(value)` | `toBe` `toEqual` `toBeTruthy` `toBeFalsy` `toBeDefined` `toBeUndefined` `toBeNull` `toContain` `toMatch` `toHaveProperty` `toHaveLength` `toBeGreaterThan(OrEqual)` `toBeLessThan(OrEqual)` `toBeOneOf` `toBeTypeOf`, each with `.not` |
| `frap.console` | `log` `info` `warn` `error` → the Console tab |
| `frap.skipRequest()` | pre-request only: stop without sending |
| globals | `fetch` `crypto` `Buffer` `TextEncoder` `URL` `URLSearchParams` `atob` `btoa` `sleep(ms)` |

Dynamic values, generated per send: `{{$uuid}}` `{{$timestamp}}`
`{{$isoTimestamp}}` `{{$randomInt}}` `{{$randomHex}}`.

Press **F1** in the app for the same reference.

## What is and is not committed

| Committed (in the workspace folder) | Machine-local (in app data) |
|---|---|
| requests, folders, scripts, docs | which environment is selected |
| `frap.workspace.json` — name, environment list, timeout, redirect and TLS settings | open tabs and the active tab |
| your `.env` files, if you choose to | window size and position, recent workspaces |

Selecting an environment never dirties the working tree, so switching between
local and staging is not something your teammates see in a diff.

## Features

- Methods, query params, headers, and Bearer / Basic / API-key auth
- Bodies: JSON, text, XML, form URL-encoded, multipart (with files from disk),
  GraphQL, or a raw file
- Response viewer with syntax highlighting, headers, timings, size, and the
  exact bytes that were sent
- Per-hop redirect handling, gzip/deflate/br/zstd decoding, per-workspace
  timeout and TLS-verification toggle
- Drag and drop to reorder and reorganise; ordering is stored per file
- Deletes go to the OS trash
- Watches the folder, so a `git pull` or an edit in your editor shows up
- Dark, keyboard-driven UI

### Shortcuts

`Ctrl+Enter` send · `Ctrl+.` cancel · `Ctrl+S` save · `Ctrl+N` new request ·
`Ctrl+Shift+N` new folder · `Ctrl+W` close tab · `Ctrl+L` focus URL ·
`Ctrl+E` environments · `Ctrl+R` reload from disk · `Ctrl+O` open workspace ·
`F1` scripting reference

## Building

```bash
npm install
npm run dev
```

A single portable executable — no installer, no runtime to install, settings
kept in a `frap-data` folder beside the exe so it travels on a USB stick:

```bash
npm run build:portable
```

Output lands in `release/`. Other targets:

```bash
npm run build:win      # portable exe + NSIS installer
npm run build:linux    # AppImage
npm run build:mac      # dmg
```

Tests:

```bash
npm test
```

## Try it

`examples/httpbin/` is a working workspace. Open that folder in Frap, pick the
`local` environment, and send **Auth → Log in**: its test script writes `TOKEN`
into `examples/httpbin/.env`. Run `git diff` afterwards to see that only that
one line changed.

## Layout

```
src/
  shared/types.ts     the on-disk and IPC contract
  main/
    dotenv.ts         comment-preserving .env parser and writer
    workspace.ts      the collection store on disk
    http.ts           request engine (node:http/https, timings, redirects)
    prepare.ts        request + variables -> bytes on the wire
    interpolate.ts    {{VARIABLE}} substitution
    scripting.ts      the node:vm sandbox and assertion library
    execute.ts        orchestrates one request end to end
    ipc.ts            every renderer -> main entry point
    state.ts          machine-local UI state
  preload/            the contextBridge, the renderer's only way out
  renderer/           React UI
```

The renderer has no filesystem or network access of its own; everything goes
through named IPC channels.

## Licence

MIT
