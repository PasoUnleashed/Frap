/** On-disk + IPC types shared between main, preload and renderer. */

/**
 * The on-disk format version. Every file Frap writes carries `frap: <n>`.
 *
 * Older files are migrated in memory when they are read, never rewritten on
 * sight: a `git pull` that brings in fifty v1 requests must not turn into a
 * fifty-file diff. A file is only restamped when the user saves it.
 *
 * 1 - the original format.
 * 2 - folders carry headers, auth and scripts; a request's auth defaults to
 *     inheriting them rather than to none.
 */
export const FORMAT_VERSION = 2

/**
 * Tab identifiers for things that are not a file on disk.
 *
 * A collection can be worked on before it has a home: requests start as
 * drafts held in memory, addressed by `draft:<uuid>` rather than a path, and
 * only become files when the collection is saved into a folder.
 */
export const DRAFT_PREFIX = 'draft:'
export const WELCOME_TAB = 'welcome:'
/** A folder's settings, opened as a tab. Suffixed with the folder's path. */
export const FOLDER_TAB_PREFIX = 'folder:'

export const isDraftPath = (target: string): boolean => target.startsWith(DRAFT_PREFIX)
export const isFolderTabPath = (target: string): boolean => target.startsWith(FOLDER_TAB_PREFIX)
/** The folder a `folder:` tab points at. */
export const folderTabPath = (target: string): string => target.slice(FOLDER_TAB_PREFIX.length)
export const REQUEST_EXT = '.frap.json'
export const FOLDER_META = '_folder.frap.json'
export const WORKSPACE_FILE = 'frap.workspace.json'

export type BodyMode = 'none' | 'json' | 'text' | 'xml' | 'urlencoded' | 'form' | 'binary' | 'graphql'

export interface KeyValue {
  enabled: boolean
  key: string
  value: string
  description?: string
}

export interface FormField {
  enabled: boolean
  key: string
  /** 'text' sends the value verbatim, 'file' reads `value` as a path from disk. */
  type: 'text' | 'file'
  value: string
  contentType?: string
}

export interface RequestBody {
  mode: BodyMode
  /** Used by json/text/xml/urlencoded-raw/graphql modes. */
  text?: string
  /** Used by urlencoded mode when edited as key/value pairs. */
  urlencoded?: KeyValue[]
  /** Used by form (multipart) mode. */
  form?: FormField[]
  /** Absolute or workspace-relative path, used by binary mode. */
  filePath?: string
  /** Overrides the Content-Type derived from `mode`. */
  contentType?: string
  /** graphql mode only. */
  graphqlVariables?: string
}

export interface Auth {
  type: 'none' | 'inherit' | 'bearer' | 'basic' | 'apikey'
  token?: string
  username?: string
  password?: string
  key?: string
  value?: string
  in?: 'header' | 'query'
}

export interface Scripts {
  preRequest: string
  postResponse: string
}

/**
 * Which settings a folder or request still takes from the folders above it.
 *
 * Turning one off makes that node a barrier for that property: everything an
 * ancestor contributed is discarded, and resolution starts fresh here. The
 * node's own setting still applies - a folder that blocks inherited headers
 * and defines its own sends only its own.
 */
export interface InheritFlags {
  headers: boolean
  auth: boolean
  preRequest: boolean
  postResponse: boolean
}

export const INHERIT_ALL: InheritFlags = {
  headers: true,
  auth: true,
  preRequest: true,
  postResponse: true
}

/** The four things a folder passes down, in the order the UI shows them. */
export const INHERITABLE: Array<{ key: keyof InheritFlags; label: string }> = [
  { key: 'headers', label: 'headers' },
  { key: 'auth', label: 'auth' },
  { key: 'preRequest', label: 'pre-request scripts' },
  { key: 'postResponse', label: 'tests' }
]

export interface RequestSettings {
  timeoutMs?: number
  followRedirects?: boolean
  maxRedirects?: number
  validateTls?: boolean
}

/** The contents of a single `*.frap.json` file. One request per file = clean merges. */
export interface FrapRequest {
  frap: number
  id: string
  name: string
  order: number
  method: string
  url: string
  params: KeyValue[]
  headers: KeyValue[]
  auth: Auth
  body: RequestBody
  scripts: Scripts
  /** What this request still takes from its folders. */
  inherit: InheritFlags
  docs?: string
  settings?: RequestSettings
}

/**
 * The contents of a `_folder.frap.json` file. Entirely optional.
 *
 * Everything here applies to every request below the folder. The workspace
 * root can have one too, which is how collection-wide settings are expressed
 * - it is just the outermost folder.
 */
export interface FolderMeta {
  frap: number
  id?: string
  order: number
  docs?: string
  /** Added to every request below, unless the request sets the same name. */
  headers: KeyValue[]
  /** Used by requests whose auth is `inherit`. The nearest folder wins. */
  auth: Auth
  /** Run around every request below: outermost first, the request last. */
  scripts: Scripts
  /** What this folder still takes from the folders above it. */
  inherit: InheritFlags
}

/**
 * A folder on the path from the workspace root to a request, with the
 * settings it contributes. Ordered outermost first.
 */
export interface FolderScope {
  /** Relative to the workspace root; empty for the root itself. */
  relPath: string
  /** Display name; "Collection" for the root. */
  name: string
  meta: FolderMeta
}

/**
 * Where a value lives, and what that means for its lifetime.
 *
 * They resolve innermost-first: session beats user, user beats environment.
 * That mirrors how folders work - the nearer, more specific thing wins.
 */
export type StoreKind = 'session' | 'user' | 'environment'

/** Highest priority first, which is the order a lookup walks them. */
export const STORE_PRECEDENCE: StoreKind[] = ['session', 'user', 'environment']

export const STORE_LABEL: Record<StoreKind, string> = {
  session: 'Session',
  user: 'User',
  environment: 'Environment'
}

/** The two stores you can edit directly; the environment is a file. */
export type MapStore = 'session' | 'user'

/** Both editable stores, as the panel shows them. */
export interface StoreSnapshot {
  session: Record<string, string>
  user: Record<string, string>
}

/** Where a `{{variable}}`'s value came from, for the hover card. */
export type VariableSource = StoreKind

export interface VariableInfo {
  value: string
  source: VariableSource
  /** The environment the value was read from, when it came from a file. */
  environment?: string
}

/** Everything `{{name}}` could resolve to right now. */
export type VariableScope = Record<string, VariableInfo>

export interface EnvironmentRef {
  name: string
  /** Path to a `.env` file, relative to the workspace root (or absolute). */
  file: string
}

export interface WorkspaceConfig {
  frap: number
  name: string
  environments: EnvironmentRef[]
  settings: Required<RequestSettings>
}

/** A workspace in the recent list, with the name its config gives it. */
export interface RecentWorkspace {
  root: string
  name: string
}

export type NodeKind = 'folder' | 'request'

export interface TreeNode {
  kind: NodeKind
  /** Display name (file name without extension, or folder name). */
  name: string
  /** Absolute path on disk. */
  path: string
  /** Path relative to the workspace root, POSIX separators. */
  relPath: string
  order: number
  /** Requests only - shown as a badge in the sidebar. */
  method?: string
  /** Folders only - true when the folder contributes headers, auth or scripts. */
  hasSettings?: boolean
  id?: string
  children?: TreeNode[]
}

export interface Workspace {
  root: string
  config: WorkspaceConfig
  tree: TreeNode[]
}

/* ------------------------------------------------------------------ */
/* Environments                                                        */
/* ------------------------------------------------------------------ */

export interface EnvEntryView {
  key: string
  value: string
  /** Inline or preceding comment, shown in the env editor. */
  comment?: string
}

export interface EnvFileView {
  name: string
  file: string
  absPath: string
  exists: boolean
  entries: EnvEntryView[]
  /** The raw file text, so the editor can show/edit it directly. */
  raw: string
  error?: string
}

/* ------------------------------------------------------------------ */
/* Execution                                                           */
/* ------------------------------------------------------------------ */

export interface LogEntry {
  level: 'log' | 'warn' | 'error' | 'info'
  phase: 'pre' | 'post'
  message: string
  time: number
}

export interface TestResult {
  name: string
  passed: boolean
  error?: string
  durationMs: number
}

export interface Timings {
  startedAt: number
  dnsMs?: number
  connectMs?: number
  tlsMs?: number
  firstByteMs?: number
  totalMs: number
}

export interface SentRequestInfo {
  method: string
  url: string
  headers: [string, string][]
  bodyPreview: string
  bodySize: number
}

export interface FrapResponse {
  status: number
  statusText: string
  httpVersion: string
  headers: [string, string][]
  /** UTF-8 decoded body. Empty for binary payloads - use bodyBase64. */
  bodyText: string
  bodyBase64: string
  isBinary: boolean
  size: number
  contentType: string
  finalUrl: string
  redirects: string[]
  timings: Timings
}

/** One value a script wrote, for the "what changed" panel after a send. */
export interface VariableWrite {
  store: StoreKind
  /** The .env file for an environment write; the store's name otherwise. */
  target: string
  key: string
  /** null when the key was removed. */
  value: string | null
}

export interface ExecResult {
  requestId: string
  sent?: SentRequestInfo
  response?: FrapResponse
  error?: string
  /** True when the failure came from a script rather than the network. */
  scriptError?: 'pre' | 'post'
  tests: TestResult[]
  logs: LogEntry[]
  writes: VariableWrite[]
  skipped?: boolean
}

export interface ExecOptions {
  requestPath: string
  request: FrapRequest
  environmentName: string | null
}

export interface HistoryEntry {
  id: string
  at: number
  requestId: string
  name: string
  method: string
  url: string
  status?: number
  timeMs?: number
  error?: string
}
