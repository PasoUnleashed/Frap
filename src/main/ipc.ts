/**
 * Every renderer -> main entry point. The renderer has no filesystem or
 * network access of its own; it asks for things here.
 */
import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type {
  EnvFileView,
  ExecResult,
  FrapRequest,
  TreeNode,
  Workspace,
  WorkspaceConfig
} from '../shared/types.ts'
import { entryViews, readEnvDoc, setEnvValue, unsetEnvValue, writeEnvDoc } from './dotenv.ts'
import { execute } from './execute.ts'
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
  scanTree,
  writeConfig,
  writeRequest,
  assertInside
} from './workspace.ts'
import { forgetWorkspace, getWorkspaceState, loadState, rememberWorkspace, setWorkspaceState } from './state.ts'

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

/* ------------------------------------------------------------------ */
/* Filesystem watching                                                 */
/* ------------------------------------------------------------------ */

/**
 * Watches the workspace so a `git pull` or an edit in another editor shows up
 * without restarting. Debounced, because a checkout fires hundreds of events.
 */
function watchWorkspace(root: string, window: BrowserWindow): void {
  watcher?.close()
  watcher = null
  let timer: NodeJS.Timeout | null = null
  try {
    watcher = watch(
      root,
      { recursive: true },
      (_event, filename) => {
        const name = String(filename ?? '')
        if (name.includes('.git') || name.includes('node_modules')) return
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          if (!window.isDestroyed()) window.webContents.send('workspace:changed', name)
        }, 250)
      }
    )
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

  handle('workspace:refresh', async (): Promise<{ tree: TreeNode[]; environments: EnvFileView[] }> => {
    const { root } = requireWorkspace()
    return { tree: await scanTree(root), environments: await listEnvironments() }
  })

  handle('workspace:saveConfig', async (config: WorkspaceConfig) => {
    const { root } = requireWorkspace()
    await writeConfig(root, config)
    current = { root, config }
    return { config, environments: await listEnvironments() }
  })

  handle('workspace:recent', async () => {
    const state = await loadState()
    // Drop folders that have since been deleted or moved.
    const alive: string[] = []
    for (const root of state.recentWorkspaces) {
      if (await fs.stat(root).then((s) => s.isDirectory()).catch(() => false)) alive.push(root)
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
    await writeRequest(absPath, normalizeRequest(req, path.basename(absPath)))
    return true
  })

  handle('request:create', async (parentDir: string, name?: string) => {
    const { root } = requireWorkspace()
    return createRequest(root, parentDir || root, name)
  })

  handle('request:duplicate', async (absPath: string) => {
    const { root } = requireWorkspace()
    return duplicateRequest(root, absPath)
  })

  handle('folder:create', async (parentDir: string, name?: string) => {
    const { root } = requireWorkspace()
    return createFolder(root, parentDir || root, name)
  })

  handle('node:rename', async (absPath: string, name: string) => {
    const { root } = requireWorkspace()
    return renameNode(root, absPath, name)
  })

  handle('node:move', async (absPath: string, destDir: string) => {
    const { root } = requireWorkspace()
    return moveNode(root, absPath, destDir)
  })

  handle('node:reorder', async (parentDir: string, orderedPaths: string[]) => {
    const { root } = requireWorkspace()
    await reorder(root, parentDir, orderedPaths)
    return true
  })

  handle('node:delete', async (absPath: string) => {
    const { root } = requireWorkspace()
    assertInside(root, absPath)
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
      await writeConfig(root, config)
      current = { root, config }
    }
    return { config, environments: await listEnvironments() }
  })

  handle('env:createFile', async (fileName: string, envName: string) => {
    const { root, config } = requireWorkspace()
    const target = path.resolve(root, fileName)
    assertInside(root, target)
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
    await fs.mkdir(path.dirname(absPath), { recursive: true })
    // Written verbatim - the user is editing the file itself here, so we do
    // not reformat, reorder or re-quote anything.
    await fs.writeFile(absPath, raw, 'utf8')
    return listEnvironments()
  })

  /* -- execution ----------------------------------------------------- */

  handle('exec:send', async (absPath: string, req: FrapRequest): Promise<ExecResult & { runId: string }> => {
    const { root, config } = requireWorkspace()
    assertInside(root, absPath)
    const runId = randomUUID()
    const controller = new AbortController()
    inflight.set(runId, controller)
    try {
      const result = await execute({
        root,
        request: normalizeRequest(req, path.basename(absPath)),
        envPath: await activeEnvPath(),
        settings: config.settings,
        vars: varsFor(root),
        signal: controller.signal
      })
      return { ...result, runId }
    } finally {
      inflight.delete(runId)
    }
  })

  handle('exec:cancel', (runId: string) => {
    inflight.get(runId)?.abort()
    return true
  })

  handle('exec:cancelAll', () => {
    for (const controller of inflight.values()) controller.abort()
    return true
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

  /* -- misc ---------------------------------------------------------- */

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
