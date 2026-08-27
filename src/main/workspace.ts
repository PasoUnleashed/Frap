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
  FORMAT_VERSION,
  FOLDER_META,
  REQUEST_EXT,
  WORKSPACE_FILE,
  type Auth,
  type FolderMeta,
  type FolderScope,
  type FrapRequest,
  type InheritFlags,
  type KeyValue,
  type RequestBody,
  type TreeNode,
  type Workspace,
  type WorkspaceConfig
} from '../shared/types.ts'
import { migrateDocument } from './migrate.ts'

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

/**
 * `inherit` is the default: a request with no auth of its own picks up
 * whatever the nearest folder provides, and `none` explicitly opts out.
 */
function normalizeAuth(input: unknown, fallback: Auth['type'] = 'inherit'): Auth {
  const a = (input ?? {}) as Auth
  const type = a.type ?? fallback
  switch (type) {
    case 'bearer':
      return { type, token: a.token ?? '' }
    case 'basic':
      return { type, username: a.username ?? '', password: a.password ?? '' }
    case 'apikey':
      return { type, key: a.key ?? '', value: a.value ?? '', in: a.in ?? 'header' }
    case 'none':
      return { type: 'none' }
    default:
      return { type: 'inherit' }
  }
}

/** Everything is inherited unless the file says otherwise. */
function normalizeInherit(input: unknown): InheritFlags {
  const i = (input ?? {}) as Partial<InheritFlags>
  return {
    headers: i.headers !== false,
    auth: i.auth !== false,
    preRequest: i.preRequest !== false,
    postResponse: i.postResponse !== false
  }
}

/** True when nothing is blocked, which is the default and so is not written. */
export function inheritsEverything(flags: InheritFlags): boolean {
  return (
    flags.headers && flags.auth && flags.preRequest && flags.postResponse
  )
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
    frap: FORMAT_VERSION,
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
    inherit: normalizeInherit(input.inherit),
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
    frap: FORMAT_VERSION,
    id: req.id,
    name: req.name,
    order: req.order,
    method: req.method,
    url: req.url
  }
  if (req.params.length) out.params = req.params
  if (req.headers.length) out.headers = req.headers
  if (req.auth.type !== 'inherit') out.auth = req.auth
  if (req.body.mode !== 'none') out.body = req.body
  if (req.scripts.preRequest || req.scripts.postResponse) {
    const scripts: Record<string, string> = {}
    if (req.scripts.preRequest) scripts.preRequest = req.scripts.preRequest
    if (req.scripts.postResponse) scripts.postResponse = req.scripts.postResponse
    out.scripts = scripts
  }
  if (!inheritsEverything(req.inherit)) out.inherit = req.inherit
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

/** The folder equivalent of `uniquePath`. */
async function uniqueDir(parentDir: string, base: string): Promise<string> {
  let candidate = path.join(parentDir, base)
  let n = 2
  for (;;) {
    try {
      await fs.access(candidate)
      candidate = path.join(parentDir, `${base} ${n++}`)
    } catch {
      return candidate
    }
  }
}

/* ------------------------------------------------------------------ */
/* Reading the tree                                                    */
/* ------------------------------------------------------------------ */

/** Fills in defaults, so a folder file written by hand still loads. */
export function normalizeFolderMeta(input: Partial<FolderMeta>): FolderMeta {
  return {
    frap: FORMAT_VERSION,
    ...(input.id ? { id: input.id } : {}),
    order: Number.isFinite(input.order) ? Number(input.order) : 0,
    headers: normalizeKeyValues(input.headers),
    // A folder contributes nothing unless it says otherwise, so its default
    // is `inherit` too - which for the outermost folder means "no auth".
    auth: normalizeAuth(input.auth),
    scripts: {
      preRequest: input.scripts?.preRequest ?? '',
      postResponse: input.scripts?.postResponse ?? ''
    },
    inherit: normalizeInherit(input.inherit),
    ...(input.docs ? { docs: input.docs } : {})
  }
}

/** Fixed key order and no empty sections, exactly like a request file. */
export function serializeFolderMeta(meta: FolderMeta): string {
  const out: Record<string, unknown> = { frap: FORMAT_VERSION, order: meta.order }
  if (meta.id) out.id = meta.id
  if (meta.headers.length) out.headers = meta.headers
  if (meta.auth.type !== 'inherit') out.auth = meta.auth
  if (meta.scripts.preRequest || meta.scripts.postResponse) {
    const scripts: Record<string, string> = {}
    if (meta.scripts.preRequest) scripts.preRequest = meta.scripts.preRequest
    if (meta.scripts.postResponse) scripts.postResponse = meta.scripts.postResponse
    out.scripts = scripts
  }
  if (!inheritsEverything(meta.inherit)) out.inherit = meta.inherit
  if (meta.docs) out.docs = meta.docs
  return toJson(out)
}

/** True when a folder file carries nothing worth keeping on disk. */
export function isEmptyFolderMeta(meta: FolderMeta): boolean {
  return (
    meta.order === 0 &&
    meta.headers.length === 0 &&
    meta.auth.type === 'inherit' &&
    !meta.scripts.preRequest &&
    !meta.scripts.postResponse &&
    inheritsEverything(meta.inherit) &&
    !meta.docs
  )
}

export async function readFolderMeta(dir: string): Promise<FolderMeta | null> {
  const file = path.join(dir, FOLDER_META)
  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch {
    return null
  }
  // A malformed folder file must not take the whole tree down with it, but a
  // file from a newer Frap is a real problem the user needs to hear about.
  const { doc } = migrateDocument('folder', JSON.parse(raw), file)
  return normalizeFolderMeta(doc as Partial<FolderMeta>)
}

export async function writeFolderMeta(dir: string, meta: FolderMeta): Promise<void> {
  const file = path.join(dir, FOLDER_META)
  // Settings that say nothing leave no file behind, so an empty folder does
  // not gain a file in git just because its settings panel was opened.
  if (isEmptyFolderMeta(meta)) {
    await fs.rm(file, { force: true })
    return
  }
  const next = serializeFolderMeta(meta)
  const current = await fs.readFile(file, 'utf8').catch(() => null)
  if (current === next) return
  await fs.writeFile(file, next, 'utf8')
}

/**
 * Every folder from the workspace root down to `dir`, outermost first, with
 * the settings each one contributes.
 *
 * The root itself counts: a `_folder.frap.json` beside `frap.workspace.json`
 * is how collection-wide headers, auth and scripts are expressed.
 */
export async function folderChain(
  root: string,
  dir: string,
  /**
   * Settings being edited but not yet saved, keyed by folder path.
   *
   * A folder tab that is open and dirty should affect what you send, the same
   * way an unsaved request does - otherwise you would have to save before you
   * could test a change. An override also inserts a folder that has no file
   * on disk yet, which is exactly the case when you are adding its first
   * header.
   */
  overrides?: Map<string, FolderMeta>
): Promise<FolderScope[]> {
  assertInside(root, dir)
  const segments = path
    .relative(root, path.resolve(dir))
    .split(path.sep)
    .filter((part) => part && part !== '.')

  const chain: FolderScope[] = []
  let current = path.resolve(root)
  for (let depth = 0; depth <= segments.length; depth++) {
    if (depth > 0) current = path.join(current, segments[depth - 1])
    const meta = overrides?.get(current) ?? (await readFolderMeta(current).catch(() => null))
    if (!meta) continue
    chain.push({
      relPath: toRel(root, current),
      name: depth === 0 ? 'Collection' : segments[depth - 1],
      meta
    })
  }
  return chain
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
      const meta = await readFolderMeta(abs).catch(() => null)
      nodes.push({
        kind: 'folder',
        name: entry.name,
        path: abs,
        relPath: toRel(root, abs),
        order: meta?.order ?? 0,
        // Folder settings are invisible otherwise: nothing in the tree would
        // hint that requests below are picking up headers or auth.
        ...(meta && !isEmptyFolderMeta({ ...meta, order: 0 }) ? { hasSettings: true } : {}),
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
    frap: FORMAT_VERSION,
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
  const { doc } = migrateDocument('request', JSON.parse(raw), absPath)
  const req = normalizeRequest(doc as Partial<FrapRequest>, displayName(path.basename(absPath)))
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

/** One past the highest `order` already used in a folder. */
async function nextOrder(root: string, parentDir: string): Promise<number> {
  const siblings = await scanTree(root, parentDir)
  return siblings.reduce((m, n) => Math.max(m, n.order), 0) + 1
}

/**
 * Writes a request object into `parentDir` under a file name that is free,
 * giving it a fresh id and a position at the end of the folder.
 *
 * Shared by everything that materialises a request that did not exist before:
 * a cURL import, a paste, a copy.
 */
export async function writeNewRequest(
  root: string,
  parentDir: string,
  request: FrapRequest
): Promise<string> {
  assertInside(root, parentDir)
  await fs.mkdir(parentDir, { recursive: true })
  const target = await uniquePath(parentDir, sanitizeName(request.name), REQUEST_EXT)
  const req: FrapRequest = {
    ...request,
    id: randomUUID(),
    // The file name is the source of truth, so the two must agree.
    name: displayName(path.basename(target)),
    order: await nextOrder(root, parentDir)
  }
  await fs.writeFile(target, serializeRequest(req), 'utf8')
  return target
}

export async function createRequest(
  root: string,
  parentDir: string,
  name = 'New Request'
): Promise<string> {
  return writeNewRequest(root, parentDir, normalizeRequest({ name, method: 'GET', url: '' }, name))
}

export async function createFolder(
  root: string,
  parentDir: string,
  name = 'New Folder'
): Promise<string> {
  assertInside(root, parentDir)
  const target = await uniqueDir(parentDir, sanitizeName(name))
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

/**
 * Copies a folder, giving every request inside it a fresh id.
 *
 * Written out rather than using `fs.cp` because the ids have to change on the
 * way through: two files claiming the same id would make history and test
 * results ambiguous. Anything that is not a request (a `_folder.frap.json`,
 * a fixture a multipart body points at) is copied verbatim.
 */
async function copyTree(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true })
  for (const entry of await fs.readdir(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      await copyTree(src, dst)
    } else if (isRequestFile(entry.name) && entry.name !== FOLDER_META) {
      const req = await readRequest(src).catch(() => null)
      if (!req) {
        // Unparseable, but still the user's file: keep it as-is.
        await fs.copyFile(src, dst)
        continue
      }
      req.id = randomUUID()
      await fs.writeFile(dst, serializeRequest(req), 'utf8')
    } else if (entry.isFile()) {
      await fs.copyFile(src, dst)
    }
  }
}

/** Copies a request or a whole folder into `destDir`, resolving name clashes. */
export async function copyNode(root: string, absPath: string, destDir: string): Promise<string> {
  assertInside(root, absPath)
  assertInside(root, destDir)
  await fs.mkdir(destDir, { recursive: true })

  const base = path.basename(absPath)

  if (isRequestFile(base)) {
    const request = await readRequest(absPath)
    return writeNewRequest(root, destDir, request)
  }

  const from = path.resolve(absPath)
  const into = path.resolve(destDir)
  if (into === from || into.startsWith(from + path.sep)) {
    throw new Error('Cannot copy a folder into itself')
  }
  const target = await uniqueDir(destDir, base)
  await copyTree(absPath, target)
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
        const existing = (await readFolderMeta(abs)) ?? normalizeFolderMeta({})
        await writeFolderMeta(abs, { ...existing, order: index + 1 })
      }
    })
  )
}
