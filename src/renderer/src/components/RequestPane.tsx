import { useMemo, type JSX } from 'react'
import type { FrapRequest } from '@shared/types'
import { useStore, type RequestTab, type TabState } from '../store'
import { AuthEditor } from './AuthEditor'
import { BodyEditor } from './BodyEditor'
import { CodeEditor } from './CodeEditor'
import { KeyValueEditor } from './KeyValueEditor'

const PRE_TEMPLATE = `// Runs before the request is sent.
// frap.request.setHeader(name, value)  frap.env.get(key)  frap.vars.set(key, value)

frap.request.setHeader('X-Request-Id', crypto.randomUUID())
`

const POST_TEMPLATE = `// Runs after the response arrives.
const data = frap.response.json()

frap.test('status is 200', () => {
  frap.expect(frap.response.status).toBe(200)
})

// Writes straight into the active .env file, comments and all.
frap.env.set('TOKEN', data.token)
`

interface Props {
  tab: TabState
}

function countOf(rows: { enabled: boolean; key: string }[] | undefined): number {
  return (rows ?? []).filter((r) => r.enabled && r.key.trim()).length
}

export function RequestPane({ tab }: Props): JSX.Element {
  const { actions } = useStore()
  const request = tab.request

  const patch = (changes: Partial<FrapRequest>): void => actions.patchRequest(tab.path, changes)
  const setTab = (reqTab: RequestTab): void => actions.patchTab(tab.path, { reqTab })

  const counts = useMemo(
    () => ({
      params: countOf(request.params),
      headers: countOf(request.headers),
      pre: request.scripts.preRequest.trim().length,
      post: request.scripts.postResponse.trim().length
    }),
    [request]
  )

  const tabs: Array<{ id: RequestTab; label: string; badge?: string | number }> = [
    { id: 'params', label: 'Params', badge: counts.params || undefined },
    { id: 'headers', label: 'Headers', badge: counts.headers || undefined },
    { id: 'body', label: 'Body', badge: request.body.mode === 'none' ? undefined : '●' },
    { id: 'auth', label: 'Auth', badge: request.auth.type === 'none' ? undefined : '●' },
    { id: 'pre', label: 'Pre-request', badge: counts.pre ? '●' : undefined },
    { id: 'post', label: 'Tests', badge: counts.post ? '●' : undefined },
    { id: 'docs', label: 'Docs' }
  ]

  return (
    <div className="pane">
      <div className="tabbar">
        {tabs.map((t) => (
          <button
            key={t.id}
            className={tab.reqTab === t.id ? 'active' : ''}
            onClick={() => setTab(t.id)}
          >
            {t.label}
            {t.badge !== undefined && <span className="badge">{t.badge}</span>}
          </button>
        ))}
      </div>

      <div className="pane-body">
        {tab.reqTab === 'params' && (
          <KeyValueEditor
            rows={request.params}
            onChange={(params) => patch({ params })}
            keyPlaceholder="Parameter"
            hint="Appended to the URL as a query string. Values support {{VARIABLES}}."
          />
        )}

        {tab.reqTab === 'headers' && (
          <KeyValueEditor
            rows={request.headers}
            onChange={(headers) => patch({ headers })}
            keyPlaceholder="Header"
            hint="Content-Type, Accept, User-Agent and Content-Length are filled in automatically unless you set them here."
          />
        )}

        {tab.reqTab === 'body' && (
          <BodyEditor body={request.body} onChange={(body) => patch({ body })} />
        )}

        {tab.reqTab === 'auth' && (
          <AuthEditor auth={request.auth} onChange={(auth) => patch({ auth })} />
        )}

        {tab.reqTab === 'pre' && (
          <div className="editor-wrap">
            <div className="editor-toolbar">
              <span className="dim">Runs before the request is sent</span>
              <span className="spacer" />
              {!request.scripts.preRequest && (
                <button
                  className="ghost"
                  onClick={() =>
                    patch({ scripts: { ...request.scripts, preRequest: PRE_TEMPLATE } })
                  }
                >
                  Insert example
                </button>
              )}
            </div>
            <CodeEditor
              value={request.scripts.preRequest}
              language="javascript"
              onChange={(preRequest) => patch({ scripts: { ...request.scripts, preRequest } })}
              placeholder={PRE_TEMPLATE}
            />
            <div className="script-hint">
              <code>frap.request</code>
              <code>frap.env</code>
              <code>frap.vars</code>
              <code>await fetch()</code>
              <span className="spacer" />
              <span>F1 for the full reference</span>
            </div>
          </div>
        )}

        {tab.reqTab === 'post' && (
          <div className="editor-wrap">
            <div className="editor-toolbar">
              <span className="dim">Runs after the response arrives</span>
              <span className="spacer" />
              {!request.scripts.postResponse && (
                <button
                  className="ghost"
                  onClick={() =>
                    patch({ scripts: { ...request.scripts, postResponse: POST_TEMPLATE } })
                  }
                >
                  Insert example
                </button>
              )}
            </div>
            <CodeEditor
              value={request.scripts.postResponse}
              language="javascript"
              onChange={(postResponse) => patch({ scripts: { ...request.scripts, postResponse } })}
              placeholder={POST_TEMPLATE}
            />
            <div className="script-hint">
              <code>frap.response</code>
              <code>frap.test()</code>
              <code>frap.expect()</code>
              <code>frap.env.set()</code>
              <span className="spacer" />
              <span>F1 for the full reference</span>
            </div>
          </div>
        )}

        {tab.reqTab === 'docs' && (
          <div className="editor-wrap">
            <div className="editor-toolbar">
              <span className="dim">Notes saved alongside the request, for whoever reads the diff</span>
            </div>
            <CodeEditor
              value={request.docs ?? ''}
              language="text"
              onChange={(docs) => patch({ docs })}
              placeholder="What this request is for, gotchas, links to the spec..."
            />
          </div>
        )}
      </div>
    </div>
  )
}
