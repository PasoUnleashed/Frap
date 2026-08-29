# Frap

An API client whose collections are just files.

Postman-style workflow, but the collection is a folder of plain JSON — one file
per request — and environments are ordinary `.env` files you point at. Commit
them, branch them, review them in a pull request, and merge them without a
proprietary sync service in the middle.

Ships as a single portable executable for Windows, macOS and Linux.

---

## Start typing, choose a folder later

Frap opens with no folder selected. Hit **New request**, point it at a URL and
send it — nothing has touched the disk yet, the way an unsaved file works in a
code editor. Requests you have not saved are marked with a dot and listed in
the sidebar.

When the collection is worth keeping, **Ctrl+S** asks where it should live and
writes every draft into that folder as its own `.frap.json`. The tabs you had
open re-point to the real files, and from then on it is an ordinary Frap
workspace: environments, history, folders, the lot.

The Welcome tab sits alongside your request tabs rather than blocking them, and
lists the collections you had open before. Close it like any other tab.

A draft has no folder behind it, so it has no `.env` to read and nothing to
record history against. Everything else — scripts, tests, variables set by
scripts, copy as cURL — works exactly as it does in a saved collection.

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
    _folder.frap.json          optional: settings shared by the folder
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

Every file records the format version it was written in. Reading an older one
migrates it in memory, so a `git pull` full of files from an earlier Frap is
not a wall of diffs — the newer format is written only when you actually save
that file. A file from a *newer* Frap than yours is refused with a message
saying so rather than being quietly misread.

## Settings a whole folder shares

Headers, authentication and both script phases can live on a folder instead of
on every request inside it. `_folder.frap.json` holds them, and the collection
root carries them too, which is how you make something collection-wide.

They are applied outermost first, so **the nearest one wins**:

```
/                Authorization: Bearer {{TOKEN}}   ← collection root
  Users/         X-Tenant: acme                    ← folder
    Get user     X-Tenant: other                   ← request, wins
```

That request sends both headers, with `X-Tenant: other`. Scripts run in the
same order — root, then each folder on the way down, then the request — for
pre-request and post-response alike, so one folder can sign every request below
it, or assert something about every response.

Click a folder to open its settings as a tab, like any request; the caret and
the arrow keys collapse it. Unsaved edits still apply to the next send, so you
can try a header out before committing to it.

**Turning inheritance off.** Each inheritable property — headers, auth,
pre-request script, post-response script — has its own toggle, on folders and
on requests. Switching one off makes that node ignore everything its ancestors
contributed for that property while keeping its own. A public health-check
endpoint inside an authenticated collection is one click, not a restructure.

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

## Three places a value can live

`{{NAME}}` is looked up in three stores, nearest first:

| | Lives | Good for |
|---|---|---|
| **Session** | until you quit Frap; nothing on disk | a token fetched at the start of a run, an id passed from one request to the next |
| **User** | on your machine, per collection, in Frap's app data | your personal token or account id — exactly what you would not want committed |
| **Environment** | the active `.env` file | whatever the team shares |

A session value hides a user value of the same name, and a user value hides one
from the file; remove it and the next one down takes over again. Scripts write
to whichever they mean:

```js
frap.session.set('requestId', crypto.randomUUID())    // this run only
frap.user.set('MY_TOKEN', data.token)                 // kept, never committed
frap.env.set('BASE_URL', 'https://staging.example')   // shared, in the file
```

All three are listed and editable under **Environments**, and `frap.env.get()`
reads whatever `{{NAME}}` would resolve to across all three.

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
| `frap.session` | `get` `set` `unset` `has` `all` — values that last until you quit Frap |
| `frap.user` | same shape — values kept for you on this machine, never in the collection |
| `frap.env` | same shape; `get` reads across all three stores, `set`/`unset` write the active `.env` |
| `frap.vars` | the older name for `frap.session`, still supported |
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

## Import an OpenAPI document

From the File menu, from the tree's right-click menu to import into the
collection root, or from a folder's right-click menu to import into that
folder. Paste the JSON, or give Frap a URL and it fetches the document through
the same engine your requests use, so redirects, gzip and your TLS setting all
behave the way they do everywhere else.

OpenAPI 3.0, 3.1 and Swagger 2.0 all import, and every operation becomes its
own `.frap.json`:

- each tag becomes a folder, or turn that off for one flat list
- `/users/{id}` becomes `/users/{{id}}`, so path parameters are variables you
  fill in like any other
- required query and header parameters arrive enabled and optional ones arrive
  switched off, so the request works as imported
- bodies are filled in from the schema — `$ref`s resolved, `allOf` merged,
  a declared example preferred over a generated one, and self-referencing
  schemas terminated instead of looped
- the document's security scheme becomes the target folder's auth, so
  everything below inherits it rather than repeating it; an operation with
  `security: []` opts itself out
- the server URL is bound to `{{BASE_URL}}` — rename it if you like — written
  to the active `.env`, or to your user store if there is no environment yet

The preview lists the exact folders and requests it is going to write, plus
anything it had to skip. It comes from the same parser that does the import, so
what you see is what lands on disk.

## What Frap remembers for you

Per machine, in your app-data folder (or `frap-data` beside the portable exe):

- **Recent workspaces**. Frap does not reopen one on launch - it starts ready
  to work instead - but the chip in the
  title bar names the collection you are in and drops down the last five, so
  hopping between a couple of APIs is one click. Anything with unsaved edits
  asks first, since switching closes every tab.
- **Send history** per workspace — method, URL, status and timing for
  everything you have sent, grouped by day in the sidebar's History tab
  (`Ctrl+H`). Click an entry to jump back to the request it came from.
- **Your user store** per workspace — the personal half of `{{NAME}}`, kept out
  of the collection folder entirely so it cannot be committed by accident
- Open tabs and the active tab, restored on the next launch
- Which folders you collapsed in the tree
- Sidebar width and the request/response split
- Window size, position and whether it was maximised

None of it touches the workspace folder, so none of it can show up in a diff.

## What is and is not committed

| Committed (in the workspace folder) | Machine-local (in app data) |
|---|---|
| requests, folders, scripts, docs | which environment is selected |
| `_folder.frap.json` — a folder's shared headers, auth and scripts | your user store, and the session store while it lasts |
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
- Folder-level headers, auth and scripts, inherited by everything below, with a
  per-property toggle to stop inheriting
- Session and user stores alongside `.env`, resolved nearest-first
- `{{variable}}` chips with hover values and copy-on-right-click
- Copy any request as cURL, or import one by pasting a cURL command
- Import an OpenAPI 3.x or Swagger 2.0 document by paste or URL, into the
  collection or into one folder
- Files are format-versioned, so old collections keep opening and new ones say
  so plainly
- Native right-click menus throughout the tree and the tab strip
- Drag and drop to reorder and reorganise; ordering is stored per file
- Resizable sidebar and response pane, both remembered between sessions
- Deletes go to the OS trash
- Watches the folder, so a `git pull` or an edit in your editor shows up
  — and stays quiet about Frap's own writes
- Dark, keyboard-driven UI with the app's own title bar and window controls

### Shortcuts

**Anywhere** — `Ctrl+Enter` send · `Ctrl+.` cancel · `Ctrl+S` save ·
`Ctrl+N` new request · `Ctrl+Shift+N` new folder · `Ctrl+I` import from cURL ·
`Ctrl+Shift+C` copy as cURL · `Ctrl+L` focus URL · `Ctrl+E` environments ·
`Ctrl+H` history · `Ctrl+R` reload from disk · `Ctrl+O` open workspace ·
`F1` scripting reference · `F12` dev tools

**Tabs** — `Ctrl+Tab` / `Ctrl+Shift+Tab` next and previous (they wrap) ·
`Ctrl+W` close · `Ctrl+Alt+W` close others · `Ctrl+Shift+W` close all

**Collection tree** (when it has focus) — `↑` `↓` move · `→` expand or step in ·
`←` collapse or jump to the parent · `Home` / `End` first and last ·
`Enter` open or toggle · `F2` rename · `Delete` move to trash ·
`Ctrl+D` duplicate · `Ctrl+C` copy · `Ctrl+X` cut · `Ctrl+V` paste ·
`Esc` clear the clipboard

These are scoped to the tree, so `Ctrl+C` in the URL bar or a script editor
still means "copy text".

The menu bar lives behind the ☰ button in the title bar.

### Copy, cut and paste in the tree

`Ctrl+C` a request, click a folder, `Ctrl+V` — the copy lands inside with a new
id, so the two never collide. `Ctrl+X` moves instead of copying, and the row
dims until you paste it. Both work on whole folders too; a folder copy brings
everything under it, re-identified as it goes.

The buffer is shown in the sidebar footer, since it is state you cannot
otherwise see. Click it to clear it, or press `Esc`.

`Ctrl+C` also puts the request's JSON on the system clipboard, and `Ctrl+V`
falls back to whatever is there when Frap's own buffer is empty:

- a request's JSON → creates it in the target folder, so requests paste between
  Frap windows, out of a file, or out of a message from a colleague
- a `curl` command → imports it, the same as `Ctrl+I` but without the dialog

### Many open tabs

The tab strip shrinks tabs to a readable minimum and then scrolls. When it
overflows you get `‹` `›` to nudge it, and a `⌄` button listing every open tab
with the current one ticked. The mouse wheel scrolls the strip sideways, and
selecting a request anywhere — the tree, history, `Ctrl+Tab` — scrolls its tab
into view.

## Downloads

Every commit to `main` publishes builds for all three platforms on the
[releases page](https://github.com/PasoUnleashed/Frap/releases).

| Platform | File | Notes |
|---|---|---|
| Windows | `...-windows-x64-portable.exe` | One file, no install. Settings live in `frap-data` beside it, so it runs from a USB stick. |
| Windows | `...-windows-x64-setup.exe` | Installer, if you want Start-menu entries. |
| macOS | `...-macos-arm64.zip` / `...-macos-x64.zip` | Unzip and run. Unsigned, so right-click → Open the first time. `.dmg` also attached. |
| Linux | `...-linux-x64.AppImage` | `chmod +x` and run. `.tar.gz` also attached. |

Bumping the version in `package.json` cuts a full release tagged
`v<version>`; any other commit publishes a prerelease tagged
`v<version>-build.<n>`, so routine builds stay available without burying the
real ones.

## Building

```bash
npm install
npm run dev
```

Packaging, with output in `release/`:

```bash
npm run build:portable   # just the portable Windows exe
npm run build:win        # portable exe + NSIS installer
npm run build:mac        # zip + dmg, Intel and Apple Silicon
npm run build:linux      # AppImage + tar.gz
```

Each platform has to be built on itself, which is what the release workflow
does. Tests and typechecking:

```bash
npm test
npm run typecheck
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
    openapi.ts        OpenAPI 3.x / Swagger 2.0 -> planned requests
    migrate.ts        reads older file formats, refuses newer ones
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
