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
import {
  DRAFT_PREFIX,
  FILE_FORMAT,
  REQUEST_EXT,
  WELCOME_TAB,
  isDraftPath,
  type EnvFileView,
  type ExecResult,
  type FrapRequest,
  type HistoryEntry,
  type RecentWorkspace,
  type TreeNode,
  type VariableScope,
  type WorkspaceConfig
} from '@shared/types'
import { api, type LayoutState } from './api'

/** Display label for a path: the file name without Frap's extension. */
const labelOf = (target: string): string => {
  const base = target.split(/[\\/]/).pop() ?? target
  return base.endsWith(REQUEST_EXT) ? base.slice(0, -REQUEST_EXT.length) : base
}

/**
 * A request that exists only in memory. Main normalises whatever it is given
 * when the collection is saved, so this only has to be complete enough to
 * edit and send.
 */
function blankRequest(name = 'New Request'): FrapRequest {
  return {
    frap: FILE_FORMAT,
    id: crypto.randomUUID(),
    name,
    order: 0,
    method: 'GET',
    url: '',
    params: [],
    headers: [],
    auth: { type: 'none' },
    body: { mode: 'none' },
    scripts: { preRequest: '', postResponse: '' }
  }
}

export type RequestTab = 'params' | 'headers' | 'body' | 'auth' | 'pre' | 'post' | 'docs'
export type ResponseTab = 'body' | 'headers' | 'tests' | 'console' | 'sent'
export type SidebarView = 'tree' | 'history'

/** What Ctrl+C / Ctrl+X put aside for the next Ctrl+V. */
export interface NodeClip {
  path: string
  mode: 'copy' | 'cut'
}

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

/** A fresh draft: no file behind it, so it counts as unsaved from birth. */
function newDraftTab(name?: string): TabState {
  const request = blankRequest(name)
  return {
    path: DRAFT_PREFIX + request.id,
    request,
    // Never equals the serialised request, so a draft is always dirty.
    saved: '',
    running: false,
    reqTab: 'params',
    resTab: 'body'
  }
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
  recent: RecentWorkspace[]
  loading: boolean
  showEnvs: boolean
  showHelp: boolean
  showSettings: boolean
  /** The Welcome tab, which sits alongside the request tabs. */
  welcomeOpen: boolean
  /** Folder the import dialog will drop the new request into; null = closed. */
  importCurlInto: string | null
  sidebarView: SidebarView
  history: HistoryEntry[]
  /** Resolved {{variables}}, for chips and hover cards. */
  variables: VariableScope
  layout: LayoutState
  /** Folders the user collapsed, keyed by absolute path. */
  collapsed: Record<string, boolean>
  /** The tree row the keyboard acts on. Independent of which tab is open. */
  selected: string | null
  /** Tree row being renamed in place; null when none is. */
  renaming: string | null
  /** Cut/copy buffer for tree nodes, cleared once a cut has been pasted. */
  clip: NodeClip | null
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
  welcomeOpen: false,
  importCurlInto: null,
  sidebarView: 'tree',
  history: [],
  variables: {},
  layout: { sidebarWidth: 280, responseHeight: 45 },
  collapsed: {},
  selected: null,
  renaming: null,
  clip: null,
  toasts: [],
  diskChanged: false
}

type Action =
  | { type: 'loading'; value: boolean }
  | { type: 'recent'; recent: RecentWorkspace[] }
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
  | { type: 'welcome'; open: boolean }
  | { type: 'importCurlInto'; dir: string | null }
  | { type: 'sidebarView'; view: SidebarView }
  | { type: 'history'; history: HistoryEntry[] }
  | { type: 'variables'; variables: VariableScope }
  | { type: 'layout'; layout: LayoutState }
  | { type: 'collapsed'; collapsed: Record<string, boolean> }
  | { type: 'selected'; path: string | null }
  | { type: 'renaming'; path: string | null }
  | { type: 'clip'; clip: NodeClip | null }
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
        activeTab: state.welcomeOpen ? WELCOME_TAB : null,
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
    case 'welcome': {
      if (action.open) return { ...state, welcomeOpen: true, activeTab: WELCOME_TAB }
      // Closing the active Welcome tab falls back to the first request tab.
      const activeTab = state.activeTab === WELCOME_TAB ? (state.tabs[0]?.path ?? null) : state.activeTab
      return { ...state, welcomeOpen: false, activeTab }
    }
    case 'importCurlInto':
      return { ...state, importCurlInto: action.dir }
    case 'sidebarView':
      return { ...state, sidebarView: action.view }
    case 'history':
      return { ...state, history: action.history }
    case 'variables':
      return { ...state, variables: action.variables }
    case 'layout':
      return { ...state, layout: action.layout }
    case 'collapsed':
      return { ...state, collapsed: action.collapsed }
    case 'selected':
      return { ...state, selected: action.path }
    case 'renaming':
      return { ...state, renaming: action.path }
    case 'clip':
      return { ...state, clip: action.clip }
    case 'diskChanged':
      return { ...state, diskChanged: action.value }
    default:
      return state
  }
}

export const isDirty = (tab: TabState): boolean => JSON.stringify(tab.request) !== tab.saved

/**
 * Which response tab to open after a send.
 *
 * The body is what you nearly always want to look at. The exception is a
 * response that has none - a 204, a HEAD, an empty 30x - where the body pane
 * would just say "empty" and the headers are the interesting part. Failing
 * tests are still obvious from the count on the Tests tab.
 */
function landingResponseTab(result: ExecResult): ResponseTab {
  return result.response && result.response.size === 0 ? 'headers' : 'body'
}

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
  /** Adds an unsaved request. Only reachable before a folder is chosen. */
  newDraft(): void
  /** Asks for a folder and writes every draft into it. */
  saveDrafts(): Promise<void>
  showWelcome(open: boolean): void
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
  refreshVariables(): Promise<void>
  clearHistory(): Promise<void>

  setLayout(patch: Partial<LayoutState>): void
  toggleFolder(path: string): void
  expandFolder(path: string): void

  /* -- collection tree keyboard ------------------------------------- */

  select(path: string | null): void
  beginRename(path: string | null): void
  /** Ctrl+C: remembers the node, and puts its JSON on the system clipboard. */
  copyNode(path: string): Promise<void>
  /** Ctrl+X: remembers the node to move on the next paste. */
  cutNode(path: string): void
  /** Ctrl+V: pastes the buffer, or whatever the system clipboard holds. */
  paste(destDir: string): Promise<void>
  clearClip(): void
}

/**
 * Recognises a request that was copied out of Frap - either from another
 * window, or straight out of a `.frap.json` file someone sent you.
 */
function asRequestJson(text: string): Partial<FrapRequest> | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const candidate = parsed as Partial<FrapRequest>
  // Either it declares the format, or it has the two fields that make a request.
  if (candidate.frap === 1) return candidate
  if (typeof candidate.method === 'string' && typeof candidate.url === 'string') return candidate
  return null
}

const looksLikeCurl = (text: string): boolean => /^\s*curl[\s\\]/i.test(text)

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
      void loadVariables()
    })
  }, [guard])

  const open = useCallback(
    async (root: string) => {
      if (root === ref.current.root) return

      // Opening a workspace closes every tab, so unsaved edits would vanish
      // without a word. At boot there are no tabs, so this never fires there.
      const dirty = ref.current.tabs.filter(isDirty)
      if (dirty.length) {
        const names = dirty.map((t) => `  • ${t.request.name}`).join('\n')
        const ok = window.confirm(
          `${dirty.length} request${dirty.length === 1 ? ' has' : 's have'} unsaved changes:\n\n` +
            `${names}\n\nSwitch workspace and discard them?`
        )
        if (!ok) return
      }

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
      void loadVariables()

      // Reopen whatever was open last time, skipping files that have gone.
      for (const path of opened.state.openTabs ?? []) {
        await openTabInternal(path, false)
      }
      if (opened.state.activeTab) dispatch({ type: 'activeTab', path: opened.state.activeTab })
    },
    // openTabInternal, loadHistory and loadVariables are declared below but
    // only called after render, so their bindings are initialised by then.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [guard]
  )

  const loadVariables = useCallback(async () => {
    try {
      dispatch({ type: 'variables', variables: await api.variableScope() })
    } catch {
      // Chips simply render as unresolved if this fails.
    }
  }, [])

  const loadHistory = useCallback(async () => {
    try {
      dispatch({ type: 'history', history: await api.listHistory() })
    } catch {
      // History is a convenience; a failure here is not worth a toast.
    }
  }, [])

  const persistTabs = useCallback(() => {
    if (!ref.current.root) return
    void api.setState({
      // Drafts have no path to restore, and Welcome is not a workspace tab.
      openTabs: ref.current.tabs.map((t) => t.path).filter((p) => !isDraftPath(p)),
      activeTab: ref.current.activeTab === WELCOME_TAB ? null : ref.current.activeTab
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

  const setCollapsed = useCallback((folder: string, value: boolean) => {
    const collapsed = { ...ref.current.collapsed }
    if (value) collapsed[folder] = true
    else delete collapsed[folder]
    dispatch({ type: 'collapsed', collapsed })
    if (ref.current.root) {
      void api.setState({ collapsedFolders: Object.keys(collapsed) })
    }
  }, [])

  const importCurlInternal = useCallback(
    async (dir: string, text: string, substitute: boolean, name?: string) => {
      // With no folder there is nothing to write to, so the import becomes
      // another draft rather than a file.
      if (!ref.current.root) {
        const parsed = await guard(() => api.parseCurl(text, substitute))
        if (!parsed) return
        const request = { ...parsed.request, ...(name?.trim() ? { name: name.trim() } : {}) }
        const tab = newDraftTab()
        dispatch({
          type: 'openTab',
          tab: { ...tab, request: { ...request, id: tab.request.id } }
        })
        dispatch({ type: 'importCurlInto', dir: null })
        for (const warning of parsed.warnings) toast('info', warning)
        toast('success', 'Imported from cURL')
        return
      }

      const result = await guard(() => api.importCurl(dir, text, substitute, name))
      if (!result) return
      dispatch({ type: 'importCurlInto', dir: null })
      setCollapsed(dir, false)
      await refresh()
      dispatch({ type: 'selected', path: result.path })
      await openTabInternal(result.path)
      setTimeout(persistTabs, 0)
      for (const warning of result.warnings) toast('info', warning)
      toast('success', 'Imported from cURL')
    },
    [guard, openTabInternal, persistTabs, refresh, setCollapsed, toast]
  )

  /**
   * Gives the unsaved collection a home.
   *
   * Main asks for the folder, writes every draft into it and opens it as a
   * workspace; the drafts are then reopened as the real files they became, so
   * nothing the user was looking at is lost.
   */
  const saveDraftsInternal = useCallback(async () => {
    const drafts = ref.current.tabs.filter((t) => isDraftPath(t.path))
    if (!drafts.length) {
      toast('info', 'Nothing to save yet - create a request first.')
      return
    }
    // Remember which draft was in front, to land back on it afterwards.
    const activeIndex = drafts.findIndex((t) => t.path === ref.current.activeTab)

    const result = await guard(() => api.saveDrafts(drafts.map((t) => t.request)))
    if (!result) return // the folder dialog was cancelled

    dispatch({
      type: 'workspace',
      root: result.root,
      config: result.config,
      tree: result.tree,
      environments: result.environments,
      activeEnv: result.environments[0]?.name ?? null
    })
    const { recent } = await api.recentWorkspaces()
    dispatch({ type: 'recent', recent })
    void loadVariables()
    void loadHistory()

    for (const saved of result.paths) await openTabInternal(saved, false)
    const landing = result.paths[activeIndex >= 0 ? activeIndex : 0]
    if (landing) dispatch({ type: 'activeTab', path: landing })
    setTimeout(persistTabs, 0)
    toast('success', `Collection saved to ${result.root}`)
  }, [guard, loadHistory, loadVariables, openTabInternal, persistTabs, toast])

  /** Shared tail of every paste: reveal the result and select it. */
  const afterPaste = useCallback(
    async (destDir: string, created: string, open: boolean) => {
      // A paste into a collapsed folder would otherwise land out of sight.
      setCollapsed(destDir, false)
      await refresh()
      dispatch({ type: 'selected', path: created })
      if (open && created.endsWith(REQUEST_EXT)) {
        await openTabInternal(created)
        setTimeout(persistTabs, 0)
      }
    },
    [openTabInternal, persistTabs, refresh, setCollapsed]
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
        // Nothing on disk yet: saving means choosing where the collection lives.
        if (isDraftPath(path)) {
          await saveDraftsInternal()
          return
        }
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
              resTab: landingResponseTab(result)
            }
          })
          void loadHistory()
          void loadVariables()
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
        void loadVariables()
      },
      async reloadEnvs() {
        await guard(async () => {
          const environments = await api.listEnvs()
          dispatch({ type: 'environments', environments })
        })
        void loadVariables()
      },
      applyEnvResult(result) {
        dispatch({
          type: 'environments',
          environments: result.environments,
          config: result.config
        })
        void loadVariables()
      },
      async createRequest(parentDir) {
        if (!ref.current.root) {
          dispatch({ type: 'openTab', tab: newDraftTab() })
          return
        }
        const created = await guard(() => api.createRequest(parentDir))
        if (!created) return
        await refresh()
        await openTabInternal(created)
        setTimeout(persistTabs, 0)
      },
      newDraft() {
        dispatch({ type: 'openTab', tab: newDraftTab() })
      },

      saveDrafts: saveDraftsInternal,

      showWelcome(open) {
        dispatch({ type: 'welcome', open })
      },

      async createFolder(parentDir) {
        // No `window.prompt` in Electron, and asking in a modal would be worse
        // than what New Request already does: create it, then rename in place.
        const created = await guard(() => api.createFolder(parentDir, 'New Folder'))
        if (!created) return
        setCollapsed(parentDir, false)
        await refresh()
        dispatch({ type: 'selected', path: created })
        dispatch({ type: 'renaming', path: created })
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

      importCurl: importCurlInternal,

      setSidebarView(view) {
        dispatch({ type: 'sidebarView', view })
        if (view === 'history') void loadHistory()
      },

      refreshHistory: loadHistory,
      refreshVariables: loadVariables,

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
        setCollapsed(path, !ref.current.collapsed[path])
      },

      expandFolder(path) {
        if (ref.current.collapsed[path]) setCollapsed(path, false)
      },

      /* -- collection tree keyboard ----------------------------------- */

      select(path) {
        dispatch({ type: 'selected', path })
      },

      beginRename(path) {
        dispatch({ type: 'renaming', path })
      },

      async copyNode(path) {
        dispatch({ type: 'clip', clip: { path, mode: 'copy' } })
        // Also put the request on the system clipboard, so it can be pasted
        // into another Frap window, a file, or a message to a colleague.
        if (path.endsWith(REQUEST_EXT)) {
          const tab = ref.current.tabs.find((t) => t.path === path)
          const request = tab?.request ?? (await api.readRequest(path).catch(() => null))
          if (request) void api.clipboard.write(JSON.stringify(request, null, 2))
        }
        toast('info', `Copied ${labelOf(path)}`)
      },

      cutNode(path) {
        dispatch({ type: 'clip', clip: { path, mode: 'cut' } })
        toast('info', `Cut ${labelOf(path)} - paste into a folder to move it`)
      },

      clearClip() {
        dispatch({ type: 'clip', clip: null })
      },

      async paste(destDir) {
        const clip = ref.current.clip

        if (clip) {
          if (clip.mode === 'cut') {
            const moved = await guard(() => api.move(clip.path, destDir))
            if (!moved) return
            if (ref.current.tabs.some((t) => t.path === clip.path)) {
              const name = ref.current.tabs.find((t) => t.path === clip.path)!.request.name
              dispatch({ type: 'retitleTab', from: clip.path, to: moved, name })
              setTimeout(persistTabs, 0)
            }
            // A cut can only be pasted once; a copy can be pasted repeatedly.
            dispatch({ type: 'clip', clip: null })
            await afterPaste(destDir, moved, false)
            return
          }

          const copied = await guard(() => api.copyNode(clip.path, destDir))
          if (!copied) return
          await afterPaste(destDir, copied, true)
          return
        }

        // Nothing of ours in hand: fall back to whatever the system clipboard
        // holds, so a request or a cURL command from anywhere else pastes too.
        const text = await api.clipboard.read().catch(() => '')
        const request = asRequestJson(text)
        if (request) {
          const created = await guard(() => api.createRequestFrom(destDir, request))
          if (!created) return
          await afterPaste(destDir, created, true)
          toast('success', 'Pasted request')
          return
        }
        if (looksLikeCurl(text)) {
          await importCurlInternal(destDir, text, true)
          return
        }
        toast('info', 'Nothing to paste. Copy a request first, or a cURL command.')
      }
    }),
    [
      afterPaste,
      guard,
      importCurlInternal,
      loadHistory,
      loadVariables,
      open,
      openTabInternal,
      persistTabs,
      refresh,
      saveDraftsInternal,
      setCollapsed,
      toast
    ]
  )

  // Boot: no folder, ready to work.
  useEffect(() => {
    void (async () => {
      const [{ recent }, layout] = await Promise.all([
        api.recentWorkspaces(),
        api.getLayout()
      ])
      dispatch({ type: 'recent', recent })
      dispatch({ type: 'layout', layout })
      // Frap starts with no folder chosen: you can create requests and send
      // them straight away, and pick where they live when you save. The
      // Welcome tab offers the recent collections for the other case.
      dispatch({ type: 'welcome', open: true })
      dispatch({ type: 'loading', value: false })
    })()
    // Intentionally runs once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Surfaces anything that escaped a handler.
   *
   * A button whose click handler throws does nothing at all, with no hint why
   * - which is exactly how the missing `window.prompt` hid for so long. An
   * error the user can see is one they can report.
   */
  useEffect(() => {
    const onError = (event: ErrorEvent): void => {
      toast('error', event.message || 'Something went wrong')
    }
    const onRejection = (event: PromiseRejectionEvent): void => {
      const reason: unknown = event.reason
      toast('error', reason instanceof Error ? reason.message : String(reason))
    }
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection)
    return () => {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection)
    }
  }, [toast])

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
