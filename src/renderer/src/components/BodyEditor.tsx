import type { JSX } from 'react'
import type { BodyMode, FormField, RequestBody } from '@shared/types'
import { api } from '../api'
import { CodeEditor, type Language } from './CodeEditor'
import { KeyValueEditor } from './KeyValueEditor'

const MODES: Array<{ value: BodyMode; label: string }> = [
  { value: 'none', label: 'No body' },
  { value: 'json', label: 'JSON' },
  { value: 'text', label: 'Text' },
  { value: 'xml', label: 'XML' },
  { value: 'urlencoded', label: 'Form URL-encoded' },
  { value: 'form', label: 'Multipart form' },
  { value: 'graphql', label: 'GraphQL' },
  { value: 'binary', label: 'File' }
]

const LANGUAGE: Partial<Record<BodyMode, Language>> = {
  json: 'json',
  xml: 'xml',
  graphql: 'javascript',
  text: 'text'
}

interface Props {
  body: RequestBody
  onChange: (body: RequestBody) => void
}

function prettify(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

function FormFields({
  fields,
  onChange
}: {
  fields: FormField[]
  onChange: (fields: FormField[]) => void
}): JSX.Element {
  const patch = (index: number, changes: Partial<FormField>): void =>
    onChange(fields.map((f, i) => (i === index ? { ...f, ...changes } : f)))

  return (
    <table className="kv">
      <thead>
        <tr>
          <th className="check" />
          <th>Field</th>
          <th style={{ width: 110 }}>Type</th>
          <th>Value</th>
          <th className="tools" />
        </tr>
      </thead>
      <tbody>
        {fields.map((field, index) => (
          <tr key={index} className={field.enabled ? '' : 'disabled'}>
            <td className="check">
              <input
                type="checkbox"
                checked={field.enabled}
                onChange={(e) => patch(index, { enabled: e.target.checked })}
              />
            </td>
            <td>
              <input
                type="text"
                value={field.key}
                placeholder="Field name"
                onChange={(e) => patch(index, { key: e.target.value })}
              />
            </td>
            <td>
              <select
                value={field.type}
                onChange={(e) => patch(index, { type: e.target.value as FormField['type'] })}
                style={{ border: 'none', borderRadius: 0, background: 'transparent' }}
              >
                <option value="text">Text</option>
                <option value="file">File</option>
              </select>
            </td>
            <td>
              <div style={{ display: 'flex' }}>
                <input
                  type="text"
                  value={field.value}
                  placeholder={field.type === 'file' ? 'Path to a file' : 'Value'}
                  onChange={(e) => patch(index, { value: e.target.value })}
                />
                {field.type === 'file' && (
                  <button
                    className="ghost"
                    title="Choose a file"
                    onClick={async () => {
                      const picked = await api.pickFile()
                      if (picked) patch(index, { value: picked })
                    }}
                  >
                    …
                  </button>
                )}
              </div>
            </td>
            <td className="tools">
              <button
                className="ghost"
                title="Remove"
                onClick={() => onChange(fields.filter((_, i) => i !== index))}
              >
                ×
              </button>
            </td>
          </tr>
        ))}
        <tr>
          <td colSpan={5} className="kv-add">
            <button
              onClick={() =>
                onChange([...fields, { enabled: true, key: '', type: 'text', value: '' }])
              }
            >
              Add field
            </button>
          </td>
        </tr>
      </tbody>
    </table>
  )
}

export function BodyEditor({ body, onChange }: Props): JSX.Element {
  const setMode = (mode: BodyMode): void => onChange({ ...body, mode })

  return (
    <div className="editor-wrap">
      <div className="editor-toolbar">
        <select value={body.mode} onChange={(e) => setMode(e.target.value as BodyMode)}>
          {MODES.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>

        {body.mode === 'json' && (
          <button
            className="ghost"
            onClick={() => onChange({ ...body, text: prettify(body.text ?? '') })}
          >
            Format
          </button>
        )}

        <span className="spacer" />

        {body.mode !== 'none' && body.mode !== 'form' && (
          <input
            type="text"
            className="mono"
            style={{ width: 250 }}
            placeholder="Content-Type (override)"
            value={body.contentType ?? ''}
            onChange={(e) => onChange({ ...body, contentType: e.target.value || undefined })}
          />
        )}
      </div>

      {body.mode === 'none' && (
        <div className="empty-hint">
          This request has no body.
          <br />
          Pick a type above to add one.
        </div>
      )}

      {(body.mode === 'json' || body.mode === 'text' || body.mode === 'xml') && (
        <CodeEditor
          value={body.text ?? ''}
          language={LANGUAGE[body.mode] ?? 'text'}
          onChange={(text) => onChange({ ...body, text })}
          placeholder={'{\n  "hello": "{{NAME}}"\n}'}
        />
      )}

      {body.mode === 'graphql' && (
        <div className="editor-wrap">
          <CodeEditor
            value={body.text ?? ''}
            language="javascript"
            onChange={(text) => onChange({ ...body, text })}
            placeholder={'query {\n  viewer { id }\n}'}
          />
          <div className="editor-toolbar">Variables (JSON)</div>
          <div style={{ height: 140, display: 'flex' }}>
            <CodeEditor
              value={body.graphqlVariables ?? ''}
              language="json"
              onChange={(graphqlVariables) => onChange({ ...body, graphqlVariables })}
              placeholder={'{ "id": "{{USER_ID}}" }'}
            />
          </div>
        </div>
      )}

      {body.mode === 'urlencoded' && (
        <div className="pane-body">
          <KeyValueEditor
            rows={body.urlencoded ?? []}
            onChange={(urlencoded) => onChange({ ...body, urlencoded })}
            keyPlaceholder="Field"
            hint="Sent as application/x-www-form-urlencoded."
          />
        </div>
      )}

      {body.mode === 'form' && (
        <div className="pane-body">
          <FormFields fields={body.form ?? []} onChange={(form) => onChange({ ...body, form })} />
          <div className="kv-add faint">
            File paths are resolved relative to the workspace folder, so they stay portable across
            machines.
          </div>
        </div>
      )}

      {body.mode === 'binary' && (
        <div className="pane-body" style={{ padding: 14 }}>
          <div className="row">
            <input
              type="text"
              className="mono"
              placeholder="Path to a file, relative to the workspace"
              value={body.filePath ?? ''}
              onChange={(e) => onChange({ ...body, filePath: e.target.value })}
            />
            <button
              onClick={async () => {
                const picked = await api.pickFile()
                if (picked) onChange({ ...body, filePath: picked })
              }}
            >
              Browse
            </button>
          </div>
          <p className="faint" style={{ marginTop: 10 }}>
            The file is sent as the raw request body. Content-Type is guessed from the extension
            unless you override it above.
          </p>
        </div>
      )}
    </div>
  )
}
