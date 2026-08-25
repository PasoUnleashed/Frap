import { useState, type JSX } from 'react'
import type { WorkspaceConfig } from '@shared/types'
import { useStore } from '../store'

const field = { display: 'grid', gridTemplateColumns: '190px 1fr', gap: 12, alignItems: 'center' }

/** Edits `frap.workspace.json`, the one file everyone on the team shares. */
export function SettingsDialog(): JSX.Element {
  const { state, actions } = useStore()
  const [draft, setDraft] = useState<WorkspaceConfig | null>(state.config)

  const close = (): void => actions.toggle('showSettings', false)
  if (!draft) return <></>

  const setSetting = <K extends keyof WorkspaceConfig['settings']>(
    key: K,
    value: WorkspaceConfig['settings'][K]
  ): void => setDraft({ ...draft, settings: { ...draft.settings, [key]: value } })

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" style={{ width: 'min(620px, 100%)' }}>
        <header>
          <h2>Workspace settings</h2>
          <span className="spacer" />
          <button className="ghost" onClick={close}>
            ✕
          </button>
        </header>

        <div className="content" style={{ padding: 18, display: 'grid', gap: 14 }}>
          <div style={field}>
            <label className="dim">Collection name</label>
            <input
              type="text"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </div>

          <div style={field}>
            <label className="dim">Timeout (ms)</label>
            <input
              type="text"
              className="mono"
              value={draft.settings.timeoutMs}
              onChange={(e) => setSetting('timeoutMs', Number(e.target.value) || 0)}
            />
          </div>

          <div style={field}>
            <label className="dim">Max redirects</label>
            <input
              type="text"
              className="mono"
              value={draft.settings.maxRedirects}
              onChange={(e) => setSetting('maxRedirects', Number(e.target.value) || 0)}
            />
          </div>

          <div style={field}>
            <span />
            <label className="check">
              <input
                type="checkbox"
                checked={draft.settings.followRedirects}
                onChange={(e) => setSetting('followRedirects', e.target.checked)}
              />
              Follow redirects
            </label>
          </div>

          <div style={field}>
            <span />
            <label className="check">
              <input
                type="checkbox"
                checked={draft.settings.validateTls}
                onChange={(e) => setSetting('validateTls', e.target.checked)}
              />
              Verify TLS certificates
            </label>
          </div>

          <p className="faint" style={{ lineHeight: 1.7 }}>
            These live in <code className="mono">frap.workspace.json</code> at the root of the
            workspace, so they travel with the collection in git. Which environment you have
            selected and which tabs are open are stored per machine instead, so they never show up
            in a diff.
          </p>
        </div>

        <footer>
          <span className="spacer" />
          <button onClick={close}>Cancel</button>
          <button
            className="primary"
            onClick={async () => {
              await actions.saveConfig(draft)
              close()
            }}
          >
            Save
          </button>
        </footer>
      </div>
    </div>
  )
}
