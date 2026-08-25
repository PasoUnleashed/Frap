/**
 * The on-disk collection store.
 *
 * A workspace is just a folder. Folders are groups, and every `*.frap.json`
 * file is one request. Keeping one request per file is the whole point: git
 * can merge two people editing different requests without a conflict, and a
 * conflict inside one file is a small, readable diff.
 *
 * Files are written with a stable key order and a trailing newline so that
 * saving a request you did not change produces an empty diff.
 */
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import {
  FILE_FORMAT,
  FOLDER_META,
  REQUEST_EXT,
  WORKSPACE_FILE,
  type Auth,
  type FolderMeta,
  type FrapRequest,
  type KeyValue,
  type RequestBody,
  type TreeNode,
  type Workspace,
  type WorkspaceConfig
} from '../shared/types.ts'

const IGNORED_DIRS = new Set(['.git', 'node_modules', '.vscode', '.idea', 'dist', 'out'])

export const DEFAULT_SETTINGS: WorkspaceConfig['settings'] = {
  timeoutMs: 30_000,
  followRedirects: true,
  maxRedirects: 10,
  validateTls: true
}

/* ------------------------------------------------------------------ */
/* Serialisation                                                       */
/* ------------------------------------------------------------------ */

const toJson = (value: unknown): string => JSON.stringify(value, null, 2) + '\n'

function normalizeKeyValues(input: unknown): KeyValue[] {
  if (!Array.isArray(input)) return []
  return input.map((kv) => ({
    enabled: kv?.enabled !== false,
    key: String(kv?.key ?? ''),
    value: String(kv?.value ?? ''),
    ...(kv?.description ? { description: String(kv.description) } : {})
  }))
}

function normalizeAuth(input: unknown): Auth {
  const a = (input ?? {}) as Auth
  const type = a.type ?? 'none'
  switch (type) {
    case 'bearer':
      return { type, token: a.token ?? '' }
    case 'basic':
      return { type, username: a.username ?? '', password: a.password ?? '' }
    case 'apikey':
      return { type, key: a.key ?? '', value: a.value ?? '', in: a.in ?? 'header' }
    case 'inherit':
      return { type }
    default:
      return { type: 'none' }
  }
}

function normalizeBody(input: unknown): RequestBody {
  const b = (input ?? {}) as RequestBody
  const mode = b.mode ?? 'none'
  const out: RequestBody = { mode }
  if (b.text) out.text = b.text
  if (b.urlencoded?.length) out.urlencoded = normalizeKeyValues(b.urlencoded)
  if (b.form?.length) {
    out.form = b.form.map((f) => ({
      enabled: f?.enabled !== false,
      key: String(f?.key ?? ''),
      type: f?.type === 'file' ? 'file' : 'text',
      value: String(f?.value ?? ''),
      ...(f?.contentType ? { contentType: f.contentType } : {})
    }))
  }
  if (b.filePath) out.filePath = b.filePath
  if (b.contentType) out.contentType = b.contentType
  if (b.graphqlVariables) out.graphqlVariables = b.graphqlVariables
  return out
}

/** Fills in defaults so a hand-written or partial file still loads cleanly. */
export function normalizeRequest(input: Partial<FrapRequest>, fallbackName: string): FrapRequest {
  return {
    frap: FILE_FORMAT,
    id: input.id || randomUUID(),
    name: input.name || fallbackName,
    order: Number.isFinite(input.order) ? Number(input.order) : 0,
    method: (input.method || 'GET').toUpperCase(),
    url: input.url ?? '',
    params: normalizeKeyValues(input.params),
    headers: normalizeKeyValues(input.headers),
    auth: normalizeAuth(input.auth),
    body: normalizeBody(input.body),
    scripts: {
      preRequest: input.scripts?.preRequest ?? '',
      postResponse: input.scripts?.postResponse ?? ''
    },
    ...(input.docs ? { docs: input.docs } : {}),
    ...(input.settings && Object.keys(input.settings).length ? { settings: input.settings } : {})
  }
}

/**
 * Emits keys in a fixed order and drops empty optional fields, so the file on
 * disk stays stable and diffs stay small.
 */
export function serializeRequest(req: FrapRequest): string {
  const out: Record<string, unknown> = {
    frap: FILE_FORMAT,
    id: req.id,
    name: req.name,
    order: req.order,
    method: req.method,
    url: req.url
  }
  if (req.params.length) out.params = req.params
  if (req.headers.length) out.headers = req.headers
  if (req.auth.type !== 'none') out.auth = req.auth
  if (req.body.mode !== 'none') out.body = req.body
  if (req.scripts.preRequest || req.scripts.postResponse) {
    const scripts: Record<string, string> = {}
    if (req.scripts.preRequest) scripts.preRequest = req.scripts.preRequest
    if (req.scripts.postResponse) scripts.postResponse = req.scripts.postResponse
    out.scripts = scripts
  }
  if (req.docs) out.docs = req.docs
  if (req.settings && Object.keys(req.settings).length) out.settings = req.settings
  return toJson(out)
}

/* ------------------------------------------------------------------ */
/* Paths                                                               */
/* ------------------------------------------------------------------ */

export const isRequestFile = (name: string): boolean => name.endsWith(REQUEST_EXT)
export const displayName = (fileName: string): string => fileName.slice(0, -REQUEST_EXT.length)

/** Strips characters that are illegal in file names on Windows or POSIX. */
export function sanitizeName(name: string): string {
  const cleaned = name
    // Reserved on Windows; control chars are stripped. Spaces are kept.
    .replace(/[<>:"/\\|?*]/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\.+$/, '')
    .trim()
  return cleaned || 'Untitled'
}

const toRel = (root: string, abs: string): string =>
  path.relative(root, abs).split(path.sep).join('/')

/** Guards every filesystem operation against paths escaping the workspace. */
export function assertInside(root: string, target: string): void {
  const rel = path.relative(root, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Refusing to touch a path outside the workspace: ${target}`)
  }
}

/** Finds a free file name by appending ` 2`, ` 3`, ... */
async function uniquePath(dir: string, base: string, ext: string): Promise<string> {
  let candidate = path.join(dir, base + ext)
  let n = 2
  for (;;) {
    try {
      await fs.access(candidate)
      candidate = path.join(dir, `${base} ${n++}${ext}`)
    } catch {
      return candidate
    }
  }
}

/* ------------------------------------------------------------------ */
/* Reading the tree                                                    */
/* ------------------------------------------------------------------ */

async function readFolderMeta(dir: string): Promise<FolderMeta | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, FOLDER_META), 'utf8')) as FolderMeta
  } catch {
    return null
  }
}

/**
 * Reads just enough of a request file to draw a sidebar row. Broken files
 * still show up (with no method badge) instead of vanishing.
 */
async function readStub(absPath: string): Promise<{ method?: string; id?: string; order: number; name?: string }> {
  try {
    const parsed = JSON.parse(await fs.readFile(absPath, 'utf8'))
    return {
      method: typeof parsed.method === 'string' ? parsed.method.toUpperCase() : 'GET',
      id: typeof parsed.id === 'string' ? parsed.id : undefined,
      order: Number.isFinite(parsed.order) ? Number(parsed.order) : 0,
      name: typeof parsed.name === 'string' ? parsed.name : undefined
    }
  } catch {
    return { order: 0 }
  }
}

const byOrderThenName = (a: TreeNode, b: TreeNode): number => {
  if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1
  if (a.order !== b.order) return a.order - b.order
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
}

export async function scanTree(root: string, dir = root): Promise<TreeNode[]> {
  let dirents: import('node:fs').Dirent[]
  try {
    dirents = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  const nodes: TreeNode[] = []
  for (const entry of dirents) {
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      const meta = await readFolderMeta(abs)
      nodes.push({
        kind: 'folder',
        name: entry.name,
        path: abs,
        relPath: toRel(root, abs),
        order: meta?.order ?? 0,
        children: await scanTree(root, abs)
      })
    } else if (entry.isFile() && isRequestFile(entry.name) && entry.name !== FOLDER_META) {
      const stub = await readStub(abs)
      nodes.push({
        kind: 'request',
        // The file name is the source of truth for the name, so renaming the
        // file in git or an editor does the right thing.
        name: displayName(entry.name),
        path: abs,
        relPath: toRel(root, abs),
        order: stub.order,
        method: stub.method ?? 'GET',
        id: stub.id
      })
    }
  }
  return nodes.sort(byOrderThenName)
}

/* ------------------------------------------------------------------ */
/* Workspace                                                           */
/* ------------------------------------------------------------------ */

function normalizeConfig(input: Partial<WorkspaceConfig>, root: string): WorkspaceConfig {
  return {
    frap: FILE_FORMAT,
    name: input.name || path.basename(root),
    environments: Array.isArray(input.environments)
      ? input.environments
          .filter((e) => e && typeof e.file === 'string')
          .map((e) => ({ name: e.name || path.basename(e.file), file: e.file }))
      : [],
    settings: { ...DEFAULT_SETTINGS, ...(input.settings ?? {}) }
  }
}

export async function readConfig(root: string): Promise<WorkspaceConfig> {
  try {
    const raw = await fs.readFile(path.join(root, WORKSPACE_FILE), 'utf8')
    return normalizeConfig(JSON.parse(raw), root)
  } catch {
    return normalizeConfig({}, root)
  }
}

export async function writeConfig(root: string, config: WorkspaceConfig): Promise<void> {
  await fs.writeFile(path.join(root, WORKSPACE_FILE), toJson(normalizeConfig(config, root)), 'utf8')
}

/** Opens a folder as a workspace, creating the config file if it is missing. */
export async function openWorkspace(root: string): Promise<Workspace> {
  const stat = await fs.stat(root)
  if (!stat.isDirectory()) throw new Error(`Not a folder: ${root}`)

  const configPath = path.join(root, WORKSPACE_FILE)
  let created = false
  try {
    await fs.access(configPath)
  } catch {
    created = true
  }

  const config = await readConfig(root)
  if (created) {
    // Adopt any .env files already sitting in the folder.
    const names = await fs.readdir(root).catch(() => [] as string[])
    config.environments = names
      .filter((n) => n === '.env' || n.startsWith('.env.') || n.endsWith('.env'))
      .sort()
      .map((n) => ({ name: n.replace(/^\.env\.?/, '') || 'default', file: n }))
    await writeConfig(root, config)
  }

  return { root, config, tree: await scanTree(root) }
}

/* ------------------------------------------------------------------ */
/* Request CRUD                                                        */
/* ------------------------------------------------------------------ */

export async function readRequest(absPath: string): Promise<FrapRequest> {
  const raw = await fs.readFile(absPath, 'utf8')
  const parsed = JSON.parse(raw) as Partial<FrapRequest>
  const req = normalizeRequest(parsed, displayName(path.basename(absPath)))
  // The file name always wins, so renaming on disk renames the request.
  req.name = displayName(path.basename(absPath))
  return req
}

export async function writeRequest(absPath: string, req: FrapRequest): Promise<void> {
  await fs.mkdir(path.dirname(absPath), { recursive: true })
  const next = serializeRequest(req)
  // Skip the write when nothing changed, so file watchers and git stay quiet.
  const current = await fs.readFile(absPath, 'utf8').catch(() => null)
  if (current === next) return
  await fs.writeFile(absPath, next, 'utf8')
}

export async function createRequest(
  root: string,
  parentDir: string,
  name = 'New Request'
): Promise<string> {
  assertInside(root, parentDir)
  await fs.mkdir(parentDir, { recursive: true })
  const target = await uniquePath(parentDir, sanitizeName(name), REQUEST_EXT)
  const siblings = await scanTree(root, parentDir)
  const maxOrder = siblings.reduce((m, n) => Math.max(m, n.order), 0)
  const req = normalizeRequest(
    { name: displayName(path.basename(target)), order: maxOrder + 1, method: 'GET', url: '' },
    name
  )
  await fs.writeFile(target, serializeRequest(req), 'utf8')
  return target
}

export async function createFolder(root: string, parentDir: string, name = 'New Folder'): Promise<string> {
  assertInside(root, parentDir)
  let target = path.join(parentDir, sanitizeName(name))
  let n = 2
  for (;;) {
    try {
      await fs.access(target)
      target = path.join(parentDir, `${sanitizeName(name)} ${n++}`)
    } catch {
      break
    }
  }
  await fs.mkdir(target, { recursive: true })
  return target
}

export async function renameNode(root: string, absPath: string, newName: string): Promise<string> {
  assertInside(root, absPath)
  const dir = path.dirname(absPath)
  const isRequest = isRequestFile(absPath)
  const clean = sanitizeName(newName)
  const target = path.join(dir, isRequest ? clean + REQUEST_EXT : clean)
  if (target === absPath) return absPath
  await fs.rename(absPath, target)
  if (isRequest) {
    const req = await readRequest(target)
    req.name = clean
    await writeRequest(target, req)
  }
  return target
}

export async function duplicateRequest(root: string, absPath: string): Promise<string> {
  assertInside(root, absPath)
  const req = await readRequest(absPath)
  const dir = path.dirname(absPath)
  const target = await uniquePath(dir, `${req.name} copy`, REQUEST_EXT)
  req.id = randomUUID()
  req.name = displayName(path.basename(target))
  req.order = req.order + 1
  await fs.writeFile(target, serializeRequest(req), 'utf8')
  return target
}

/** Moves a node into `destDir`, resolving name clashes. */
export async function moveNode(root: string, absPath: string, destDir: string): Promise<string> {
  assertInside(root, absPath)
  assertInside(root, destDir)
  if (path.resolve(destDir).startsWith(path.resolve(absPath) + path.sep)) {
    throw new Error('Cannot move a folder into itself')
  }
  const base = path.basename(absPath)
  let target = path.join(destDir, base)
  if (path.resolve(target) === path.resolve(absPath)) return absPath
  if (isRequestFile(base)) {
    target = await uniquePath(destDir, displayName(base), REQUEST_EXT)
  }
  await fs.rename(absPath, target)
  return target
}

/** Persists sidebar drag-and-drop ordering into each file's `order` field. */
export async function reorder(root: string, parentDir: string, orderedPaths: string[]): Promise<void> {
  assertInside(root, parentDir)
  await Promise.all(
    orderedPaths.map(async (abs, index) => {
      assertInside(root, abs)
      if (isRequestFile(abs)) {
        const req = await readRequest(abs).catch(() => null)
        if (!req) return
        req.order = index + 1
        await writeRequest(abs, req)
      } else {
        const metaPath = path.join(abs, FOLDER_META)
        const existing = (await readFolderMeta(abs)) ?? { frap: FILE_FORMAT, order: 0 }
        await fs.writeFile(metaPath, toJson({ ...existing, frap: FILE_FORMAT, order: index + 1 }), 'utf8')
      }
    })
  )
}
