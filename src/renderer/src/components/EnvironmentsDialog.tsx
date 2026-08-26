import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type JSX,
  type KeyboardEvent
} from 'react'
import { api } from '../api'
import { useStore } from '../store'
import { CodeEditor } from './CodeEditor'

/** A row you have started typing but not finished; not yet in the file. */
interface Draft {
  id: string
  key: string
  value: string
}

type DraftField = 'key' | 'value'

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
  const [drafts, setDrafts] = useState<Draft[]>([])
  const inputs = useRef(new Map<string, HTMLInputElement>())
  const [focusAfterAdd, setFocusAfterAdd] = useState<{ index: number; field: DraftField } | null>(
    null
  )
  /**
   * The inline "new environment" form. Electron has no `window.prompt`, and a
   * modal on top of a modal to ask for two strings would be worse than asking
   * for them where the list already is.
   */
  const [creating, setCreating] = useState<{ name: string; file: string } | null>(null)

  const env = state.environments.find((e) => e.name === selected) ?? state.environments[0] ?? null

  useEffect(() => {
    // Switching files starts clean: a half-typed row belongs to the file it
    // was started in, and the raw editor's draft likewise.
    setDraft(null)
    setDrafts([])
    inputs.current.clear()
  }, [env?.name])

  const close = (): void => actions.toggle('showEnvs', false)

  /** Returns whether the file was actually written. */
  const setValue = async (key: string, value: string | null): Promise<boolean> => {
    if (!env) return false
    try {
      const environments = await api.setEnvValue(env.name, key, value)
      actions.applyEnvResult({ environments })
      return true
    } catch (err) {
      actions.toast('error', (err as Error).message)
      return false
    }
  }

  const cellKey = (index: number, field: DraftField): string => `${index}:${field}`

  const register =
    (index: number, field: DraftField) =>
    (element: HTMLInputElement | null): void => {
      if (element) inputs.current.set(cellKey(index, field), element)
      else inputs.current.delete(cellKey(index, field))
    }

  /**
   * Typing in the trailing row promotes it to a real one and the caret has to
   * follow, otherwise the first character lands in the new row while you carry
   * on typing into the empty placeholder below it.
   *
   * Layout effect rather than a plain effect: focus moves before the browser
   * paints, so a fast typist never sees or types into the wrong cell.
   */
  useLayoutEffect(() => {
    if (!focusAfterAdd) return
    const element = inputs.current.get(cellKey(focusAfterAdd.index, focusAfterAdd.field))
    if (element) {
      element.focus()
      const end = element.value.length
      element.setSelectionRange(end, end)
    }
    setFocusAfterAdd(null)
  }, [focusAfterAdd, drafts])

  const promote = (field: DraftField, text: string): void => {
    setDrafts((prev) => [...prev, { id: crypto.randomUUID(), key: '', value: '', [field]: text }])
    setFocusAfterAdd({ index: drafts.length, field })
  }

  const patchDraft = (id: string, changes: Partial<Draft>): void =>
    setDrafts((prev) => prev.map((d) => (d.id === id ? { ...d, ...changes } : d)))

  const dropDraft = (id: string): void => {
    inputs.current.clear()
    setDrafts((prev) => prev.filter((d) => d.id !== id))
  }

  /**
   * Writes a started row to the file once it is finished with.
   *
   * A row with no key cannot be written, so it simply stays put rather than
   * being thrown away behind your back.
   */
  const commitDraft = async (draft: Draft): Promise<void> => {
    const key = draft.key.trim()
    if (!key) return
    // Only once the file is written: a failed write must not take what was
    // typed with it. The row and the real entry never coexist, because the
    // entry list only updates when the write lands.
    if (await setValue(key, draft.value)) dropDraft(draft.id)
  }

  /** Tabbing between the two cells stays in the row; leaving it commits. */
  const onDraftBlur = (event: FocusEvent<HTMLTableRowElement>, draft: Draft): void => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
    void commitDraft(draft)
  }

  const commitOnEnter = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key !== 'Enter') return
    event.preventDefault()
    // Blur so the row's own handler does the commit, in one place.
    event.currentTarget.blur()
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
                        {/* Rows you have started but not finished. They are
                            written to the file when you leave them. */}
                        {drafts.map((draft, index) => (
                          <tr key={draft.id} onBlur={(e) => onDraftBlur(e, draft)}>
                            <td>
                              <input
                                ref={register(index, 'key')}
                                type="text"
                                className="mono"
                                placeholder="NEW_KEY"
                                value={draft.key}
                                onChange={(e) => patchDraft(draft.id, { key: e.target.value })}
                                onKeyDown={commitOnEnter}
                              />
                            </td>
                            <td>
                              <input
                                ref={register(index, 'value')}
                                type="text"
                                className="mono"
                                placeholder="value"
                                value={draft.value}
                                onChange={(e) => patchDraft(draft.id, { value: e.target.value })}
                                onKeyDown={commitOnEnter}
                              />
                            </td>
                            <td className="faint" style={{ padding: '6px 8px' }}>
                              {draft.key.trim() ? '' : 'needs a key'}
                            </td>
                            <td className="tools">
                              <button
                                className="ghost"
                                title="Discard this row"
                                onClick={() => dropDraft(draft.id)}
                              >
                                ×
                              </button>
                            </td>
                          </tr>
                        ))}

                        {/* The placeholder. Never part of `drafts`, so an
                            untouched row is never written to the file. */}
                        <tr>
                          <td>
                            <input
                              type="text"
                              className="mono"
                              value=""
                              placeholder="NEW_KEY"
                              onChange={(e) => promote('key', e.target.value)}
                            />
                          </td>
                          <td>
                            <input
                              type="text"
                              className="mono"
                              value=""
                              placeholder="value"
                              onChange={(e) => promote('value', e.target.value)}
                            />
                          </td>
                          <td />
                          <td className="tools" />
                        </tr>
                      </tbody>
                    </table>
                    <div className="kv-add faint">
                      A new key is written when you leave its row. Editing a value rewrites only
                      that one line - comments, ordering, quoting and line endings stay as they are.
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
