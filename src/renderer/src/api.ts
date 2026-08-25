/**
 * Typed facade over the preload bridge. The preload layer deals in `unknown`
 * so it stays dependency-free; the types are reattached here.
 */
import type {
  EnvFileView,
  ExecResult,
  FrapRequest,
  TreeNode,
  WorkspaceConfig
} from '@shared/types'

export interface WorkspaceState {
  activeEnvironment: string | null
  openTabs: string[]
  activeTab: string | null
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

  createFolder: (parentDir: string, name?: string) => bridge.nodes.createFolder(parentDir, name),
  rename: (absPath: string, name: string) => bridge.nodes.rename(absPath, name),
  move: (absPath: string, destDir: string) => bridge.nodes.move(absPath, destDir),
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

  listVars: () => bridge.vars.list(),
  clearVars: () => bridge.vars.clear(),

  pickFile: () => bridge.dialog.pickFile(),
  saveFile: (defaultName: string, base64: string) => bridge.dialog.saveFile(defaultName, base64),
  openExternal: (url: string) => bridge.shell.openExternal(url),

  platform: bridge.platform,
  on: bridge.on
}
