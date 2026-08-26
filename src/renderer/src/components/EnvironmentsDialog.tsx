import { useEffect, useState, type JSX } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { CodeEditor } from './CodeEditor'

/** `.env` for the default one, `.env.staging` for the rest. */
const suggestedFile = (name: string): string => {
  const clean = name.trim()
  if (!clean || clean.toLowerCase() === 'local' || clean.toLowerCase() === 'default') return '.env'
  return `.env.${clean}`
}

/**
 * Environments are plain .env files. This panel edits them either as a table
 * or as raw text; both paths go through the comment-preserving writer, so a
 * value change never reformats the rest of the file.
 */
export function EnvironmentsDialog(): JSX.Element {
  const { state, actions } = useStore()
  const [selected, setSelected] = useState<string | null>(state.activeEnv)
  const [mode, setMode] = useState<'table' | 'raw'>('table')
  const [draft, setDraft] = useState<string | null>(null)
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')
  /**
   * The inline "new environment" form. Electron has no `window.prompt`, and a
   * modal on top of a modal to ask for two strings would be worse than asking
   * for them where the list already is.
   */
  const [creating, setCreating] = useState<{ name: string; file: string } | null>(null)

  const env = state.environments.find((e) => e.name === selected) ?? state.environments[0] ?? null

  useEffect(() => {
    // Switching files discards an unsaved raw draft rather than carrying it over.
    setDraft(null)
  }, [env?.name])

  const close = (): void => actions.toggle('showEnvs', false)

  const setValue = async (key: string, value: string | null): Promise<void> => {
    if (!env) return
    try {
      const environments = await api.setEnvValue(env.name, key, value)
      actions.applyEnvResult({ environments })
    } catch (err) {
      actions.toast('error', (err as Error).message)
    }
  }

  const addEntry = async (): Promise<void> => {
    const key = newKey.trim()
    if (!key) return
    await setValue(key, newValue)
    setNewKey('')
    setNewValue('')
  }

  const saveRaw = async (): Promise<void> => {
    if (!env || draft === null) return
    try {
      const environments = await api.saveEnvRaw(env.name, draft)
      actions.applyEnvResult({ environments })
      setDraft(null)
      actions.toast('success', `Saved ${env.file}`)
    } catch (err) {
      actions.toast('error', (err as Error).message)
    }
  }

  /**
   * Adopts the first environment as the active one.
   *
   * Adding an environment to a workspace that had none is always because you
   * want to use it; leaving it inactive means every {{variable}} stays
   * unresolved and the panel looks broken.
   */
  const adoptIfFirst = (name: string): void => {
    if (!state.activeEnv) void actions.setActiveEnv(name)
  }

  const confirmCreate = async (): Promise<void> => {
    if (!creating) return
    const name = creating.name.trim()
    const file = creating.file.trim()
    if (!name || !file) return
    try {
      actions.applyEnvResult(await api.createEnvFile(file, name))
      setSelected(name)
      setCreating(null)
      adoptIfFirst(name)
    } catch (err) {
      actions.toast('error', (err as Error).message)
    }
  }

  const linkFile = async (): Promise<void> => {
    try {
      const result = await api.addEnv()
      if (!result) return
      actions.applyEnvResult(result)
      const added = result.environments[result.environments.length - 1]
      if (added) {
        setSelected(added.name)
        adoptIfFirst(added.name)
      }
    } catch (err) {
      actions.toast('error', (err as Error).message)
    }
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal">
        <header>
          <h2>Environments</h2>
          <span className="faint">Every environment is a .env file you point Frap at.</span>
          <span className="spacer" />
          <button className="ghost" onClick={close}>
            ✕
          </button>
        </header>

        <div className="env-layout">
          <div className="env-list">
            {state.environments.map((item) => (
              <div
                key={item.name}
                className={`item${item.name === env?.name ? ' active' : ''}`}
                onClick={() => setSelected(item.name)}
              >
                <span>
                  {item.name}
                  {item.name === state.activeEnv && <span className="badge ok"> active</span>}
                </span>
                <span className="file">
                  {item.file}
                  {!item.exists && ' (missing)'}
                </span>
              </div>
            ))}
            {creating && (
              <div className="env-new">
                <label>Name</label>
                <input
                  type="text"
                  autoFocus
                  placeholder="local"
                  value={creating.name}
                  onChange={(e) => {
                    const name = e.target.value
                    setCreating((prev) =>
                      prev
                        ? {
                            name,
                            // Keep the file name in step until it is edited by hand.
                            file: prev.file === suggestedFile(prev.name) ? suggestedFile(name) : prev.file
                          }
                        : prev
                    )
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void confirmCreate()
                    if (e.key === 'Escape') setCreating(null)
                  }}
                />
                <label>File</label>
                <input
                  type="text"
                  className="mono"
                  placeholder=".env"
                  value={creating.file}
                  onChange={(e) =>
                    setCreating((prev) => (prev ? { ...prev, file: e.target.value } : prev))
                  }
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void confirmCreate()
                    if (e.key === 'Escape') setCreating(null)
                  }}
                />
                <div className="row">
                  <button className="primary" onClick={() => void confirmCreate()}>
                    Create
                  </button>
                  <button className="ghost" onClick={() => setCreating(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}

            {state.environments.length === 0 && !creating && (
              <div className="faint" style={{ padding: 12, lineHeight: 1.7 }}>
                No environments yet. Create a <code className="mono">.env</code> file or link an
                existing one.
              </div>
            )}
          </div>

          <div className="env-detail">
            {!env ? (
              <div className="empty-hint">Nothing selected.</div>
            ) : (
              <>
                <div className="editor-toolbar">
                  <button
                    className={mode === 'table' ? 'active' : 'ghost'}
                    onClick={() => setMode('table')}
                  >
                    Table
                  </button>
                  <button
                    className={mode === 'raw' ? 'active' : 'ghost'}
                    onClick={() => setMode('raw')}
                  >
                    Raw file
                  </button>
                  <span className="spacer" />
                  <span className="faint mono">{env.absPath}</span>
                  <button
                    className="ghost"
                    title="Show in file manager"
                    onClick={() => void api.reveal(env.absPath)}
                  >
                    ↗
                  </button>
                  {env.name !== state.activeEnv && (
                    <button onClick={() => void actions.setActiveEnv(env.name)}>Make active</button>
                  )}
                </div>

                {env.error && <div className="error-box">{env.error}</div>}

                {mode === 'table' ? (
                  <div className="pane-body">
                    <table className="kv">
                      <thead>
                        <tr>
                          <th>Key</th>
                          <th>Value</th>
                          <th style={{ width: '30%' }}>Comment</th>
                          <th className="tools" />
                        </tr>
                      </thead>
                      <tbody>
                        {env.entries.map((entry) => (
                          <tr key={entry.key}>
                            <td>
                              <input type="text" value={entry.key} readOnly className="mono" />
                            </td>
                            <td>
                              <input
                                type="text"
                                className="mono"
                                defaultValue={entry.value}
                                onBlur={(e) => {
                                  if (e.target.value !== entry.value) {
                                    void setValue(entry.key, e.target.value)
                                  }
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                                }}
                              />
                            </td>
                            <td className="faint" style={{ padding: '6px 8px' }}>
                              {entry.comment ?? ''}
                            </td>
                            <td className="tools">
                              <button
                                className="ghost"
                                title="Delete this key"
                                onClick={() => void setValue(entry.key, null)}
                              >
                                ×
                              </button>
                            </td>
                          </tr>
                        ))}
                        <tr>
                          <td>
                            <input
                              type="text"
                              className="mono"
                              placeholder="NEW_KEY"
                              value={newKey}
                              onChange={(e) => setNewKey(e.target.value)}
                            />
                          </td>
                          <td>
                            <input
                              type="text"
                              className="mono"
                              placeholder="value"
                              value={newValue}
                              onChange={(e) => setNewValue(e.target.value)}
                              onKeyDown={(e) => e.key === 'Enter' && void addEntry()}
                            />
                          </td>
                          <td />
                          <td className="tools">
                            <button className="ghost" onClick={() => void addEntry()}>
                              +
                            </button>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <div className="kv-add faint">
                      Editing a value here rewrites only that one line. Comments, ordering, quoting
                      and line endings stay exactly as they are.
                    </div>
                  </div>
                ) : (
                  <div className="editor-wrap">
                    <CodeEditor
                      value={draft ?? env.raw}
                      language="text"
                      onChange={setDraft}
                      placeholder={'# comments are preserved\nBASE_URL=https://api.example.com\n'}
                    />
                    <div className="script-hint">
                      <span>Editing the file directly.</span>
                      <span className="spacer" />
                      {draft !== null && (
                        <>
                          <button className="ghost" onClick={() => setDraft(null)}>
                            Discard
                          </button>
                          <button className="primary" onClick={() => void saveRaw()}>
                            Save file
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        <footer>
          <button
            onClick={() => setCreating({ name: 'local', file: suggestedFile('local') })}
            disabled={creating !== null}
          >
            New .env file
          </button>
          <button onClick={() => void linkFile()}>Link existing file</button>
          {env && (
            <button
              className="danger"
              onClick={async () => {
                if (!window.confirm(`Unlink "${env.name}"? The file stays on disk.`)) return
                actions.applyEnvResult(await api.removeEnv(env.name))
                setSelected(null)
              }}
            >
              Unlink
            </button>
          )}
          <span className="spacer" />
          <button className="primary" onClick={close}>
            Done
          </button>
        </footer>
      </div>
    </div>
  )
}
