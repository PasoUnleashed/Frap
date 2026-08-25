import { useEffect, useRef, useState, type JSX } from 'react'
import type { FrapRequest } from '@shared/types'
import { api } from '../api'
import { useStore } from '../store'

const PLACEHOLDER = `curl 'https://api.example.com/v1/users?page=2' \\
  -H 'accept: application/json' \\
  -H 'authorization: Bearer ...' \\
  --compressed`

interface Preview {
  request?: FrapRequest
  warnings: string[]
  error?: string
}

const countEnabled = (rows: { enabled: boolean; key: string }[] | undefined): number =>
  (rows ?? []).filter((r) => r.enabled && r.key.trim()).length

/**
 * Paste anything a browser's "Copy as cURL" produced. The preview is parsed by
 * the same code that does the import, so what you see is what gets written.
 */
export function ImportCurlDialog({ targetDir }: { targetDir: string }): JSX.Element {
  const { state, actions } = useStore()
  const [text, setText] = useState('')
  const [name, setName] = useState('')
  const [substitute, setSubstitute] = useState(true)
  const [preview, setPreview] = useState<Preview>({ warnings: [] })
  const [busy, setBusy] = useState(false)
  const area = useRef<HTMLTextAreaElement | null>(null)

  const close = (): void => actions.openImportCurl(null)
  const relative = state.root ? (targetDir.slice(state.root.length).replace(/^[\\/]/, '') || '.') : '.'

  useEffect(() => {
    area.current?.focus()
  }, [])

  // Re-parse as you type, but not on every keystroke.
  useEffect(() => {
    if (!text.trim()) {
      setPreview({ warnings: [] })
      return
    }
    let cancelled = false
    const timer = setTimeout(async () => {
      try {
        const result = await api.parseCurl(text, substitute)
        if (!cancelled) setPreview({ request: result.request, warnings: result.warnings })
      } catch (err) {
        if (!cancelled) setPreview({ warnings: [], error: (err as Error).message })
      }
    }, 220)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [text, substitute])

  const paste = async (): Promise<void> => {
    const clip = await api.clipboard.read()
    if (clip.trim()) setText(clip)
  }

  const submit = async (): Promise<void> => {
    if (!preview.request || busy) return
    setBusy(true)
    await actions.importCurl(targetDir, text, substitute, name || undefined)
    setBusy(false)
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal" style={{ width: 'min(760px, 100%)' }}>
        <header>
          <h2>Import from cURL</h2>
          <span className="faint">
            into <span className="mono">{relative}</span>
          </span>
          <span className="spacer" />
          <button className="ghost" onClick={close}>
            ✕
          </button>
        </header>

        <div className="content" style={{ padding: 14, display: 'grid', gap: 12 }}>
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
            <span className="spacer" />
            <label className="check" title="Replace values that match the active environment">
              <input
                type="checkbox"
                checked={substitute}
                onChange={(e) => setSubstitute(e.target.checked)}
              />
              Use {'{{variables}}'} where values match
            </label>
          </div>

          {preview.error && <div className="error-box">{preview.error}</div>}

          {preview.request && (
            <div className="curl-preview">
              <div className="row">
                <span className={`method ${preview.request.method.toLowerCase()}`}>
                  {preview.request.method}
                </span>
                <span className="mono url">{preview.request.url}</span>
              </div>
              <div className="faint chips">
                <span>{countEnabled(preview.request.params)} params</span>
                <span>{countEnabled(preview.request.headers)} headers</span>
                <span>
                  {preview.request.body.mode === 'none' ? 'no body' : preview.request.body.mode}
                </span>
                <span>
                  {preview.request.auth.type === 'none'
                    ? 'no auth'
                    : `${preview.request.auth.type} auth`}
                </span>
              </div>
              {preview.warnings.map((warning, i) => (
                <div key={i} className="warn-line">
                  {warning}
                </div>
              ))}
            </div>
          )}

          <div className="row">
            <label className="dim" style={{ width: 90 }}>
              Save as
            </label>
            <input
              type="text"
              placeholder={preview.request?.name ?? 'Request name'}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        </div>

        <footer>
          <span className="faint">
            Creates one <span className="mono">.frap.json</span> file, ready to commit.
          </span>
          <span className="spacer" />
          <button onClick={close}>Cancel</button>
          <button className="primary" onClick={() => void submit()} disabled={!preview.request || busy}>
            {busy ? 'Importing…' : 'Import'}
          </button>
        </footer>
      </div>
    </div>
  )
}
