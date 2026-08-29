/**
 * Every renderer -> main entry point. The renderer has no filesystem or
 * network access of its own; it asks for things here.
 */
import {
  BrowserWindow,
  Menu,
  app,
  clipboard,
  dialog,
  ipcMain,
  shell,
  type MenuItemConstructorOptions
} from 'electron'
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  FOLDER_META,
  WORKSPACE_FILE,
  isDraftPath,
  type EnvFileView,
  type ExecResult,
  type FolderMeta,
  type MapStore,
  type StoreSnapshot,
  type FrapRequest,
  type HistoryEntry,
  type RecentWorkspace,
  type VariableScope,
  type TreeNode,
  type Workspace,
  type WorkspaceConfig
} from '../shared/types.ts'
import {
  entryViews,
  envToObject,
  expandEnv,
  applyEnvChanges,
  readEnvDoc,
  setEnvValue,
  unsetEnvValue,
  writeEnvDoc
} from './dotenv.ts'
import { execute } from './execute.ts'
import { parseCurl, toCurl } from './curl.ts'
import { parseOpenApi, type ParseOptions } from './openapi.ts'
import { sendHttp } from './http.ts'
import { toMutable } from './prepare.ts'
import { SelfWriteTracker } from './selfwrites.ts'
import {
  DEFAULT_SETTINGS,
  copyNode,
  folderChain,
  createFolder,
  createRequest,
  duplicateRequest,
  moveNode,
  normalizeFolderMeta,
  normalizeRequest,
  openWorkspace,
  readConfig,
  readFolderMeta,
  readRequest,
  renameNode,
  reorder,
  sanitizeName,
  scanTree,
  writeConfig,
  writeFolderMeta,
  writeNewRequest,
  writeRequest,
  assertInside
} from './workspace.ts'
import {
  clearHistory,
  forgetWorkspace,
  getWorkspaceState,
  loadState,
  pushHistory,
  rememberWorkspace,
  setLayout,
  setUserValues,
  clearUserStore,
  setWorkspaceState,
  type LayoutState
} from './state.ts'

/** One entry in a context menu template sent up from the renderer. */
export interface ContextMenuItem {
  id?: string
  label?: string
  type?: 'separator' | 'checkbox'
  enabled?: boolean
  accelerator?: string
  /** Ticks a checkbox item - used to mark the current tab in a long list. */
  checked?: boolean
}

/**
 * What Frap identifies itself as, for requests that set no User-Agent.
 * Taken from the app rather than written out, so it tracks package.json.
 */
const userAgent = (): string => `Frap/${app.getVersion()}`

/** Session variables live for as long as the app runs, keyed by workspace. */
const sessionVars = new Map<string, Map<string, string>>()
/** In-flight requests, so the UI can cancel them. */
const inflight = new Map<string, AbortController>()

let current: { root: string; config: WorkspaceConfig } | null = null
let watcher: FSWatcher | null = null

function varsFor(root: string): Map<string, string> {
  let map = sessionVars.get(root)
  if (!map) {
    map = new Map()
    sessionVars.set(root, map)
  }
  return map
}

function requireWorkspace(): { root: string; config: WorkspaceConfig } {
  if (!current) throw new Error('No workspace is open')
  return current
}

/** Resolves an environment file path, allowing absolute paths outside the root. */
function envAbsPath(root: string, file: string): string {
  return path.isAbsolute(file) ? file : path.resolve(root, file)
}

async function activeEnvPath(): Promise<string | null> {
  const { root, config } = requireWorkspace()
  const state = await getWorkspaceState(root)
  if (!state.activeEnvironment) return null
  const env = config.environments.find((e) => e.name === state.activeEnvironment)
  return env ? envAbsPath(root, env.file) : null
}

/**
 * The variables a request would resolve against right now: the active .env
 * file, overlaid with anything scripts have set this session. Annotated with
 * where each value came from, for the hover card in the editor.
 */
async function activeScopeDetailed(): Promise<VariableScope> {
  // An unsaved collection has no .env behind it, but the session and user
  // stores still work - they are not tied to a folder on disk.
  if (!current) {
    const scope: VariableScope = {}
    for (const [key, value] of await userStoreFor(DRAFT_STORE_KEY)) {
      scope[key] = { value, source: 'user' }
    }
    for (const [key, value] of draftVars) scope[key] = { value, source: 'session' }
    return scope
  }
  const { root } = requireWorkspace()
  const state = await getWorkspaceState(root)
  const envPath = await activeEnvPath()
  const scope: VariableScope = {}

  if (envPath) {
    const { doc } = await readEnvDoc(envPath)
    for (const [key, value] of Object.entries(expandEnv(envToObject(doc)))) {
      scope[key] = {
        value,
        source: 'environment',
        ...(state.activeEnvironment ? { environment: state.activeEnvironment } : {})
      }
    }
  }
  // Same precedence as a real send: environment, then user, then session.
  for (const [key, value] of await userStoreFor(root)) scope[key] = { value, source: 'user' }
  for (const [key, value] of varsFor(root)) scope[key] = { value, source: 'session' }
  return scope
}

/** The same scope, flattened the way the interpolator wants it. */
async function activeScope(): Promise<Record<string, string>> {
  const detailed = await activeScopeDetailed()
  return Object.fromEntries(Object.entries(detailed).map(([key, info]) => [key, info.value]))
}

/* ------------------------------------------------------------------ */
/* Filesystem watching                                                 */
/* ------------------------------------------------------------------ */

/**
 * Paths Frap itself just wrote. The renderer already knows about its own
 * edits, so re-announcing them as "the disk changed" is pure noise.
 */
const selfWrites = new SelfWriteTracker()

const markSelfWrite = (...targets: Array<string | null | undefined>): void =>
  selfWrites.mark(...targets)

/**
 * Watches the workspace so a `git pull` or an edit in another editor shows up
 * without restarting. Debounced, because a checkout fires hundreds of events.
 *
 * Filtering happens at flush time rather than per event: a write marks its
 * path immediately after finishing, which can land just after the raw event
 * arrives but always well before the debounce fires.
 */
function watchWorkspace(root: string, window: BrowserWindow): void {
  watcher?.close()
  watcher = null
  let timer: NodeJS.Timeout | null = null
  let pending: string[] = []

  try {
    watcher = watch(root, { recursive: true }, (_event, filename) => {
      const name = String(filename ?? '')
      if (!name || name.includes('.git') || name.includes('node_modules')) return
      pending.push(name)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        const external = pending.filter((file) => !selfWrites.has(path.resolve(root, file)))
        pending = []
        if (external.length === 0) return
        if (!window.isDestroyed()) window.webContents.send('workspace:changed', external[0])
      }, 250)
    })
  } catch {
    // Recursive watching is unsupported on some platforms/filesystems; the
    // manual refresh button still works.
  }
}

/* ------------------------------------------------------------------ */
/* Environments                                                        */
/* ------------------------------------------------------------------ */

async function listEnvironments(): Promise<EnvFileView[]> {
  const { root, config } = requireWorkspace()
  return Promise.all(
    config.environments.map(async (env): Promise<EnvFileView> => {
      const absPath = envAbsPath(root, env.file)
      try {
        const { doc, exists, raw } = await readEnvDoc(absPath)
        return {
          name: env.name,
          file: env.file,
          absPath,
          exists,
          entries: entryViews(doc),
          raw
        }
      } catch (err) {
        return {
          name: env.name,
          file: env.file,
          absPath,
          exists: false,
          entries: [],
          raw: '',
          error: (err as Error).message
        }
      }
    })
  )
}

/**
 * Folder settings the renderer has open and unsaved, keyed by folder path.
 * Normalised here so a half-built object from the editor is still safe.
 */
function toOverrides(input?: Record<string, FolderMeta>): Map<string, FolderMeta> | undefined {
  if (!input) return undefined
  const map = new Map<string, FolderMeta>()
  for (const [folder, meta] of Object.entries(input)) {
    map.set(path.resolve(folder), normalizeFolderMeta(meta))
  }
  return map.size ? map : undefined
}

/* ------------------------------------------------------------------ */
/* Drafts                                                              */
/* ------------------------------------------------------------------ */

/**
 * Session variables for the unsaved collection. Kept apart from the
 * per-workspace maps so saving into a folder does not inherit them and,
 * more importantly, so they do not leak the other way.
 */
const draftVars = new Map<string, string>()

/**
 * The key the user store lives under before a collection has a folder.
 * Reserved rather than derived, so it can never collide with a real path.
 */
const DRAFT_STORE_KEY = '(unsaved collection)'

/** The user store for a workspace, as a map the executor can read. */
async function userStoreFor(root: string): Promise<Map<string, string>> {
  return new Map(Object.entries((await getWorkspaceState(root)).userStore))
}

/** Persists what a script wrote to the user store, in one pass. */
async function persistUserWrites(root: string, result: ExecResult): Promise<void> {
  const changes = result.writes
    .filter((w) => w.store === 'user')
    .map((w) => ({ key: w.key, value: w.value }))
  if (changes.length) await setUserValues(root, changes)
}

/**
 * Sends a request that has no file behind it.
 *
 * There is no workspace, so: no .env to read or write, the built-in
 * settings, and file-backed bodies resolve against the user's home rather
 * than a collection folder. Nothing is recorded in history - there is no
 * workspace to record it against.
 */
async function sendDraft(
  draftPath: string,
  req: FrapRequest
): Promise<ExecResult & { runId: string }> {
  const runId = randomUUID()
  const controller = new AbortController()
  inflight.set(runId, controller)
  try {
    const result = await execute({
      root: app.getPath('home'),
      request: normalizeRequest(req, 'Draft'),
      envPath: null,
      settings: DEFAULT_SETTINGS,
      vars: draftVars,
      user: await userStoreFor(DRAFT_STORE_KEY),
      userAgent: userAgent(),
      signal: controller.signal
    })
    await persistUserWrites(DRAFT_STORE_KEY, result)
    return { ...result, runId }
  } finally {
    inflight.delete(runId)
  }
}

/* ------------------------------------------------------------------ */
/* Registration                                                        */
/* ------------------------------------------------------------------ */

type Handler = (...args: never[]) => unknown

/** Wraps a handler so thrown errors reach the renderer as a readable message. */
function handle(channel: string, fn: Handler): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return { ok: true, data: await (fn as (...a: unknown[]) => unknown)(...args) }
    } catch (err) {
      return { ok: false, error: (err as Error).message }
    }
  })
}

export function registerIpc(getWindow: () => BrowserWindow | null): void {
  /* -- workspace ---------------------------------------------------- */

  handle('workspace:pick', async () => {
    const window = getWindow()
    const result = await dialog.showOpenDialog(window!, {
      title: 'Open a Frap workspace folder',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled ? null : result.filePaths[0]
  })

  handle('workspace:open', async (root: string) => {
    const workspace = await openWorkspace(root)
    current = { root: workspace.root, config: workspace.config }
    await rememberWorkspace(workspace.root)
    const window = getWindow()
    if (window) watchWorkspace(workspace.root, window)
    return {
      ...workspace,
      state: await getWorkspaceState(workspace.root),
      environments: await listEnvironments()
    }
  })

  /**
   * Gives an unsaved collection a home.
   *
   * Asks for a folder, opens it as a workspace, then writes every draft into
   * it in order. Returns the new paths positionally, so the renderer can
   * re-point the tabs it already has open without losing anything.
   */
  handle('workspace:saveDrafts', async (drafts: FrapRequest[]) => {
    const window = getWindow()
    const result = await dialog.showOpenDialog(window!, {
      title: 'Choose a folder for this collection',
      buttonLabel: 'Save Here',
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled) return null

    const root = result.filePaths[0]
    const workspace = await openWorkspace(root)
    current = { root: workspace.root, config: workspace.config }
    await rememberWorkspace(workspace.root)
    markSelfWrite(root, path.join(root, WORKSPACE_FILE))

    const paths: string[] = []
    for (const draft of drafts) {
      const file = await writeNewRequest(root, root, normalizeRequest(draft, 'New Request'))
      markSelfWrite(file)
      paths.push(file)
    }

    const win = getWindow()
    if (win) watchWorkspace(workspace.root, win)

    return {
      ...workspace,
      // Re-scan: the tree above was taken before the drafts were written.
      tree: await scanTree(root),
      state: await getWorkspaceState(workspace.root),
      environments: await listEnvironments(),
      paths
    }
  })

  handle('workspace:refresh', async (): Promise<{ tree: TreeNode[]; environments: EnvFileView[] }> => {
    const { root } = requireWorkspace()
    return { tree: await scanTree(root), environments: await listEnvironments() }
  })

  handle('workspace:saveConfig', async (config: WorkspaceConfig) => {
    const { root } = requireWorkspace()
    markSelfWrite(path.join(root, WORKSPACE_FILE))
    await writeConfig(root, config)
    current = { root, config }
    return { config, environments: await listEnvironments() }
  })

  handle('workspace:recent', async () => {
    const state = await loadState()
    // Drop folders that have since been deleted or moved, and pick up the
    // name each one gives itself so the switcher shows what the title bar
    // would show, not just the folder name.
    const alive: RecentWorkspace[] = []
    for (const root of state.recentWorkspaces) {
      if (!(await fs.stat(root).then((s) => s.isDirectory()).catch(() => false))) continue
      const config = await readConfig(root).catch(() => null)
      alive.push({ root, name: config?.name || path.basename(root) })
    }
    return { recent: alive, last: state.lastWorkspace }
  })

  handle('workspace:forget', (root: string) => forgetWorkspace(root))

  handle('workspace:reveal', async (target: string) => {
    shell.showItemInFolder(target)
  })

  /* -- state -------------------------------------------------------- */

  handle('state:get', async () => {
    const { root } = requireWorkspace()
    return getWorkspaceState(root)
  })

  handle('state:set', async (patch: Record<string, unknown>) => {
    const { root } = requireWorkspace()
    return setWorkspaceState(root, patch)
  })

  /* -- requests ----------------------------------------------------- */

  handle('request:read', async (absPath: string): Promise<FrapRequest> => {
    const { root } = requireWorkspace()
    assertInside(root, absPath)
    return readRequest(absPath)
  })

  handle('request:save', async (absPath: string, req: FrapRequest) => {
    const { root } = requireWorkspace()
    assertInside(root, absPath)
    markSelfWrite(absPath)
    await writeRequest(absPath, normalizeRequest(req, path.basename(absPath)))
    return true
  })

  handle('request:create', async (parentDir: string, name?: string) => {
    const { root } = requireWorkspace()
    const created = await createRequest(root, parentDir || root, name)
    markSelfWrite(created)
    return created
  })

  handle('request:duplicate', async (absPath: string) => {
    const { root } = requireWorkspace()
    const copy = await duplicateRequest(root, absPath)
    markSelfWrite(copy)
    return copy
  })

  /* -- cURL ---------------------------------------------------------- */

  /**
   * Renders the request as it would actually be sent, with every variable
   * already resolved, and puts it on the clipboard.
   */
  handle(
    'request:toCurl',
    async (absPath: string, req?: FrapRequest, folderOverrides?: Record<string, FolderMeta>) => {
      // A draft has no file to fall back on, so the editor's copy is all there
      // is - and no workspace settings to honour.
      if (isDraftPath(absPath)) {
        if (!req) throw new Error('Nothing to copy yet')
        const request = normalizeRequest(req, 'Draft')
        const missing = new Set<string>()
        const scope = await activeScope()
        const mutable = toMutable(request, { root: app.getPath('home'), scope, missing })
        const command = toCurl(request, mutable, {
          followRedirects: DEFAULT_SETTINGS.followRedirects,
          validateTls: DEFAULT_SETTINGS.validateTls
        })
        clipboard.writeText(command)
        return { command, missing: [...missing] }
      }

      const { root, config } = requireWorkspace()
      assertInside(root, absPath)
      // Prefer the in-editor version so unsaved edits are included.
      const request = req
        ? normalizeRequest(req, path.basename(absPath))
        : await readRequest(absPath)
      const scope = await activeScope()
      const missing = new Set<string>()
      const mutable = toMutable(request, {
        root,
        scope,
        missing,
        userAgent: userAgent(),
        folders: await folderChain(root, path.dirname(absPath), toOverrides(folderOverrides))
      })
      const command = toCurl(request, mutable, {
        followRedirects: request.settings?.followRedirects ?? config.settings.followRedirects,
        validateTls: request.settings?.validateTls ?? config.settings.validateTls
      })
      clipboard.writeText(command)
      return { command, missing: [...missing] }
    }
  )

  /** Parses without writing anything, so the import dialog can preview it. */
  handle('curl:parse', async (text: string, substitute: boolean) => {
    const scope = await activeScope()
    const { request, warnings } = parseCurl(text, scope, substitute)
    return { request, warnings }
  })

  handle('curl:import', async (parentDir: string, text: string, substitute: boolean, name?: string) => {
    const { root } = requireWorkspace()
    const target = parentDir || root
    assertInside(root, target)

    const scope = await activeScope()
    const { request, warnings } = parseCurl(text, scope, substitute)
    if (name?.trim()) request.name = name.trim()

    const file = await writeNewRequest(root, target, request)
    markSelfWrite(file)
    return { path: file, warnings }
  })

  /* -- OpenAPI ------------------------------------------------------- */

  /**
   * Fetches a document over HTTP.
   *
   * Goes through Frap's own engine rather than global fetch, so a redirect,
   * a gzipped response or a self-signed certificate behaves the same way it
   * would for a request you sent yourself.
   */
  const fetchDocument = async (url: string): Promise<string> => {
    const trimmed = url.trim()
    if (!/^https?:\/\//i.test(trimmed)) {
      throw new Error('The URL must start with http:// or https://')
    }
    const response = await sendHttp(
      {
        method: 'GET',
        url: trimmed,
        headers: [
          ['Accept', 'application/json, text/plain, */*'],
          ['User-Agent', userAgent()]
        ],
        body: null
      },
      {
        timeoutMs: current?.config.settings.timeoutMs ?? DEFAULT_SETTINGS.timeoutMs,
        followRedirects: true,
        maxRedirects: DEFAULT_SETTINGS.maxRedirects,
        validateTls: current?.config.settings.validateTls ?? DEFAULT_SETTINGS.validateTls
      }
    )
    if (response.status >= 400) {
      throw new Error(`${trimmed} returned ${response.status} ${response.statusText}`)
    }
    if (response.isBinary) throw new Error(`${trimmed} did not return text`)
    return response.bodyText
  }

  /** Text either pasted in or downloaded, so both paths share the parser. */
  const openApiText = (source: { text?: string; url?: string }): Promise<string> =>
    source.url?.trim() ? fetchDocument(source.url) : Promise.resolve(source.text ?? '')

  /** Parses without writing anything, so the dialog can show what it will do. */
  handle('openapi:parse', async (source: { text?: string; url?: string }, options: ParseOptions) =>
    parseOpenApi(await openApiText(source), options)
  )

  handle(
    'openapi:import',
    async (
      source: { text?: string; url?: string },
      parentDir: string,
      options: ParseOptions & { applyAuth?: boolean; server?: string }
    ) => {
      const { root } = requireWorkspace()
      const target = parentDir || root
      assertInside(root, target)

      const plan = parseOpenApi(await openApiText(source), options)
      const warnings = [...plan.warnings]
      const created: string[] = []
      // Folders are made once and reused, so a tag with twenty operations
      // does not race twenty creations of the same directory.
      const folders = new Map<string, string>()

      for (const planned of plan.requests) {
        let dir = target
        if (planned.folder) {
          const existing = folders.get(planned.folder)
          if (existing) dir = existing
          else {
            const wanted = path.join(target, sanitizeName(planned.folder))
            // Reuse a folder that is already there rather than making a
            // second one with a numeric suffix.
            dir = (await fs.stat(wanted).then((s) => s.isDirectory()).catch(() => false))
              ? wanted
              : await createFolder(root, target, planned.folder)
            folders.set(planned.folder, dir)
          }
        }
        const file = await writeNewRequest(root, dir, normalizeRequest(planned.request, 'Request'))
        markSelfWrite(file)
        created.push(file)
      }

      // The document's global security becomes the target folder's auth, so
      // every request below inherits it instead of repeating it.
      if (options.applyAuth !== false && plan.auth) {
        const existing = (await readFolderMeta(target)) ?? normalizeFolderMeta({})
        await writeFolderMeta(target, { ...existing, auth: plan.auth })
        markSelfWrite(target, path.join(target, FOLDER_META))
      }

      // Bind the server URL, so the imported requests resolve straight away.
      const server = options.server?.trim()
      const variable = options.baseVariable?.trim() || 'BASE_URL'
      let boundTo: string | null = null
      if (server) {
        const envPath = await activeEnvPath()
        if (envPath) {
          markSelfWrite(envPath)
          await applyEnvChanges(envPath, [{ key: variable, value: server }])
          boundTo = path.basename(envPath)
        } else {
          await setUserValues(storeRoot(), [{ key: variable, value: server }])
          boundTo = 'user store'
        }
      }

      markSelfWrite(target)
      return { created, warnings, boundTo, variable, title: plan.title }
    }
  )

  /** Creates a request from a JSON object - what pasting a request does. */
  handle('request:createFrom', async (parentDir: string, input: Partial<FrapRequest>) => {
    const { root } = requireWorkspace()
    const target = parentDir || root
    assertInside(root, target)
    const request = normalizeRequest(input, 'Pasted Request')
    const file = await writeNewRequest(root, target, request)
    markSelfWrite(file)
    return file
  })

  handle('folder:create', async (parentDir: string, name?: string) => {
    const { root } = requireWorkspace()
    const created = await createFolder(root, parentDir || root, name)
    markSelfWrite(created)
    return created
  })

  handle('node:rename', async (absPath: string, name: string) => {
    const { root } = requireWorkspace()
    markSelfWrite(absPath)
    const renamed = await renameNode(root, absPath, name)
    markSelfWrite(renamed)
    return renamed
  })

  handle('node:move', async (absPath: string, destDir: string) => {
    const { root } = requireWorkspace()
    markSelfWrite(absPath)
    const moved = await moveNode(root, absPath, destDir)
    markSelfWrite(moved)
    return moved
  })

  /**
   * Folder settings. The workspace root counts as a folder, which is how
   * collection-wide headers, auth and scripts are expressed.
   */
  handle('folder:read', async (absPath: string) => {
    const { root } = requireWorkspace()
    const dir = absPath || root
    assertInside(root, dir)
    return (await readFolderMeta(dir)) ?? normalizeFolderMeta({})
  })

  handle('folder:save', async (absPath: string, meta: FolderMeta) => {
    const { root } = requireWorkspace()
    const dir = absPath || root
    assertInside(root, dir)
    markSelfWrite(dir, path.join(dir, FOLDER_META))
    await writeFolderMeta(dir, normalizeFolderMeta(meta))
    return true
  })

  handle('node:copy', async (absPath: string, destDir: string) => {
    const { root } = requireWorkspace()
    const copied = await copyNode(root, absPath, destDir)
    markSelfWrite(copied)
    return copied
  })

  handle('node:reorder', async (parentDir: string, orderedPaths: string[]) => {
    const { root } = requireWorkspace()
    markSelfWrite(...orderedPaths)
    await reorder(root, parentDir, orderedPaths)
    return true
  })

  handle('node:delete', async (absPath: string) => {
    const { root } = requireWorkspace()
    assertInside(root, absPath)
    markSelfWrite(absPath)
    // Goes to the OS trash, so a mis-click is recoverable.
    await shell.trashItem(absPath)
    return true
  })

  /* -- environments -------------------------------------------------- */

  handle('env:list', () => listEnvironments())

  handle('env:add', async () => {
    const window = getWindow()
    const { root, config } = requireWorkspace()
    const result = await dialog.showOpenDialog(window!, {
      title: 'Choose a .env file',
      defaultPath: root,
      properties: ['openFile'],
      filters: [
        { name: 'Environment files', extensions: ['env', 'local', 'development', 'production'] },
        { name: 'All files', extensions: ['*'] }
      ]
    })
    if (result.canceled) return null

    const picked = result.filePaths[0]
    const rel = path.relative(root, picked)
    // Keep it relative when it lives in the workspace, so the config is portable.
    const file = rel.startsWith('..') ? picked : rel.split(path.sep).join('/')
    const name = path.basename(picked).replace(/^\.env\.?/, '') || path.basename(picked)
    if (!config.environments.some((e) => e.file === file)) {
      config.environments = [...config.environments, { name: name || 'default', file }]
      markSelfWrite(path.join(root, WORKSPACE_FILE))
      await writeConfig(root, config)
      current = { root, config }
    }
    return { config, environments: await listEnvironments() }
  })

  handle('env:createFile', async (fileName: string, envName: string) => {
    const { root, config } = requireWorkspace()
    const target = path.resolve(root, fileName)
    assertInside(root, target)
    markSelfWrite(target, path.join(root, WORKSPACE_FILE))
    if (!(await fs.stat(target).catch(() => null))) {
      await fs.writeFile(
        target,
        `# ${envName} environment\n# Managed by Frap - comments are preserved on write.\n\n`,
        'utf8'
      )
    }
    const file = path.relative(root, target).split(path.sep).join('/')
    if (!config.environments.some((e) => e.file === file)) {
      config.environments = [...config.environments, { name: envName, file }]
      await writeConfig(root, config)
      current = { root, config }
    }
    return { config, environments: await listEnvironments() }
  })

  handle('env:remove', async (name: string) => {
    const { root, config } = requireWorkspace()
    // Only unlinks it from the workspace; the file itself stays on disk.
    config.environments = config.environments.filter((e) => e.name !== name)
    markSelfWrite(path.join(root, WORKSPACE_FILE))
    await writeConfig(root, config)
    current = { root, config }
    const state = await getWorkspaceState(root)
    if (state.activeEnvironment === name) await setWorkspaceState(root, { activeEnvironment: null })
    return { config, environments: await listEnvironments() }
  })

  handle('env:setValue', async (name: string, key: string, value: string | null) => {
    const { root, config } = requireWorkspace()
    const env = config.environments.find((e) => e.name === name)
    if (!env) throw new Error(`Unknown environment: ${name}`)
    const absPath = envAbsPath(root, env.file)
    markSelfWrite(absPath)
    const { doc } = await readEnvDoc(absPath)
    if (value === null) unsetEnvValue(doc, key)
    else setEnvValue(doc, key, value)
    await writeEnvDoc(absPath, doc)
    return listEnvironments()
  })

  handle('env:saveRaw', async (name: string, raw: string) => {
    const { root, config } = requireWorkspace()
    const env = config.environments.find((e) => e.name === name)
    if (!env) throw new Error(`Unknown environment: ${name}`)
    const absPath = envAbsPath(root, env.file)
    markSelfWrite(absPath)
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    // Written verbatim - the user is editing the file itself here, so we do
    // not reformat, reorder or re-quote anything.
    await fs.writeFile(absPath, raw, 'utf8')
    return listEnvironments()
  })

  /* -- execution ----------------------------------------------------- */

  handle(
    'exec:send',
    async (
      absPath: string,
      req: FrapRequest,
      folderOverrides?: Record<string, FolderMeta>
    ): Promise<ExecResult & { runId: string }> => {
      // A draft has no folder yet, so it runs against no environment and no
      // workspace settings. Everything else about sending is identical.
      if (isDraftPath(absPath)) return sendDraft(absPath, req)

      const { root, config } = requireWorkspace()
      assertInside(root, absPath)
      const runId = randomUUID()
      const controller = new AbortController()
      inflight.set(runId, controller)
      try {
        const request = normalizeRequest(req, path.basename(absPath))
        const envPath = await activeEnvPath()
        // Scripts may write to the environment; that is still our own write.
        markSelfWrite(envPath)
        const result = await execute({
          root,
          // Headers, auth and scripts from every folder above the request,
          // including any whose settings tab is open with unsaved edits.
          folders: await folderChain(root, path.dirname(absPath), toOverrides(folderOverrides)),
          request,
          envPath,
          settings: config.settings,
          vars: varsFor(root),
          user: await userStoreFor(root),
          userAgent: userAgent(),
          signal: controller.signal
        })
        // Re-mark: a long request can outlive the grace period, and a script's
        // env write lands at the very end of execute().
        if (result.writes.some((w) => w.store === 'environment')) markSelfWrite(envPath)
        await persistUserWrites(root, result)
        if (!result.skipped) {
          const entry: HistoryEntry = {
            id: runId,
            at: Date.now(),
            requestId: request.id,
            name: request.name,
            method: result.sent?.method ?? request.method,
            url: result.sent?.url ?? request.url,
            ...(result.response
              ? { status: result.response.status, timeMs: result.response.timings.totalMs }
              : {}),
            ...(result.error ? { error: result.error } : {})
          }
          // History is a convenience, never a reason to fail a send.
          await pushHistory(root, entry).catch(() => undefined)
        }
        return { ...result, runId }
      } finally {
        inflight.delete(runId)
      }
    }
  )

  /* -- history and layout -------------------------------------------- */

  handle('history:list', async (): Promise<HistoryEntry[]> => {
    const { root } = requireWorkspace()
    return (await getWorkspaceState(root)).history
  })

  handle('history:clear', async () => {
    const { root } = requireWorkspace()
    await clearHistory(root)
    return true
  })

  handle('layout:get', async (): Promise<LayoutState> => (await loadState()).layout)

  handle('layout:set', (patch: Partial<LayoutState>) => setLayout(patch))

  handle('exec:cancel', (runId: string) => {
    inflight.get(runId)?.abort()
    return true
  })

  handle('exec:cancelAll', () => {
    for (const controller of inflight.values()) controller.abort()
    return true
  })

  handle('vars:scope', (): Promise<VariableScope> => activeScopeDetailed())

  /* -- session and user stores --------------------------------------- */

  /** The workspace these stores belong to; drafts get their own bucket. */
  const storeRoot = (): string => current?.root ?? DRAFT_STORE_KEY

  const storeSnapshot = async (root: string): Promise<StoreSnapshot> => ({
    session: Object.fromEntries(varsFor(root)),
    user: (await getWorkspaceState(root)).userStore
  })

  handle('store:list', () => storeSnapshot(storeRoot()))

  handle('store:set', async (store: MapStore, key: string, value: string | null) => {
    const root = storeRoot()
    if (store === 'session') {
      const map = varsFor(root)
      if (value === null) map.delete(key)
      else map.set(key, value)
    } else {
      await setUserValues(root, [{ key, value }])
    }
    return storeSnapshot(root)
  })

  handle('store:clear', async (store: MapStore) => {
    const root = storeRoot()
    if (store === 'session') varsFor(root).clear()
    else await clearUserStore(root)
    return storeSnapshot(root)
  })

  handle('vars:list', () => {
    const { root } = requireWorkspace()
    return Object.fromEntries(varsFor(root))
  })

  handle('vars:clear', () => {
    const { root } = requireWorkspace()
    varsFor(root).clear()
    return true
  })

  /* -- native menus --------------------------------------------------- */

  /**
   * Pops up a real OS context menu from a template the renderer supplies and
   * resolves with the id that was clicked (or null if it was dismissed).
   */
  handle('menu:context', (items: ContextMenuItem[], at?: { x: number; y: number }) => {
    const window = getWindow()
    if (!window) return null
    return new Promise<string | null>((resolve) => {
      let picked: string | null = null
      const template: MenuItemConstructorOptions[] = items.map((item) =>
        item.type === 'separator'
          ? { type: 'separator' }
          : {
              label: item.label,
              type: item.type === 'checkbox' ? 'checkbox' : undefined,
              checked: item.checked,
              enabled: item.enabled !== false,
              accelerator: item.accelerator,
              click: () => {
                picked = item.id ?? null
              }
            }
      )
      const menu = Menu.buildFromTemplate(template)
      // A dropdown opened from a button passes the button's corner, so the
      // menu hangs off the control rather than the mouse pointer.
      const anchor = at ? { x: Math.round(at.x), y: Math.round(at.y) } : {}
      // `closed` fires after `click`, so the id is already set by then.
      menu.popup({ window, ...anchor, callback: () => resolve(picked) })
    })
  })

  /** Opens the application menu from the custom title bar's button. */
  handle('menu:app', () => {
    const window = getWindow()
    const menu = Menu.getApplicationMenu()
    if (window && menu) menu.popup({ window, x: 8, y: 36 })
    return true
  })

  /* -- window controls ------------------------------------------------ */

  handle('window:minimize', () => {
    getWindow()?.minimize()
    return true
  })

  handle('window:toggleMaximize', () => {
    const window = getWindow()
    if (!window) return false
    if (window.isMaximized()) window.unmaximize()
    else window.maximize()
    return window.isMaximized()
  })

  handle('window:close', () => {
    getWindow()?.close()
    return true
  })

  handle('window:isMaximized', () => getWindow()?.isMaximized() ?? false)

  /* -- misc ---------------------------------------------------------- */

  handle('clipboard:write', (text: string) => {
    clipboard.writeText(text)
    return true
  })

  handle('clipboard:read', () => clipboard.readText())

  handle('shell:openExternal', async (url: string) => {
    if (!/^https?:\/\//i.test(url)) throw new Error('Only http(s) links can be opened')
    await shell.openExternal(url)
  })

  handle('dialog:pickFile', async () => {
    const window = getWindow()
    const result = await dialog.showOpenDialog(window!, { properties: ['openFile'] })
    if (result.canceled) return null
    const { root } = requireWorkspace()
    const rel = path.relative(root, result.filePaths[0])
    return rel.startsWith('..') ? result.filePaths[0] : rel.split(path.sep).join('/')
  })

  handle('dialog:saveFile', async (defaultName: string, base64: string) => {
    const window = getWindow()
    const result = await dialog.showSaveDialog(window!, { defaultPath: defaultName })
    if (result.canceled || !result.filePath) return null
    await fs.writeFile(result.filePath, Buffer.from(base64, 'base64'))
    return result.filePath
  })
}

export function disposeIpc(): void {
  watcher?.close()
  watcher = null
  for (const controller of inflight.values()) controller.abort()
  inflight.clear()
}

/** Exposed for `workspace:open` to return the freshly scanned tree. */
export type OpenWorkspaceResult = Workspace & {
  state: Awaited<ReturnType<typeof getWorkspaceState>>
  environments: EnvFileView[]
}
