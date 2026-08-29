import { useEffect, useMemo, useRef, useState, type JSX } from 'react'
import { api, type OpenApiPlanView } from '../api'
import { useStore } from '../store'

const PLACEHOLDER = `{
  "openapi": "3.0.0",
  "info": { "title": "Example", "version": "1.0.0" },
  "servers": [{ "url": "https://api.example.com" }],
  "paths": { "/users": { "get": { "summary": "List users", "tags": ["Users"] } } }
}`

type Source = 'paste' | 'url'

interface Group {
  folder: string
  requests: Array<{ name?: string; method?: string; url?: string }>
}

/** Groups the plan the way the tree will show it after the import. */
const group = (plan: OpenApiPlanView): Group[] => {
  const groups = new Map<string, Group>()
  for (const planned of plan.requests) {
    let existing = groups.get(planned.folder)
    if (!existing) {
      existing = { folder: planned.folder, requests: [] }
      groups.set(planned.folder, existing)
    }
    existing.requests.push(planned.request)
  }
  return [...groups.values()]
}

const describeAuth = (auth: OpenApiPlanView['auth']): string => {
  if (!auth) return ''
  if (auth.type === 'apikey') return `API key in ${auth.in} (${auth.key})`
  return `${auth.type} auth`
}

/**
 * Imports an OpenAPI document, pasted or downloaded.
 *
 * The preview is produced by the same parser that does the import, so the
 * folders and requests listed here are exactly the files that get written.
 */
export function ImportOpenApiDialog({ targetDir }: { targetDir: string }): JSX.Element {
  const { state, actions } = useStore()
  const [source, setSource] = useState<Source>('paste')
  const [text, setText] = useState('')
  const [url, setUrl] = useState('')
  const [groupByTag, setGroupByTag] = useState(true)
  const [applyAuth, setApplyAuth] = useState(true)
  const [variable, setVariable] = useState('BASE_URL')
  const [server, setServer] = useState('')
  const [plan, setPlan] = useState<OpenApiPlanView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const area = useRef<HTMLTextAreaElement | null>(null)

  const close = (): void => actions.openImportOpenApi(null)
  const relative = state.root
    ? targetDir.slice(state.root.length).replace(/^[\\/]/, '') || '.'
    : 'a folder you choose'

  useEffect(() => {
    area.current?.focus()
  }, [])

  // Re-parse a paste as you type, but not on every keystroke. A URL is only
  // fetched when asked for: nobody wants a request per character.
  useEffect(() => {
    if (source !== 'paste') return
    if (!text.trim()) {
      setPlan(null)
      setError(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const parsed = await api.parseOpenApi({ text }, { groupByTag, baseVariable: variable })
        if (cancelled) return
        setPlan(parsed)
        setError(null)
      } catch (err) {
        if (cancelled) return
        setPlan(null)
        setError((err as Error).message)
      }
    }, 260)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [source, text, groupByTag, variable])

  // Whatever the document offered first is the sensible default server.
  useEffect(() => {
    if (plan && !plan.servers.includes(server)) setServer(plan.servers[0] ?? '')
  }, [plan, server])

  const load = async (): Promise<void> => {
    if (!url.trim() || loading) return
    setLoading(true)
    try {
      const parsed = await api.parseOpenApi({ url }, { groupByTag, baseVariable: variable })
      setPlan(parsed)
      setError(null)
    } catch (err) {
      setPlan(null)
      setError((err as Error).message)
    }
    setLoading(false)
  }

  const paste = async (): Promise<void> => {
    const clip = await api.clipboard.read()
    if (clip.trim()) {
      setSource('paste')
      setText(clip)
    }
  }

  const submit = async (): Promise<void> => {
    if (!plan || !plan.requests.length || busy) return
    setBusy(true)
    await actions.importOpenApi(targetDir, source === 'url' ? { url } : { text }, {
      groupByTag,
      baseVariable: variable,
      applyAuth,
      server
    })
    setBusy(false)
  }

  const groups = useMemo(() => (plan ? group(plan) : []), [plan])
  const ready = !!plan && plan.requests.length > 0

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" style={{ width: 'min(820px, 100%)', maxHeight: '86vh' }}>
        <header>
          <h2>Import from OpenAPI</h2>
          <span className="faint">
            into <span className="mono">{relative}</span>
          </span>
          <span className="spacer" />
          <button className="ghost" onClick={close}>
            ✕
          </button>
        </header>

        <div className="content" style={{ padding: 14, display: 'grid', gap: 12 }}>
          <div className="seg">
            <button className={source === 'paste' ? 'on' : ''} onClick={() => setSource('paste')}>
              Paste
            </button>
            <button className={source === 'url' ? 'on' : ''} onClick={() => setSource('url')}>
              From URL
            </button>
          </div>

          {source === 'paste' ? (
            <>
              <textarea
                ref={area}
                className="mono curl-input"
                rows={9}
                spellCheck={false}
                placeholder={PLACEHOLDER}
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit()
                }}
              />
              <div className="row">
                <button onClick={() => void paste()}>Paste from clipboard</button>
                <button className="ghost" onClick={() => setText('')} disabled={!text}>
                  Clear
                </button>
              </div>
            </>
          ) : (
            <div className="row">
              <input
                type="text"
                className="mono"
                placeholder="https://api.example.com/openapi.json"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void load()
                }}
              />
              <button onClick={() => void load()} disabled={!url.trim() || loading}>
                {loading ? 'Loading…' : 'Load'}
              </button>
            </div>
          )}

          {error && <div className="error-box">{error}</div>}

          {plan && (
            <div className="curl-preview" style={{ display: 'grid', gap: 10 }}>
              <div className="row">
                <b>{plan.title}</b>
                <span className="faint">{plan.version}</span>
                <span className="spacer" />
                <span className="faint">
                  {plan.requests.length} request{plan.requests.length === 1 ? '' : 's'} in{' '}
                  {groups.length} folder{groups.length === 1 ? '' : 's'}
                </span>
              </div>

              <div className="openapi-tree">
                {groups.map((entry) => (
                  <div key={entry.folder || '.'} className="openapi-group">
                    <div className="openapi-folder">
                      {entry.folder || relative}
                      <span className="faint"> · {entry.requests.length}</span>
                    </div>
                    {entry.requests.map((request, i) => (
                      <div key={i} className="openapi-row">
                        <span className={`method ${(request.method ?? 'get').toLowerCase()}`}>
                          {request.method}
                        </span>
                        <span className="name">{request.name}</span>
                        <span className="mono faint url">{request.url}</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>

              {plan.warnings.map((warning, i) => (
                <div key={i} className="warn-line">
                  {warning}
                </div>
              ))}
            </div>
          )}

          <div className="row">
            <label className="dim" style={{ width: 90 }}>
              Server
            </label>
            {plan && plan.servers.length > 1 ? (
              <select value={server} onChange={(e) => setServer(e.target.value)}>
                {plan.servers.map((option) => (
                  <option key={option} value={option}>
                    {option}
                  </option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                className="mono"
                placeholder="https://api.example.com"
                value={server}
                onChange={(e) => setServer(e.target.value)}
              />
            )}
          </div>

          <div className="row">
            <label className="dim" style={{ width: 90 }}>
              Bind it to
            </label>
            <input
              type="text"
              className="mono"
              style={{ maxWidth: 200 }}
              value={variable}
              onChange={(e) => setVariable(e.target.value.trim())}
            />
            <span className="faint">
              {'{{'}
              {variable || 'BASE_URL'}
              {'}}'} in every imported URL
            </span>
          </div>

          <div className="row">
            <label className="check">
              <input
                type="checkbox"
                checked={groupByTag}
                onChange={(e) => setGroupByTag(e.target.checked)}
              />
              Put each tag in its own folder
            </label>
            {plan?.auth && (
              <label className="check" title="Set on the folder, so every request inherits it">
                <input
                  type="checkbox"
                  checked={applyAuth}
                  onChange={(e) => setApplyAuth(e.target.checked)}
                />
                Use the document&apos;s {describeAuth(plan.auth)}
              </label>
            )}
          </div>
        </div>

        <footer>
          <span className="faint">
            One <span className="mono">.frap.json</span> file per operation, ready to commit.
          </span>
          <span className="spacer" />
          <button onClick={close}>Cancel</button>
          <button className="primary" onClick={() => void submit()} disabled={!ready || busy}>
            {busy ? 'Importing…' : 'Import'}
          </button>
        </footer>
      </div>
    </div>
  )
}
