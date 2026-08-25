import { useMemo, type JSX } from 'react'
import { api } from '../api'
import { useStore, type ResponseTab, type TabState } from '../store'
import { CodeEditor, type Language } from './CodeEditor'

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function languageFor(contentType: string): Language {
  const type = contentType.toLowerCase()
  if (type.includes('json')) return 'json'
  if (type.includes('html')) return 'html'
  if (type.includes('xml')) return 'xml'
  if (type.includes('javascript')) return 'javascript'
  return 'text'
}

function prettyIfJson(text: string, language: Language): string {
  if (language !== 'json') return text
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

interface Props {
  tab: TabState
}

export function ResponsePane({ tab }: Props): JSX.Element {
  const { actions } = useStore()
  const result = tab.result
  const response = result?.response
  const setTab = (resTab: ResponseTab): void => actions.patchTab(tab.path, { resTab })

  const language = languageFor(response?.contentType ?? '')
  const prettyBody = useMemo(
    () => (response ? prettyIfJson(response.bodyText, language) : ''),
    [response, language]
  )

  if (tab.running) {
    return (
      <div className="pane">
        <div className="status-line">
          <span className="spin" />
          <span className="dim">Sending…</span>
          <span className="spacer" />
          <button onClick={() => void actions.cancel(tab.path)}>Cancel</button>
        </div>
      </div>
    )
  }

  if (!result) {
    return (
      <div className="pane">
        <div className="empty-hint">
          No response yet.
          <br />
          Press <b>Ctrl+Enter</b> to send.
        </div>
      </div>
    )
  }

  const passed = result.tests.filter((t) => t.passed).length
  const failed = result.tests.length - passed
  const statusClass = response ? `s${Math.floor(response.status / 100)}` : 's0'

  const tabs: Array<{ id: ResponseTab; label: string; badge?: JSX.Element | string | number }> = [
    { id: 'body', label: 'Body' },
    { id: 'headers', label: 'Headers', badge: response?.headers.length },
    {
      id: 'tests',
      label: 'Tests',
      badge: result.tests.length ? (
        <span className={`badge ${failed ? 'bad' : 'ok'}`}>
          {passed}/{result.tests.length}
        </span>
      ) : undefined
    },
    { id: 'console', label: 'Console', badge: result.logs.length || undefined },
    { id: 'sent', label: 'Sent' }
  ]

  return (
    <div className="pane">
      <div className="status-line">
        {result.skipped ? (
          <span className="dim">Skipped by the pre-request script</span>
        ) : response ? (
          <>
            <span className={`status-code ${statusClass}`}>
              {response.status} {response.statusText}
            </span>
            <span className="dim">{response.timings.totalMs} ms</span>
            <span className="dim">{formatBytes(response.size)}</span>
            {response.redirects.length > 0 && (
              <span className="dim" title={response.redirects.join('\n')}>
                {response.redirects.length} redirect{response.redirects.length === 1 ? '' : 's'}
              </span>
            )}
          </>
        ) : (
          <span className={`status-code s0`}>
            {result.scriptError ? `${result.scriptError}-request script failed` : 'Request failed'}
          </span>
        )}

        <span className="spacer" />

        {response && (
          <>
            {response.isBinary && (
              <button
                onClick={() =>
                  void api.saveFile(
                    `response-${Date.now()}.bin`,
                    response.bodyBase64
                  )
                }
              >
                Save file
              </button>
            )}
            <button
              className="ghost"
              title="Copy the body"
              onClick={() => void navigator.clipboard.writeText(prettyBody)}
            >
              Copy
            </button>
          </>
        )}
      </div>

      <div className="tabbar">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={tab.resTab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {typeof t.badge === 'object' ? t.badge : t.badge ? <span className="badge">{t.badge}</span> : null}
          </button>
        ))}
      </div>

      <div className="pane-body">
        {result.error && <div className="error-box">{result.error}</div>}

        {result.envWrites.length > 0 && (
          <div className="env-writes">
            <div className="title">Environment updated</div>
            {result.envWrites.map((write, i) => (
              <div key={i}>
                <code>{write.key}</code>
                {write.value === null ? (
                  <span className="dim"> removed from </span>
                ) : (
                  <span className="dim"> written to </span>
                )}
                <code>{write.file}</code>
              </div>
            ))}
          </div>
        )}

        {tab.resTab === 'body' &&
          (response ? (
            response.isBinary ? (
              <div className="empty-hint">
                {formatBytes(response.size)} of binary data ({response.contentType || 'unknown type'}).
                <br />
                Use <b>Save file</b> above to write it to disk.
              </div>
            ) : response.bodyText.length === 0 ? (
              <div className="empty-hint">Empty response body.</div>
            ) : (
              <CodeEditor value={prettyBody} language={language} readOnly />
            )
          ) : (
            !result.error && <div className="empty-hint">Nothing was received.</div>
          ))}

        {tab.resTab === 'headers' && response && (
          <table className="header-table">
            <tbody>
              {response.headers.map(([key, value], i) => (
                <tr key={i}>
                  <td className="k">{key}</td>
                  <td>{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {tab.resTab === 'tests' &&
          (result.tests.length === 0 ? (
            <div className="empty-hint">
              No tests ran.
              <br />
              Add <code className="mono">frap.test(...)</code> calls in the Tests tab.
            </div>
          ) : (
            result.tests.map((test, i) => (
              <div key={i} className={`test-row ${test.passed ? 'pass' : 'fail'}`}>
                <span className="icon">{test.passed ? '✓' : '✕'}</span>
                <div>
                  <div>{test.name}</div>
                  {test.error && <div className="why">{test.error}</div>}
                </div>
                <span className="spacer" />
                <span className="faint">{test.durationMs} ms</span>
              </div>
            ))
          ))}

        {tab.resTab === 'console' &&
          (result.logs.length === 0 ? (
            <div className="empty-hint">
              Nothing logged.
              <br />
              Use <code className="mono">frap.console.log(...)</code> in a script.
            </div>
          ) : (
            result.logs.map((log, i) => (
              <div key={i} className={`log-row ${log.level}`}>
                <span className="tag">{log.phase}</span>
                <span>{log.message}</span>
              </div>
            ))
          ))}

        {tab.resTab === 'sent' &&
          (result.sent ? (
            <div className="response-body">
              {result.sent.method} {result.sent.url}
              {'\n\n'}
              {result.sent.headers.map(([k, v]) => `${k}: ${v}`).join('\n')}
              {result.sent.bodyPreview ? `\n\n${result.sent.bodyPreview}` : ''}
            </div>
          ) : (
            <div className="empty-hint">The request was never sent.</div>
          ))}
      </div>
    </div>
  )
}
