import { useCallback, useEffect, useRef, useState, type JSX, type MouseEvent } from 'react'
import { api, type MenuItem } from './api'
import { EnvironmentsDialog } from './components/EnvironmentsDialog'
import { ImportCurlDialog } from './components/ImportCurlDialog'
import { RequestPane } from './components/RequestPane'
import { ResponsePane } from './components/ResponsePane'
import { ScriptingHelp } from './components/ScriptingHelp'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
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

/* ------------------------------------------------------------------ */
/* Tabs                                                                */
/* ------------------------------------------------------------------ */

function TabStrip(): JSX.Element {
  const { state, actions } = useStore()

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

  return (
    <div className="tabstrip">
      {state.tabs.map((tab) => (
        <div
          key={tab.path}
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

      <input
        ref={urlRef}
        type="text"
        className="url"
        spellCheck={false}
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
    const unsubscribes = [
      window.frap.on('menu:openWorkspace', () => void actions.pickAndOpen()),
      window.frap.on('menu:newRequest', () => state.root && void actions.createRequest(state.root)),
      window.frap.on('menu:newFolder', () => state.root && void actions.createFolder(state.root)),
      window.frap.on('menu:importCurl', () => state.root && actions.openImportCurl(state.root)),
      window.frap.on('menu:copyCurl', withActive((t) => void actions.copyCurl(t.path))),
      window.frap.on('menu:save', withActive((t) => void actions.save(t.path))),
      window.frap.on('menu:closeTab', withActive((t) => void actions.closeTab(t.path))),
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
        {tab ? (
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
          <div className="brand">
            <span>Frap</span>
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
        <div className="brand">
          <span>Frap</span>
        </div>

        {state.root ? (
          <>
            <div
              className="workspace-chip"
              onClick={() => void actions.pickAndOpen()}
              title={`${state.root}\nClick to open a different folder`}
            >
              <span>{state.config?.name}</span>
              <span className="path">{state.root}</span>
            </div>

            <span className="spacer drag-region" />

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
            <button
              className="ghost"
              onClick={() => actions.toggle('showHelp')}
              title="Scripting reference (F1)"
            >
              ?
            </button>
          </>
        ) : (
          <span className="spacer drag-region" />
        )}

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

      {state.root ? <Workbench /> : <Welcome />}

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
