import type { JSX } from 'react'
import type { FolderMeta, InheritFlags } from '@shared/types'
import { useStore, type FolderSection, type FolderTabState } from '../store'
import { AuthEditor } from './AuthEditor'
import { CodeEditor } from './CodeEditor'
import { InheritToggle } from './InheritToggle'
import { KeyValueEditor } from './KeyValueEditor'

const PRE_TEMPLATE = `// Runs before every request in this folder, ahead of the request's own script.
frap.request.setHeader('X-Request-Id', crypto.randomUUID())
`

const POST_TEMPLATE = `// Runs after every response in this folder, ahead of the request's own script.
frap.test('not a server error', () => {
  frap.expect(frap.response.status).toBeLessThan(500)
})
`

interface Props {
  tab: FolderTabState
}

/**
 * Headers, auth and scripts that apply to every request inside a folder.
 *
 * Laid out like the request editor on purpose - the same tab strip in the same
 * place - because it is the same idea one level up.
 */
export function FolderPane({ tab }: Props): JSX.Element {
  const { state, actions } = useStore()
  const meta = tab.meta
  const isRoot = state.root !== null && tab.folder === state.root

  const patch = (changes: Partial<FolderMeta>): void =>
    actions.patchTab(tab.path, { meta: { ...meta, ...changes } })
  const setSection = (section: FolderSection): void => actions.patchTab(tab.path, { section })
  const setInherit = (key: keyof InheritFlags, value: boolean): void =>
    patch({ inherit: { ...meta.inherit, [key]: value } })

  const sections: Array<{ id: FolderSection; label: string; badge?: boolean }> = [
    { id: 'headers', label: 'Headers', badge: meta.headers.length > 0 },
    { id: 'auth', label: 'Auth', badge: meta.auth.type !== 'inherit' },
    { id: 'pre', label: 'Pre-request', badge: meta.scripts.preRequest.trim() !== '' },
    { id: 'post', label: 'Tests', badge: meta.scripts.postResponse.trim() !== '' },
    { id: 'docs', label: 'Docs', badge: Boolean(meta.docs) }
  ]

  return (
    <div className="pane folder-pane">
      <div className="folder-scope">
        <span className="method other">DIR</span>
        <b>{tab.name}</b>
        <span className="faint">
          {isRoot
            ? 'Applies to every request in the collection.'
            : `Applies to every request in ${tab.name} and below. The nearest setting wins, and a request always beats its folders.`}
        </span>
      </div>

      <div className="tabbar">
        {sections.map((section) => (
          <button
            key={section.id}
            className={tab.section === section.id ? 'active' : ''}
            onClick={() => setSection(section.id)}
          >
            {section.label}
            {section.badge && <span className="badge">●</span>}
          </button>
        ))}
      </div>

      <div className="pane-body">
        {tab.section === 'headers' && (
          <>
            <div className="editor-toolbar">
              <InheritToggle
                inherited={meta.inherit.headers}
                onChange={(value) => setInherit('headers', value)}
                what="headers from outer folders"
                isFolder
              />
            </div>
            <KeyValueEditor
              rows={meta.headers}
              onChange={(headers) => patch({ headers })}
              keyPlaceholder="Header"
              hint="Sent with every request below. A request that sets the same header wins."
            />
          </>
        )}

        {tab.section === 'auth' && (
          <>
            <div className="editor-toolbar">
              <InheritToggle
                inherited={meta.inherit.auth}
                onChange={(value) => setInherit('auth', value)}
                what="auth from outer folders"
                isFolder
              />
            </div>
            <AuthEditor
              auth={meta.auth}
              onChange={(auth) => patch({ auth })}
              inheritLabel="Not set - use the folder above"
              note={
                'Requests below use this unless they set their own. Choosing "No auth" here ' +
                'stops an outer folder from reaching this subtree, which is how a public ' +
                'endpoint opts out.'
              }
            />
          </>
        )}

        {tab.section === 'pre' && (
          <div className="editor-wrap">
            <div className="editor-toolbar">
              <span className="dim">Runs before every request below</span>
              <InheritToggle
                inherited={meta.inherit.preRequest}
                onChange={(value) => setInherit('preRequest', value)}
                what="scripts from outer folders"
                isFolder
              />
              <span className="spacer" />
              {!meta.scripts.preRequest && (
                <button
                  className="ghost"
                  onClick={() => patch({ scripts: { ...meta.scripts, preRequest: PRE_TEMPLATE } })}
                >
                  Insert example
                </button>
              )}
            </div>
            <CodeEditor
              value={meta.scripts.preRequest}
              language="javascript"
              onChange={(preRequest) => patch({ scripts: { ...meta.scripts, preRequest } })}
              placeholder={PRE_TEMPLATE}
            />
            <div className="script-hint">
              <span>Outermost folder first, then nearer folders, then the request.</span>
              <span className="spacer" />
              <span>F1 for the full reference</span>
            </div>
          </div>
        )}

        {tab.section === 'post' && (
          <div className="editor-wrap">
            <div className="editor-toolbar">
              <span className="dim">Runs after every response below</span>
              <InheritToggle
                inherited={meta.inherit.postResponse}
                onChange={(value) => setInherit('postResponse', value)}
                what="tests from outer folders"
                isFolder
              />
              <span className="spacer" />
              {!meta.scripts.postResponse && (
                <button
                  className="ghost"
                  onClick={() =>
                    patch({ scripts: { ...meta.scripts, postResponse: POST_TEMPLATE } })
                  }
                >
                  Insert example
                </button>
              )}
            </div>
            <CodeEditor
              value={meta.scripts.postResponse}
              language="javascript"
              onChange={(postResponse) => patch({ scripts: { ...meta.scripts, postResponse } })}
              placeholder={POST_TEMPLATE}
            />
            <div className="script-hint">
              <span>Its tests appear alongside the request&apos;s own.</span>
              <span className="spacer" />
              <span>F1 for the full reference</span>
            </div>
          </div>
        )}

        {tab.section === 'docs' && (
          <div className="editor-wrap">
            <div className="editor-toolbar">
              <span className="dim">Notes saved with the folder, for whoever reads the diff</span>
            </div>
            <CodeEditor
              value={meta.docs ?? ''}
              language="text"
              onChange={(docs) => patch({ docs: docs || undefined })}
              placeholder="What lives in this folder, and anything shared across it..."
            />
          </div>
        )}
      </div>
    </div>
  )
}
