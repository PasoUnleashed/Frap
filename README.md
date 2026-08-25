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

## Variables are visible while you edit

Anywhere a `{{variable}}` is interpolated — the URL, params, headers, auth
fields and the body, including JSON and GraphQL — it is drawn as a chip:

- **blue** when it resolves in the current environment
- **red** when nothing will replace it
- **purple** for the generated `{{$uuid}}`-style values

Hover a chip to see what it resolves to right now and where the value came
from. Right-click one to copy the value, copy the `{{name}}` itself, or jump
straight to the environment editor. Switching environments recolours every
chip immediately, so a request that will not resolve is obvious before you
send it.

Script editors deliberately have no chips: `{{...}}` is not interpolated in
scripts, which read values through `frap.env.get()` instead.

## cURL, both directions

**Copy as cURL** — right-click any request (or press `Ctrl+Shift+C`) and the
command lands on your clipboard as multi-line shell, with every
`{{VARIABLE}}` already resolved against the environment you have selected:

```bash
curl \
  --request POST \
  --url 'https://api.example.com/anything/login' \
  --header 'User-Agent: Frap example suite' \
  --header 'Content-Type: application/json' \
  --data-raw '{
  "user": "42",
  "password": "hunter2"
}' \
  --location \
  --compressed
```

It is the request Frap would actually send, so it is safe to paste into a
terminal, a ticket or a message to a backend engineer. File-backed bodies stay
as `@path` references rather than being inlined.

**Import from cURL** — right-click a folder or empty space in the tree (or
press `Ctrl+I`) and paste. Anything a browser's devtools "Copy as cURL"
produces works, as do hand-written commands and the `^` / backtick
continuations from cmd and PowerShell.

Frap understands `-X`, `-H`, `-d`/`--data-raw`/`--data-urlencode`,
`--json`, `-F`, `-u`, `-G`, `-I`, `-T`, `-b`, `-A`, `-e`, bundled short
flags like `-sSL`, and glued values like `-XPOST`. It splits the query string
into editable params, turns `Authorization` headers and `-u` into real auth
settings, pretty-prints JSON bodies, and reports anything it had to skip rather
than dropping it silently.

By default it also works backwards from your environment: a value that matches
an environment variable comes back as `{{THAT_VARIABLE}}`, so a request copied
out of devtools is immediately portable. Untick the box in the dialog to keep
the literal values.

## What Frap remembers for you

Per machine, in your app-data folder (or `frap-data` beside the portable exe):

- **Recent workspaces**, and the one to reopen on launch
- **Send history** per workspace — method, URL, status and timing for
  everything you have sent, grouped by day in the sidebar's History tab
  (`Ctrl+H`). Click an entry to jump back to the request it came from.
- Open tabs and the active tab, restored on the next launch
- Which folders you collapsed in the tree
- Sidebar width and the request/response split
- Window size, position and whether it was maximised

None of it touches the workspace folder, so none of it can show up in a diff.

## What is and is not committed

| Committed (in the workspace folder) | Machine-local (in app data) |
|---|---|
| requests, folders, scripts, docs | which environment is selected |
| `frap.workspace.json` — name, environment list, timeout, redirect and TLS settings | open tabs, collapsed folders, pane sizes |
| your `.env` files, if you choose to | send history, recent workspaces, window state |

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
- `{{variable}}` chips with hover values and copy-on-right-click
- Copy any request as cURL, or import one by pasting a cURL command
- Native right-click menus throughout the tree and the tab strip
- Drag and drop to reorder and reorganise; ordering is stored per file
- Resizable sidebar and response pane, both remembered between sessions
- Deletes go to the OS trash
- Watches the folder, so a `git pull` or an edit in your editor shows up
  — and stays quiet about Frap's own writes
- Dark, keyboard-driven UI with the app's own title bar and window controls

### Shortcuts

`Ctrl+Enter` send · `Ctrl+.` cancel · `Ctrl+S` save · `Ctrl+N` new request ·
`Ctrl+Shift+N` new folder · `Ctrl+I` import from cURL ·
`Ctrl+Shift+C` copy as cURL · `Ctrl+W` close tab · `Ctrl+L` focus URL ·
`Ctrl+E` environments · `Ctrl+H` history · `Ctrl+R` reload from disk ·
`Ctrl+O` open workspace · `F1` scripting reference · `F12` dev tools

The menu bar lives behind the ☰ button in the title bar.

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
    curl.ts           cURL export and import
    prepare.ts        request + variables -> bytes on the wire
    interpolate.ts    {{VARIABLE}} substitution
    scripting.ts      the node:vm sandbox and assertion library
    execute.ts        orchestrates one request end to end
    ipc.ts            every renderer -> main entry point
    state.ts          machine-local state: recents, history, layout, tabs
    selfwrites.ts     tells our own disk writes from everyone else's
  preload/            the contextBridge, the renderer's only way out
  renderer/           React UI
    variables.ts      finding and describing {{variables}} for the UI
```

The renderer has no filesystem or network access of its own; everything goes
through named IPC channels.

## Licence

MIT
