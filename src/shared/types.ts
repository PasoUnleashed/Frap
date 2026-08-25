/** On-disk + IPC types shared between main, preload and renderer. */

export const FILE_FORMAT = 1
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
  docs?: string
  settings?: RequestSettings
}

/** The contents of a `_folder.frap.json` file. Entirely optional. */
export interface FolderMeta {
  frap: number
  id?: string
  order: number
  docs?: string
  auth?: Auth
  scripts?: Partial<Scripts>
}

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

export interface EnvWrite {
  file: string
  key: string
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
  envWrites: EnvWrite[]
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
