import { useCallback, useEffect, useRef, useState, type JSX } from 'react'
import { EnvironmentsDialog } from './components/EnvironmentsDialog'
import { RequestPane } from './components/RequestPane'
import { ResponsePane } from './components/ResponsePane'
import { ScriptingHelp } from './components/ScriptingHelp'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { Welcome } from './components/Welcome'
import { isDirty, useStore, type TabState } from './store'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']

function TabStrip(): JSX.Element {
  const { state, actions } = useStore()
  return (
    <div className="tabstrip">
      {state.tabs.map((tab) => (
        <div
          key={tab.path}
          className={`tab${state.activeTab === tab.path ? ' active' : ''}`}
          onClick={() => actions.selectTab(tab.path)}
          onAuxClick={(e) => e.button === 1 && void actions.closeTab(tab.path)}
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

function UrlBar({ tab, urlRef }: { tab: TabState; urlRef: React.RefObject<HTMLInputElement | null> }): JSX.Element {
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
        onClick={() => void actions.save(tab.path)}
        disabled={!dirty}
        title="Write this request back to its .frap.json file (Ctrl+S)"
      >
        {dirty ? 'Save' : 'Saved'}
      </button>
    </div>
  )
}

/** Drag-to-resize divider between the request and response panes. */
function useSplitter(): {
  height: number
  onMouseDown: (e: React.MouseEvent) => void
  dragging: boolean
} {
  const [height, setHeight] = useState(45)
  const [dragging, setDragging] = useState(false)

  const onMouseDown = useCallback((event: React.MouseEvent) => {
    event.preventDefault()
    setDragging(true)
    const container = (event.currentTarget as HTMLElement).parentElement!
    const move = (e: MouseEvent): void => {
      const rect = container.getBoundingClientRect()
      const fromBottom = ((rect.bottom - e.clientY) / rect.height) * 100
      setHeight(Math.min(85, Math.max(15, fromBottom)))
    }
    const up = (): void => {
      setDragging(false)
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }, [])

  return { height, onMouseDown, dragging }
}

function Workbench(): JSX.Element {
  const { state, actions } = useStore()
  const tab = state.tabs.find((t) => t.path === state.activeTab) ?? null
  const urlRef = useRef<HTMLInputElement | null>(null)
  const splitter = useSplitter()

  // Menu accelerators are owned by the main process and arrive as events.
  useEffect(() => {
    const active = (): TabState | null =>
      state.tabs.find((t) => t.path === state.activeTab) ?? null
    const unsubscribes = [
      window.frap.on('menu:openWorkspace', () => void actions.pickAndOpen()),
      window.frap.on('menu:newRequest', () => state.root && void actions.createRequest(state.root)),
      window.frap.on('menu:newFolder', () => state.root && void actions.createFolder(state.root)),
      window.frap.on('menu:save', () => {
        const current = active()
        if (current) void actions.save(current.path)
      }),
      window.frap.on('menu:closeTab', () => {
        const current = active()
        if (current) void actions.closeTab(current.path)
      }),
      window.frap.on('menu:send', () => {
        const current = active()
        if (current) void actions.send(current.path)
      }),
      window.frap.on('menu:cancel', () => {
        const current = active()
        if (current) void actions.cancel(current.path)
      }),
      window.frap.on('menu:focusUrl', () => {
        urlRef.current?.focus()
        urlRef.current?.select()
      }),
      window.frap.on('menu:environments', () => actions.toggle('showEnvs')),
      window.frap.on('menu:refresh', () => void actions.refresh()),
      window.frap.on('menu:scriptingHelp', () => actions.toggle('showHelp'))
    ]
    return () => unsubscribes.forEach((off) => off())
  }, [actions, state.activeTab, state.root, state.tabs])

  return (
    <div className="body" style={{ gridTemplateColumns: '280px 1fr' }}>
      <Sidebar />
      <main className="main">
        <TabStrip />
        {tab ? (
          <>
            <UrlBar tab={tab} urlRef={urlRef} />
            <div
              className="split"
              style={{ ['--response-height' as string]: `${splitter.height}%` }}
            >
              <RequestPane tab={tab} />
              <div
                className={`splitter${splitter.dragging ? ' dragging' : ''}`}
                onMouseDown={splitter.onMouseDown}
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

export function App(): JSX.Element {
  const { state, actions } = useStore()

  if (state.loading) {
    return (
      <div className="welcome">
        <span className="spin" />
      </div>
    )
  }

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <span className="logo">F</span>
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

            <span className="spacer" />

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

            <button className="ghost" onClick={() => actions.toggle('showEnvs')} title="Environments (Ctrl+E)">
              Environments
            </button>
            <button className="ghost" onClick={() => actions.toggle('showSettings')} title="Workspace settings">
              ⚙
            </button>
            <button className="ghost" onClick={() => actions.toggle('showHelp')} title="Scripting reference (F1)">
              ?
            </button>
          </>
        ) : (
          <span className="spacer" />
        )}
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
