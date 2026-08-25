/**
 * Application state. One reducer, one context, actions built on top.
 *
 * Everything the user edits lives here as a `FrapRequest`; disk is written
 * only on an explicit save, so the file on disk is always something the user
 * chose to commit to.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type JSX,
  type ReactNode
} from 'react'
import type {
  EnvFileView,
  ExecResult,
  FrapRequest,
  HistoryEntry,
  TreeNode,
  WorkspaceConfig
} from '@shared/types'
import { api, type LayoutState } from './api'

export type RequestTab = 'params' | 'headers' | 'body' | 'auth' | 'pre' | 'post' | 'docs'
export type ResponseTab = 'body' | 'headers' | 'tests' | 'console' | 'sent'
export type SidebarView = 'tree' | 'history'

export interface TabState {
  path: string
  request: FrapRequest
  /** The last state written to disk, for the dirty indicator. */
  saved: string
  result?: ExecResult
  running: boolean
  runId?: string
  reqTab: RequestTab
  resTab: ResponseTab
}

export interface Toast {
  id: number
  kind: 'info' | 'error' | 'success'
  message: string
}

export interface State {
  root: string | null
  config: WorkspaceConfig | null
  tree: TreeNode[]
  environments: EnvFileView[]
  activeEnv: string | null
  tabs: TabState[]
  activeTab: string | null
  recent: string[]
  loading: boolean
  showEnvs: boolean
  showHelp: boolean
  showSettings: boolean
  /** Folder the import dialog will drop the new request into; null = closed. */
  importCurlInto: string | null
  sidebarView: SidebarView
  history: HistoryEntry[]
  layout: LayoutState
  /** Folders the user collapsed, keyed by absolute path. */
  collapsed: Record<string, boolean>
  toasts: Toast[]
  /** Set when the watcher sees changes we have not pulled in yet. */
  diskChanged: boolean
}

const initialState: State = {
  root: null,
  config: null,
  tree: [],
  environments: [],
  activeEnv: null,
  tabs: [],
  activeTab: null,
  recent: [],
  loading: true,
  showEnvs: false,
  showHelp: false,
  showSettings: false,
  importCurlInto: null,
  sidebarView: 'tree',
  history: [],
  layout: { sidebarWidth: 280, responseHeight: 45 },
  collapsed: {},
  toasts: [],
  diskChanged: false
}

type Action =
  | { type: 'loading'; value: boolean }
  | { type: 'recent'; recent: string[] }
  | {
      type: 'workspace'
      root: string
      config: WorkspaceConfig
      tree: TreeNode[]
      environments: EnvFileView[]
      activeEnv: string | null
    }
  | { type: 'tree'; tree: TreeNode[]; environments: EnvFileView[] }
  | { type: 'environments'; environments: EnvFileView[]; config?: WorkspaceConfig }
  | { type: 'activeEnv'; name: string | null }
  | { type: 'openTab'; tab: TabState }
  | { type: 'closeTab'; path: string }
  | { type: 'activeTab'; path: string | null }
  | { type: 'patchTab'; path: string; patch: Partial<TabState> }
  | { type: 'patchRequest'; path: string; patch: Partial<FrapRequest> }
  | { type: 'retitleTab'; from: string; to: string; name: string }
  | { type: 'toggle'; key: 'showEnvs' | 'showHelp' | 'showSettings'; value?: boolean }
  | { type: 'importCurlInto'; dir: string | null }
  | { type: 'sidebarView'; view: SidebarView }
  | { type: 'history'; history: HistoryEntry[] }
  | { type: 'layout'; layout: LayoutState }
  | { type: 'collapsed'; collapsed: Record<string, boolean> }
  | { type: 'toast'; toast: Toast }
  | { type: 'dismissToast'; id: number }
  | { type: 'diskChanged'; value: boolean }

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'loading':
      return { ...state, loading: action.value }
    case 'recent':
      return { ...state, recent: action.recent }
    case 'workspace':
      return {
        ...state,
        root: action.root,
        config: action.config,
        tree: action.tree,
        environments: action.environments,
        activeEnv: action.activeEnv,
        tabs: [],
        activeTab: null,
        loading: false,
        diskChanged: false
      }
    case 'tree':
      return { ...state, tree: action.tree, environments: action.environments, diskChanged: false }
    case 'environments':
      return {
        ...state,
        environments: action.environments,
        config: action.config ?? state.config
      }
    case 'activeEnv':
      return { ...state, activeEnv: action.name }
    case 'openTab': {
      const exists = state.tabs.some((t) => t.path === action.tab.path)
      return {
        ...state,
        tabs: exists ? state.tabs : [...state.tabs, action.tab],
        activeTab: action.tab.path
      }
    }
    case 'closeTab': {
      const tabs = state.tabs.filter((t) => t.path !== action.path)
      let activeTab = state.activeTab
      if (activeTab === action.path) {
        const index = state.tabs.findIndex((t) => t.path === action.path)
        activeTab = tabs[Math.min(index, tabs.length - 1)]?.path ?? null
      }
      return { ...state, tabs, activeTab }
    }
    case 'activeTab':
      return { ...state, activeTab: action.path }
    case 'patchTab':
      return {
        ...state,
        tabs: state.tabs.map((t) => (t.path === action.path ? { ...t, ...action.patch } : t))
      }
    case 'patchRequest':
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.path === action.path ? { ...t, request: { ...t.request, ...action.patch } } : t
        )
      }
    case 'retitleTab':
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.path === action.from
            ? { ...t, path: action.to, request: { ...t.request, name: action.name } }
            : t
        ),
        activeTab: state.activeTab === action.from ? action.to : state.activeTab
      }
    case 'toggle':
      return { ...state, [action.key]: action.value ?? !state[action.key] }
    case 'toast':
      return { ...state, toasts: [...state.toasts, action.toast].slice(-4) }
    case 'dismissToast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) }
    case 'importCurlInto':
      return { ...state, importCurlInto: action.dir }
    case 'sidebarView':
      return { ...state, sidebarView: action.view }
    case 'history':
      return { ...state, history: action.history }
    case 'layout':
      return { ...state, layout: action.layout }
    case 'collapsed':
      return { ...state, collapsed: action.collapsed }
    case 'diskChanged':
      return { ...state, diskChanged: action.value }
    default:
      return state
  }
}

export const isDirty = (tab: TabState): boolean => JSON.stringify(tab.request) !== tab.saved

export interface Actions {
  pickAndOpen(): Promise<void>
  open(root: string): Promise<void>
  refresh(): Promise<void>
  openTab(path: string): Promise<void>
  closeTab(path: string, force?: boolean): Promise<void>
  selectTab(path: string): void
  patchRequest(path: string, patch: Partial<FrapRequest>): void
  patchTab(path: string, patch: Partial<TabState>): void
  save(path: string): Promise<void>
  send(path: string): Promise<void>
  cancel(path: string): Promise<void>
  setActiveEnv(name: string | null): Promise<void>
  reloadEnvs(): Promise<void>
  applyEnvResult(result: { config?: WorkspaceConfig; environments: EnvFileView[] }): void
  createRequest(parentDir: string): Promise<void>
  createFolder(parentDir: string): Promise<void>
  rename(path: string, name: string): Promise<void>
  duplicate(path: string): Promise<void>
  remove(path: string, label: string): Promise<void>
  move(path: string, destDir: string): Promise<void>
  saveConfig(config: WorkspaceConfig): Promise<void>
  toggle(key: 'showEnvs' | 'showHelp' | 'showSettings', value?: boolean): void
  toast(kind: Toast['kind'], message: string): void
  dismissToast(id: number): void
  dismissDiskChanged(): void

  /** Copies a request to the clipboard as a cURL command. */
  copyCurl(path: string): Promise<void>
  /** Opens the import dialog, targeting `dir`; pass null to close it. */
  openImportCurl(dir: string | null): void
  importCurl(dir: string, text: string, substitute: boolean, name?: string): Promise<void>

  setSidebarView(view: SidebarView): void
  refreshHistory(): Promise<void>
  clearHistory(): Promise<void>

  setLayout(patch: Partial<LayoutState>): void
  toggleFolder(path: string): void
}

const StoreContext = createContext<{ state: State; actions: Actions } | null>(null)

let toastId = 0

export function StoreProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, initialState)
  // Reducer state is stale inside async callbacks, so keep a live mirror.
  const ref = useRef(state)
  ref.current = state

  const toast = useCallback((kind: Toast['kind'], message: string) => {
    const id = ++toastId
    dispatch({ type: 'toast', toast: { id, kind, message } })
    if (kind !== 'error') setTimeout(() => dispatch({ type: 'dismissToast', id }), 3500)
  }, [])

  const guard = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await fn()
      } catch (err) {
        toast('error', (err as Error).message)
        return undefined
      }
    },
    [toast]
  )

  const refresh = useCallback(async () => {
    if (!ref.current.root) return
    await guard(async () => {
      const { tree, environments } = await api.refresh()
      dispatch({ type: 'tree', tree, environments })
    })
  }, [guard])

  const open = useCallback(
    async (root: string) => {
      dispatch({ type: 'loading', value: true })
      const opened = await guard(() => api.openWorkspace(root))
      if (!opened) {
        dispatch({ type: 'loading', value: false })
        return
      }
      const activeEnv =
        opened.state.activeEnvironment &&
        opened.environments.some((e) => e.name === opened.state.activeEnvironment)
          ? opened.state.activeEnvironment
          : (opened.environments[0]?.name ?? null)

      dispatch({
        type: 'workspace',
        root: opened.root,
        config: opened.config,
        tree: opened.tree,
        environments: opened.environments,
        activeEnv
      })
      if (activeEnv !== opened.state.activeEnvironment) {
        void api.setState({ activeEnvironment: activeEnv })
      }
      const { recent } = await api.recentWorkspaces()
      dispatch({ type: 'recent', recent })

      dispatch({
        type: 'collapsed',
        collapsed: Object.fromEntries((opened.state.collapsedFolders ?? []).map((p) => [p, true]))
      })
      void loadHistory()

      // Reopen whatever was open last time, skipping files that have gone.
      for (const path of opened.state.openTabs ?? []) {
        await openTabInternal(path, false)
      }
      if (opened.state.activeTab) dispatch({ type: 'activeTab', path: opened.state.activeTab })
    },
    // openTabInternal and loadHistory are declared below but only called
    // after render, so their bindings are initialised by then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [guard]
  )

  const loadHistory = useCallback(async () => {
    if (!ref.current.root) return
    try {
      dispatch({ type: 'history', history: await api.listHistory() })
    } catch {
      // History is a convenience; a failure here is not worth a toast.
    }
  }, [])

  const persistTabs = useCallback(() => {
    if (!ref.current.root) return
    void api.setState({
      openTabs: ref.current.tabs.map((t) => t.path),
      activeTab: ref.current.activeTab
    })
  }, [])

  const openTabInternal = useCallback(
    async (path: string, complain = true) => {
      if (ref.current.tabs.some((t) => t.path === path)) {
        dispatch({ type: 'activeTab', path })
        return
      }
      try {
        const request = await api.readRequest(path)
        dispatch({
          type: 'openTab',
          tab: {
            path,
            request,
            saved: JSON.stringify(request),
            running: false,
            reqTab: 'params',
            resTab: 'body'
          }
        })
      } catch (err) {
        if (complain) toast('error', `Could not open ${path}: ${(err as Error).message}`)
      }
    },
    [toast]
  )

  const actions = useMemo<Actions>(
    () => ({
      async pickAndOpen() {
        const picked = await guard(() => api.pickWorkspace())
        if (picked) await open(picked)
      },
      open,
      refresh,
      async openTab(path) {
        await openTabInternal(path)
        setTimeout(persistTabs, 0)
      },
      async closeTab(path, force) {
        const tab = ref.current.tabs.find((t) => t.path === path)
        if (tab && !force && isDirty(tab)) {
          const keep = !window.confirm(
            `"${tab.request.name}" has unsaved changes.\n\nClose without saving?`
          )
          if (keep) return
        }
        dispatch({ type: 'closeTab', path })
        setTimeout(persistTabs, 0)
      },
      selectTab(path) {
        dispatch({ type: 'activeTab', path })
        setTimeout(persistTabs, 0)
      },
      patchRequest(path, patch) {
        dispatch({ type: 'patchRequest', path, patch })
      },
      patchTab(path, patch) {
        dispatch({ type: 'patchTab', path, patch })
      },
      async save(path) {
        const tab = ref.current.tabs.find((t) => t.path === path)
        if (!tab) return
        const ok = await guard(async () => {
          await api.saveRequest(path, tab.request)
          return true
        })
        if (!ok) return
        dispatch({ type: 'patchTab', path, patch: { saved: JSON.stringify(tab.request) } })
        toast('success', `Saved ${tab.request.name}`)
        void refresh()
      },
      async send(path) {
        const tab = ref.current.tabs.find((t) => t.path === path)
        if (!tab || tab.running) return
        dispatch({ type: 'patchTab', path, patch: { running: true } })
        try {
          const result = await api.send(path, tab.request)
          dispatch({
            type: 'patchTab',
            path,
            patch: {
              running: false,
              result,
              runId: undefined,
              resTab: result.tests.length ? 'tests' : 'body'
            }
          })
          void loadHistory()
          // A script may have rewritten the .env file, so pull it back in.
          if (result.envWrites.length) {
            const environments = await api.listEnvs()
            dispatch({ type: 'environments', environments })
          }
        } catch (err) {
          dispatch({
            type: 'patchTab',
            path,
            patch: {
              running: false,
              result: {
                requestId: tab.request.id,
                tests: [],
                logs: [],
                envWrites: [],
                error: (err as Error).message
              }
            }
          })
        }
      },
      async cancel(path) {
        const tab = ref.current.tabs.find((t) => t.path === path)
        if (!tab?.running) return
        await api.cancelAll()
      },
      async setActiveEnv(name) {
        dispatch({ type: 'activeEnv', name })
        await api.setState({ activeEnvironment: name })
      },
      async reloadEnvs() {
        await guard(async () => {
          const environments = await api.listEnvs()
          dispatch({ type: 'environments', environments })
        })
      },
      applyEnvResult(result) {
        dispatch({
          type: 'environments',
          environments: result.environments,
          config: result.config
        })
      },
      async createRequest(parentDir) {
        const created = await guard(() => api.createRequest(parentDir))
        if (!created) return
        await refresh()
        await openTabInternal(created)
        setTimeout(persistTabs, 0)
      },
      async createFolder(parentDir) {
        const name = window.prompt('Folder name', 'New Folder')
        if (name === null) return
        await guard(() => api.createFolder(parentDir, name))
        await refresh()
      },
      async rename(path, name) {
        const next = await guard(() => api.rename(path, name))
        if (!next) return
        if (ref.current.tabs.some((t) => t.path === path)) {
          dispatch({ type: 'retitleTab', from: path, to: next, name })
          setTimeout(persistTabs, 0)
        }
        await refresh()
      },
      async duplicate(path) {
        const created = await guard(() => api.duplicateRequest(path))
        if (!created) return
        await refresh()
        await openTabInternal(created)
      },
      async remove(path, label) {
        if (!window.confirm(`Move "${label}" to the trash?`)) return
        const ok = await guard(() => api.remove(path))
        if (!ok) return
        // Close the tab and any tab underneath a deleted folder.
        for (const tab of ref.current.tabs) {
          if (tab.path === path || tab.path.startsWith(path + '\\') || tab.path.startsWith(path + '/')) {
            dispatch({ type: 'closeTab', path: tab.path })
          }
        }
        setTimeout(persistTabs, 0)
        await refresh()
      },
      async move(path, destDir) {
        const next = await guard(() => api.move(path, destDir))
        if (!next) return
        if (ref.current.tabs.some((t) => t.path === path)) {
          const name = ref.current.tabs.find((t) => t.path === path)!.request.name
          dispatch({ type: 'retitleTab', from: path, to: next, name })
        }
        await refresh()
      },
      async saveConfig(config) {
        const result = await guard(() => api.saveConfig(config))
        if (!result) return
        dispatch({
          type: 'environments',
          environments: result.environments,
          config: result.config
        })
        toast('success', 'Workspace settings saved')
      },
      toggle(key, value) {
        dispatch({ type: 'toggle', key, value })
      },
      toast,
      dismissToast(id) {
        dispatch({ type: 'dismissToast', id })
      },
      dismissDiskChanged() {
        dispatch({ type: 'diskChanged', value: false })
      },

      async copyCurl(path) {
        // Send the in-editor version so unsaved edits are reflected.
        const tab = ref.current.tabs.find((t) => t.path === path)
        const result = await guard(() => api.toCurl(path, tab?.request))
        if (!result) return
        if (result.missing.length) {
          toast(
            'info',
            `Copied. ${result.missing.map((n) => `{{${n}}}`).join(', ')} had no value in this environment.`
          )
        } else {
          toast('success', 'cURL command copied')
        }
      },

      openImportCurl(dir) {
        dispatch({ type: 'importCurlInto', dir })
      },

      async importCurl(dir, text, substitute, name) {
        const result = await guard(() => api.importCurl(dir, text, substitute, name))
        if (!result) return
        dispatch({ type: 'importCurlInto', dir: null })
        await refresh()
        await openTabInternal(result.path)
        setTimeout(persistTabs, 0)
        for (const warning of result.warnings) toast('info', warning)
        toast('success', 'Imported from cURL')
      },

      setSidebarView(view) {
        dispatch({ type: 'sidebarView', view })
        if (view === 'history') void loadHistory()
      },

      refreshHistory: loadHistory,

      async clearHistory() {
        await guard(() => api.clearHistory())
        dispatch({ type: 'history', history: [] })
      },

      setLayout(patch) {
        const layout = { ...ref.current.layout, ...patch }
        dispatch({ type: 'layout', layout })
        // Persisted per machine, so pane sizes survive a restart.
        void api.setLayout(patch)
      },

      toggleFolder(path) {
        const collapsed = { ...ref.current.collapsed, [path]: !ref.current.collapsed[path] }
        dispatch({ type: 'collapsed', collapsed })
        if (ref.current.root) {
          void api.setState({
            collapsedFolders: Object.entries(collapsed)
              .filter(([, isCollapsed]) => isCollapsed)
              .map(([folder]) => folder)
          })
        }
      }
    }),
    [guard, loadHistory, open, openTabInternal, persistTabs, refresh, toast]
  )

  // Boot: reopen the most recent workspace.
  useEffect(() => {
    void (async () => {
      const [{ recent, last }, layout] = await Promise.all([
        api.recentWorkspaces(),
        api.getLayout()
      ])
      dispatch({ type: 'recent', recent })
      dispatch({ type: 'layout', layout })
      if (last && recent.includes(last)) await open(last)
      else dispatch({ type: 'loading', value: false })
    })()
    // Intentionally runs once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The watcher tells us when git or another editor touched the folder.
  useEffect(
    () =>
      api.on('workspace:changed', () => {
        dispatch({ type: 'diskChanged', value: true })
      }),
    []
  )

  const value = useMemo(() => ({ state, actions }), [state, actions])
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>
}

export function useStore(): { state: State; actions: Actions } {
  const ctx = useContext(StoreContext)
  if (!ctx) throw new Error('useStore must be used inside <StoreProvider>')
  return ctx
}

export function useActiveTab(): TabState | null {
  const { state } = useStore()
  return state.tabs.find((t) => t.path === state.activeTab) ?? null
}
