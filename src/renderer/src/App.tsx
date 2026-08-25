import { useCallback, useEffect, useRef, useState, type JSX, type MouseEvent } from 'react'
import { WELCOME_TAB } from '@shared/types'
import { api, type MenuItem } from './api'
import { EnvironmentsDialog } from './components/EnvironmentsDialog'
import { ImportCurlDialog } from './components/ImportCurlDialog'
import { RequestPane } from './components/RequestPane'
import { ResponsePane } from './components/ResponsePane'
import { ScriptingHelp } from './components/ScriptingHelp'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { VariableInput } from './components/VariableInput'
import { Welcome } from './components/Welcome'
import { isDirty, useStore, type TabState } from './store'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
const isMac = api.platform === 'darwin'

/* ------------------------------------------------------------------ */
/* Title bar                                                           */
/* ------------------------------------------------------------------ */

/**
 * Windows and Linux get the app's own window buttons; macOS keeps its native
 * traffic lights, which are inset into this same bar by the main process.
 */
function WindowControls(): JSX.Element | null {
  const [maximized, setMaximized] = useState(false)

  useEffect(() => {
    void api.window.isMaximized().then(setMaximized)
    return api.on('window:maximized', (value) => setMaximized(Boolean(value)))
  }, [])

  if (isMac) return null

  return (
    <div className="window-controls">
      <button className="win-btn" title="Minimise" onClick={() => void api.window.minimize()}>
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        className="win-btn"
        title={maximized ? 'Restore' : 'Maximise'}
        onClick={() => void api.window.toggleMaximize().then(setMaximized)}
      >
        {maximized ? (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="2.5" width="7" height="7" fill="none" stroke="currentColor" />
            <path d="M2.5 2.5V0.5H9.5V7.5H7.5" fill="none" stroke="currentColor" />
          </svg>
        ) : (
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor" />
          </svg>
        )}
      </button>
      <button
        className="win-btn close"
        title="Close"
        onClick={() => void api.window.close()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0L10 10M10 0L0 10" stroke="currentColor" fill="none" />
        </svg>
      </button>
    </div>
  )
}

/**
 * The app mark, drawn rather than loaded so it stays sharp at any size and on
 * any display. The geometry and colours mirror `scripts/make-icon.mjs`, which
 * generates the icon the packaged app ships with.
 */
function BrandMark(): JSX.Element {
  return (
    <svg
      className="brand-mark"
      viewBox="0 0 100 100"
      role="img"
      aria-label="Frap"
      focusable="false"
    >
      <defs>
        <linearGradient id="frap-mark" x1="0" y1="0" x2="100" y2="100" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#335cd6" />
          <stop offset="1" stopColor="#8b53f7" />
        </linearGradient>
      </defs>
      <rect width="100" height="100" rx="22.5" fill="url(#frap-mark)" />
      {/* The F: stem, top arm, middle arm. */}
      <rect x="28.5" y="27" width="10" height="46" rx="4.5" fill="#fff" />
      <rect x="28.5" y="26.5" width="43" height="10" rx="4.5" fill="#fff" />
      <rect x="28.5" y="45.25" width="34" height="9.5" rx="4.3" fill="#fff" />
    </svg>
  )
}

/* ------------------------------------------------------------------ */
/* Workspace switcher                                                  */
/* ------------------------------------------------------------------ */

/** How many recent workspaces the chip offers. */
const RECENT_IN_SWITCHER = 5

/**
 * The chip in the title bar doubles as a workspace switcher: it names the
 * collection you are in, and drops down the handful you were in before.
 */
function WorkspaceChip(): JSX.Element {
  const { state, actions } = useStore()
  const chipRef = useRef<HTMLButtonElement | null>(null)

  const openMenu = async (): Promise<void> => {
    const recent = state.recent.slice(0, RECENT_IN_SWITCHER)

    // Two workspaces can easily share a name - every repo with an `api`
    // folder. Only those get the parent folder appended to tell them apart;
    // the full path would blow the menu out to the width of the screen.
    const seen = new Map<string, number>()
    for (const entry of recent) seen.set(entry.name, (seen.get(entry.name) ?? 0) + 1)

    const items: MenuItem[] = recent.map((entry, index) => {
      const parent = entry.root.split(/[\\/]/).filter(Boolean).at(-2)
      const ambiguous = (seen.get(entry.name) ?? 0) > 1
      return {
        id: `recent:${index}`,
        type: 'checkbox' as const,
        checked: entry.root === state.root,
        label: ambiguous && parent ? `${entry.name}  —  ${parent}` : entry.name
      }
    })

    if (items.length) items.push({ type: 'separator' })
    items.push({ id: 'open', label: 'Open Folder…', accelerator: 'CmdOrCtrl+O' })

    // Hang the menu off the chip rather than the mouse pointer.
    const box = chipRef.current?.getBoundingClientRect()
    const choice = await api.contextMenu(
      items,
      box ? { x: box.left, y: box.bottom } : undefined
    )

    if (choice === null) return
    if (choice === 'open') {
      void actions.pickAndOpen()
      return
    }
    const picked = recent[Number(choice.slice('recent:'.length))]
    if (picked) void actions.open(picked.root)
  }

  return (
    <button
      ref={chipRef}
      className="workspace-chip"
      onClick={() => void openMenu()}
      title={
        state.root
          ? `${state.root}\nSwitch workspace`
          : 'This collection is not saved to a folder yet'
      }
    >
      <span className="name">{state.config?.name ?? 'Unsaved collection'}</span>
      {state.root && <span className="path">{state.root}</span>}
      <span className="caret">⌄</span>
    </button>
  )
}

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

/** How far an arrow click nudges the strip. */
const TAB_SCROLL_STEP = 220

function TabStrip(): JSX.Element {
  const { state, actions } = useStore()
  const stripRef = useRef<HTMLDivElement | null>(null)

  // Which arrows to show, and how many tabs are off-screen right now.
  const [overflow, setOverflow] = useState({ left: false, right: false, hidden: 0 })

  const measure = useCallback(() => {
    const strip = stripRef.current
    if (!strip) return
    const maxScroll = strip.scrollWidth - strip.clientWidth
    // A sub-pixel remainder is not overflow anyone can see.
    const left = strip.scrollLeft > 1
    const right = strip.scrollLeft < maxScroll - 1

    let hidden = 0
    if (left || right) {
      const view = strip.getBoundingClientRect()
      for (const child of strip.children) {
        const box = child.getBoundingClientRect()
        if (box.left < view.left - 1 || box.right > view.right + 1) hidden++
      }
    }
    setOverflow((prev) =>
      prev.left === left && prev.right === right && prev.hidden === hidden
        ? prev
        : { left, right, hidden }
    )
  }, [])

  // Re-measure whenever the strip resizes or the set of tabs changes.
  useEffect(() => {
    const strip = stripRef.current
    if (!strip) return
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(strip)
    strip.addEventListener('scroll', measure, { passive: true })
    return () => {
      observer.disconnect()
      strip.removeEventListener('scroll', measure)
    }
  }, [measure, state.tabs.length])

  // Selecting a tab from the tree, a menu or Ctrl+Tab must bring it into view.
  useEffect(() => {
    if (!state.activeTab) return
    stripRef.current
      ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(state.activeTab)}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [state.activeTab, state.tabs.length])

  const nudge = (delta: number): void => {
    stripRef.current?.scrollBy({ left: delta, behavior: 'smooth' })
  }

  /** Lists every open tab, so a hidden one is still one click away. */
  const openOverflowMenu = async (event: MouseEvent): Promise<void> => {
    const items: MenuItem[] = state.tabs.map((tab, index) => ({
      id: String(index),
      type: 'checkbox',
      checked: tab.path === state.activeTab,
      label: `${tab.request.method} ${tab.request.name}${isDirty(tab) ? ' •' : ''}`
    }))
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const choice = await api.contextMenu(items, { x: box.left, y: box.bottom })
    if (choice === null) return
    const tab = state.tabs[Number(choice)]
    if (tab) actions.selectTab(tab.path)
  }

  const onContextMenu = async (event: MouseEvent, tab: TabState): Promise<void> => {
    event.preventDefault()
    const items: MenuItem[] = [
      { id: 'copy-curl', label: 'Copy as cURL', accelerator: 'CmdOrCtrl+Shift+C' },
      { id: 'copy-path', label: 'Copy File Path' },
      { id: 'reveal', label: 'Show in File Manager' },
      { type: 'separator' },
      { id: 'save', label: 'Save', enabled: isDirty(tab), accelerator: 'CmdOrCtrl+S' },
      { type: 'separator' },
      { id: 'close', label: 'Close', accelerator: 'CmdOrCtrl+W' },
      { id: 'close-others', label: 'Close Others', enabled: state.tabs.length > 1 }
    ]
    switch (await api.contextMenu(items)) {
      case 'copy-curl':
        void actions.copyCurl(tab.path)
        break
      case 'copy-path':
        void api.clipboard.write(tab.path)
        actions.toast('success', 'Path copied')
        break
      case 'reveal':
        void api.reveal(tab.path)
        break
      case 'save':
        void actions.save(tab.path)
        break
      case 'close':
        void actions.closeTab(tab.path)
        break
      case 'close-others':
        for (const other of state.tabs) {
          if (other.path !== tab.path) void actions.closeTab(other.path)
        }
        break
      default:
        break
    }
  }

  const overflowing = overflow.left || overflow.right

  return (
    <div className="tabstrip-row">
      {overflowing && (
        <button
          className="tab-nav"
          disabled={!overflow.left}
          title="Scroll tabs left"
          onClick={() => nudge(-TAB_SCROLL_STEP)}
        >
          ‹
        </button>
      )}

      {state.welcomeOpen && (
        <div
          className={`tab welcome-tab${state.activeTab === WELCOME_TAB ? ' active' : ''}`}
          onClick={() => actions.selectTab(WELCOME_TAB)}
          onAuxClick={(e) => e.button === 1 && actions.showWelcome(false)}
          title="Welcome"
        >
          <span className="name">Welcome</span>
          <span
            className="close"
            onClick={(e) => {
              e.stopPropagation()
              actions.showWelcome(false)
            }}
          >
            ×
          </span>
        </div>
      )}

      <div
        className="tabstrip"
        ref={stripRef}
        // There is nothing to scroll vertically here, so a plain wheel
        // gesture moves the strip sideways.
        onWheel={(e) => {
          const strip = stripRef.current
          if (strip && e.deltaY !== 0) strip.scrollLeft += e.deltaY
        }}
      >
        {state.tabs.map((tab) => (
          <div
            key={tab.path}
            data-path={tab.path}
            className={`tab${state.activeTab === tab.path ? ' active' : ''}`}
            onClick={() => actions.selectTab(tab.path)}
            onAuxClick={(e) => e.button === 1 && void actions.closeTab(tab.path)}
            onContextMenu={(e) => void onContextMenu(e, tab)}
            title={tab.path}
          >
            <span className={`method ${tab.request.method.toLowerCase()}`} style={{ width: 'auto' }}>
              {tab.request.method}
            </span>
            <span className="name">{tab.request.name}</span>
            {isDirty(tab) ? (
              <span className="dot" title="Unsaved changes" />
            ) : (
              <span
                className="close"
                onClick={(e) => {
                  e.stopPropagation()
                  void actions.closeTab(tab.path)
                }}
              >
                ×
              </span>
            )}
          </div>
        ))}
      </div>

      {overflowing && (
        <>
          <button
            className="tab-nav"
            disabled={!overflow.right}
            title="Scroll tabs right"
            onClick={() => nudge(TAB_SCROLL_STEP)}
          >
            ›
          </button>
          <button
            className="tab-nav list"
            title={`${state.tabs.length} open tabs`}
            onClick={(e) => void openOverflowMenu(e)}
          >
            ⌄
            {overflow.hidden > 0 && <span className="count">{overflow.hidden}</span>}
          </button>
        </>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* URL bar                                                             */
/* ------------------------------------------------------------------ */

function UrlBar({
  tab,
  urlRef
}: {
  tab: TabState
  urlRef: React.RefObject<HTMLInputElement | null>
}): JSX.Element {
  const { actions } = useStore()
  const dirty = isDirty(tab)

  return (
    <div className="urlbar">
      <select
        className="method-select"
        value={tab.request.method}
        onChange={(e) => actions.patchRequest(tab.path, { method: e.target.value })}
      >
        {METHODS.map((method) => (
          <option key={method} value={method}>
            {method}
          </option>
        ))}
      </select>

      <VariableInput
        inputRef={urlRef}
        className="url"
        placeholder="{{BASE_URL}}/users/{{USER_ID}}"
        value={tab.request.url}
        onChange={(e) => actions.patchRequest(tab.path, { url: e.target.value })}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void actions.send(tab.path)
        }}
      />

      {tab.running ? (
        <button className="send" onClick={() => void actions.cancel(tab.path)}>
          Cancel
        </button>
      ) : (
        <button className="send primary" onClick={() => void actions.send(tab.path)}>
          Send
        </button>
      )}

      <button
        className="ghost"
        title="Copy as cURL, with this environment's values (Ctrl+Shift+C)"
        onClick={() => void actions.copyCurl(tab.path)}
      >
        cURL
      </button>

      <button
        onClick={() => void actions.save(tab.path)}
        disabled={!dirty}
        title="Write this request back to its .frap.json file (Ctrl+S)"
      >
        {dirty ? 'Save' : 'Saved'}
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Resizing                                                            */
/* ------------------------------------------------------------------ */

/**
 * Drag handler shared by both splitters. The final size is written to app
 * data on mouse-up rather than on every frame.
 */
function useDrag(
  measure: (event: MouseEvent | globalThis.MouseEvent, container: HTMLElement) => number,
  onPreview: (value: number) => void,
  onCommit: (value: number) => void
): { dragging: boolean; onMouseDown: (event: MouseEvent) => void } {
  const [dragging, setDragging] = useState(false)

  const onMouseDown = useCallback(
    (event: MouseEvent) => {
      event.preventDefault()
      setDragging(true)
      const container = (event.currentTarget as HTMLElement).parentElement!
      let latest = measure(event, container)

      const move = (e: globalThis.MouseEvent): void => {
        latest = measure(e, container)
        onPreview(latest)
      }
      const up = (): void => {
        setDragging(false)
        onCommit(latest)
        window.removeEventListener('mousemove', move)
        window.removeEventListener('mouseup', up)
      }
      window.addEventListener('mousemove', move)
      window.addEventListener('mouseup', up)
    },
    [measure, onCommit, onPreview]
  )

  return { dragging, onMouseDown }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/* ------------------------------------------------------------------ */
/* Workbench                                                           */
/* ------------------------------------------------------------------ */

function Workbench(): JSX.Element {
  const { state, actions } = useStore()
  const tab = state.tabs.find((t) => t.path === state.activeTab) ?? null
  const urlRef = useRef<HTMLInputElement | null>(null)

  // Live values while dragging; committed to app data on release.
  const [sidebarWidth, setSidebarWidth] = useState(state.layout.sidebarWidth)
  const [responseHeight, setResponseHeight] = useState(state.layout.responseHeight)
  useEffect(() => setSidebarWidth(state.layout.sidebarWidth), [state.layout.sidebarWidth])
  useEffect(() => setResponseHeight(state.layout.responseHeight), [state.layout.responseHeight])

  const sidebarDrag = useDrag(
    (event, container) => clamp(event.clientX - container.getBoundingClientRect().left, 180, 560),
    setSidebarWidth,
    (value) => actions.setLayout({ sidebarWidth: Math.round(value) })
  )

  const responseDrag = useDrag(
    (event, container) => {
      const rect = container.getBoundingClientRect()
      return clamp(((rect.bottom - event.clientY) / rect.height) * 100, 12, 88)
    },
    setResponseHeight,
    (value) => actions.setLayout({ responseHeight: Math.round(value) })
  )

  // Menu accelerators are owned by the main process and arrive as events.
  useEffect(() => {
    const active = (): TabState | null =>
      state.tabs.find((t) => t.path === state.activeTab) ?? null
    const withActive = (fn: (tab: TabState) => void) => () => {
      const current = active()
      if (current) fn(current)
    }
    /** Ctrl+Tab wraps around, so a long strip is still fully reachable. */
    const cycleTab = (step: number): void => {
      if (state.tabs.length < 2) return
      const index = state.tabs.findIndex((t) => t.path === state.activeTab)
      const next = (index + step + state.tabs.length) % state.tabs.length
      actions.selectTab(state.tabs[next].path)
    }
    const unsubscribes = [
      window.frap.on('menu:openWorkspace', () => void actions.pickAndOpen()),
      window.frap.on('menu:newRequest', () =>
        state.root ? void actions.createRequest(state.root) : actions.newDraft()
      ),
      window.frap.on('menu:newFolder', () => state.root && void actions.createFolder(state.root)),
      window.frap.on('menu:importCurl', () => actions.openImportCurl(state.root ?? '')),
      window.frap.on('menu:copyCurl', withActive((t) => void actions.copyCurl(t.path))),
      window.frap.on('menu:save', () => {
        const current = active()
        if (current) void actions.save(current.path)
        else if (!state.root) void actions.saveDrafts()
      }),
      window.frap.on('menu:closeTab', withActive((t) => void actions.closeTab(t.path))),
      window.frap.on(
        'menu:closeOtherTabs',
        withActive((t) => {
          for (const other of state.tabs) {
            if (other.path !== t.path) void actions.closeTab(other.path)
          }
        })
      ),
      window.frap.on('menu:closeAllTabs', () => {
        for (const t of state.tabs) void actions.closeTab(t.path)
      }),
      window.frap.on('menu:nextTab', () => cycleTab(1)),
      window.frap.on('menu:prevTab', () => cycleTab(-1)),
      window.frap.on('menu:send', withActive((t) => void actions.send(t.path))),
      window.frap.on('menu:cancel', withActive((t) => void actions.cancel(t.path))),
      window.frap.on('menu:focusUrl', () => {
        urlRef.current?.focus()
        urlRef.current?.select()
      }),
      window.frap.on('menu:environments', () => actions.toggle('showEnvs')),
      window.frap.on('menu:history', () =>
        actions.setSidebarView(state.sidebarView === 'history' ? 'tree' : 'history')
      ),
      window.frap.on('menu:refresh', () => void actions.refresh()),
      window.frap.on('menu:scriptingHelp', () => actions.toggle('showHelp'))
    ]
    return () => unsubscribes.forEach((off) => off())
  }, [actions, state.activeTab, state.root, state.sidebarView, state.tabs])

  return (
    <div className="workbench" style={{ gridTemplateColumns: `${sidebarWidth}px 4px 1fr` }}>
      <Sidebar />
      <div
        className={`v-splitter${sidebarDrag.dragging ? ' dragging' : ''}`}
        onMouseDown={sidebarDrag.onMouseDown}
      />
      <main className="main">
        <TabStrip />
        {state.activeTab === WELCOME_TAB ? (
          <Welcome />
        ) : tab ? (
          <>
            <UrlBar tab={tab} urlRef={urlRef} />
            <div className="split" style={{ ['--response-height' as string]: `${responseHeight}%` }}>
              <RequestPane tab={tab} />
              <div
                className={`splitter${responseDrag.dragging ? ' dragging' : ''}`}
                onMouseDown={responseDrag.onMouseDown}
              />
              <ResponsePane tab={tab} />
            </div>
          </>
        ) : (
          <div className="empty-hint" style={{ paddingTop: 90 }}>
            No request open.
            <br />
            Pick one on the left, or press <b>Ctrl+N</b> to create one.
          </div>
        )}
      </main>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

export function App(): JSX.Element {
  const { state, actions } = useStore()

  if (state.loading) {
    return (
      <div className="app">
        <div className={`titlebar${isMac ? ' mac' : ''}`}>
          <div className="brand" title="Frap">
            <BrandMark />
          </div>
          <span className="spacer drag-region" />
          <WindowControls />
        </div>
        <div className="welcome">
          <span className="spin" />
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <div className={`titlebar${isMac ? ' mac' : ''}`}>
        <button
          className="ghost menu-button"
          title="Menu"
          onClick={() => void api.appMenu()}
        >
          ☰
        </button>
        <div className="brand" title="Frap">
          <BrandMark />
        </div>

        {/* The chip is always here: without a folder it names the unsaved
            collection, and it is still the way back to a recent one. */}
        <WorkspaceChip />

        <span className="spacer drag-region" />

        {/* Environments and workspace settings are files in the folder, so
            they only exist once there is one. */}
        {state.root && (
          <>
            <select
              className="env-select"
              value={state.activeEnv ?? ''}
              onChange={(e) => void actions.setActiveEnv(e.target.value || null)}
              title="Which .env file scripts read and write"
            >
              <option value="">No environment</option>
              {state.environments.map((env) => (
                <option key={env.name} value={env.name}>
                  {env.name}
                  {env.exists ? '' : ' (missing)'}
                </option>
              ))}
            </select>

            <button
              className="ghost"
              onClick={() => actions.toggle('showEnvs')}
              title="Environments (Ctrl+E)"
            >
              Environments
            </button>
            <button
              className="ghost"
              onClick={() => actions.toggle('showSettings')}
              title="Workspace settings"
            >
              ⚙
            </button>
          </>
        )}

        <button
          className="ghost"
          onClick={() => actions.toggle('showHelp')}
          title="Scripting reference (F1)"
        >
          ?
        </button>

        <WindowControls />
      </div>

      {state.diskChanged && (
        <div className="banner">
          <span>Files in this workspace changed on disk.</span>
          <button className="ghost" onClick={() => void actions.refresh()}>
            Reload
          </button>
          <span className="spacer" />
          <button className="ghost" onClick={() => actions.dismissDiskChanged()}>
            ✕
          </button>
        </div>
      )}

      <Workbench />

      {state.showEnvs && <EnvironmentsDialog />}
      {state.showHelp && <ScriptingHelp />}
      {state.showSettings && <SettingsDialog />}
      {state.importCurlInto !== null && <ImportCurlDialog targetDir={state.importCurlInto} />}

      <div className="toasts">
        {state.toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.kind}`}>
            <span>{toast.message}</span>
            <button onClick={() => actions.dismissToast(toast.id)}>✕</button>
          </div>
        ))}
      </div>
    </div>
  )
}
