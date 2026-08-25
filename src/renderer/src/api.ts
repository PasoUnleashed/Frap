/**
 * Typed facade over the preload bridge. The preload layer deals in `unknown`
 * so it stays dependency-free; the types are reattached here.
 */
import type {
  EnvFileView,
  ExecResult,
  FrapRequest,
  HistoryEntry,
  TreeNode,
  VariableScope,
  WorkspaceConfig
} from '@shared/types'

export interface WorkspaceState {
  activeEnvironment: string | null
  openTabs: string[]
  activeTab: string | null
  collapsedFolders: string[]
  history: HistoryEntry[]
}

export interface LayoutState {
  sidebarWidth: number
  responseHeight: number
}

/** A native context-menu template. `type: 'separator'` draws a divider. */
export interface MenuItem {
  id?: string
  label?: string
  type?: 'separator' | 'checkbox'
  enabled?: boolean
  accelerator?: string
  /** Ticks a checkbox item - used to mark the current tab in a long list. */
  checked?: boolean
}

export interface OpenedWorkspace {
  root: string
  config: WorkspaceConfig
  tree: TreeNode[]
  state: WorkspaceState
  environments: EnvFileView[]
}

const bridge = window.frap

export const api = {
  pickWorkspace: () => bridge.workspace.pick(),
  openWorkspace: (root: string) => bridge.workspace.open(root) as Promise<OpenedWorkspace>,
  refresh: () =>
    bridge.workspace.refresh() as Promise<{ tree: TreeNode[]; environments: EnvFileView[] }>,
  saveConfig: (config: WorkspaceConfig) =>
    bridge.workspace.saveConfig(config) as Promise<{
      config: WorkspaceConfig
      environments: EnvFileView[]
    }>,
  recentWorkspaces: () => bridge.workspace.recent(),
  forgetWorkspace: (root: string) => bridge.workspace.forget(root),
  reveal: (target: string) => bridge.workspace.reveal(target),

  getState: () => bridge.state.get() as Promise<WorkspaceState>,
  setState: (patch: Partial<WorkspaceState>) => bridge.state.set(patch) as Promise<WorkspaceState>,

  readRequest: (absPath: string) => bridge.requests.read(absPath) as Promise<FrapRequest>,
  saveRequest: (absPath: string, req: FrapRequest) => bridge.requests.save(absPath, req),
  createRequest: (parentDir: string, name?: string) => bridge.requests.create(parentDir, name),
  duplicateRequest: (absPath: string) => bridge.requests.duplicate(absPath),
  /** Materialises a pasted request object as a new file. */
  createRequestFrom: (parentDir: string, request: Partial<FrapRequest>) =>
    bridge.requests.createFrom(parentDir, request),

  /** Copies the request to the clipboard as a runnable cURL command. */
  toCurl: (absPath: string, req?: FrapRequest) => bridge.requests.toCurl(absPath, req),
  parseCurl: (text: string, substitute: boolean) =>
    bridge.curl.parse(text, substitute) as Promise<{ request: FrapRequest; warnings: string[] }>,
  importCurl: (parentDir: string, text: string, substitute: boolean, name?: string) =>
    bridge.curl.import(parentDir, text, substitute, name),

  listHistory: () => bridge.history.list() as Promise<HistoryEntry[]>,
  clearHistory: () => bridge.history.clear(),

  getLayout: () => bridge.layout.get(),
  setLayout: (patch: Partial<LayoutState>) => bridge.layout.set(patch),

  contextMenu: (items: MenuItem[]) => bridge.menu.context(items),
  appMenu: () => bridge.menu.app(),

  window: bridge.window,
  clipboard: bridge.clipboard,

  createFolder: (parentDir: string, name?: string) => bridge.nodes.createFolder(parentDir, name),
  rename: (absPath: string, name: string) => bridge.nodes.rename(absPath, name),
  move: (absPath: string, destDir: string) => bridge.nodes.move(absPath, destDir),
  copyNode: (absPath: string, destDir: string) => bridge.nodes.copy(absPath, destDir),
  reorder: (parentDir: string, ordered: string[]) => bridge.nodes.reorder(parentDir, ordered),
  remove: (absPath: string) => bridge.nodes.remove(absPath),

  listEnvs: () => bridge.env.list() as Promise<EnvFileView[]>,
  addEnv: () =>
    bridge.env.add() as Promise<{ config: WorkspaceConfig; environments: EnvFileView[] } | null>,
  createEnvFile: (fileName: string, envName: string) =>
    bridge.env.createFile(fileName, envName) as Promise<{
      config: WorkspaceConfig
      environments: EnvFileView[]
    }>,
  removeEnv: (name: string) =>
    bridge.env.remove(name) as Promise<{ config: WorkspaceConfig; environments: EnvFileView[] }>,
  setEnvValue: (name: string, key: string, value: string | null) =>
    bridge.env.setValue(name, key, value) as Promise<EnvFileView[]>,
  saveEnvRaw: (name: string, raw: string) => bridge.env.saveRaw(name, raw) as Promise<EnvFileView[]>,

  send: (absPath: string, req: FrapRequest) =>
    bridge.exec.send(absPath, req) as Promise<ExecResult & { runId: string }>,
  cancel: (runId: string) => bridge.exec.cancel(runId),
  cancelAll: () => bridge.exec.cancelAll(),

  /** Everything {{name}} could resolve to right now, with provenance. */
  variableScope: () => bridge.vars.scope() as Promise<VariableScope>,
  listVars: () => bridge.vars.list(),
  clearVars: () => bridge.vars.clear(),

  pickFile: () => bridge.dialog.pickFile(),
  saveFile: (defaultName: string, base64: string) => bridge.dialog.saveFile(defaultName, base64),
  openExternal: (url: string) => bridge.shell.openExternal(url),

  platform: bridge.platform,
  on: bridge.on
}
