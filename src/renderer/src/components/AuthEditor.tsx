import type { JSX } from 'react'
import type { Auth } from '@shared/types'
import { VariableInput } from './VariableInput'

interface Props {
  auth: Auth
  onChange: (auth: Auth) => void
}

const field = { display: 'grid', gridTemplateColumns: '110px 1fr', gap: 10, alignItems: 'center' }

export function AuthEditor({ auth, onChange }: Props): JSX.Element {
  return (
    <div style={{ padding: 14, display: 'grid', gap: 12, maxWidth: 640 }}>
      <div style={field}>
        <label className="dim">Type</label>
        <select
          value={auth.type}
          onChange={(e) => onChange({ type: e.target.value as Auth['type'] })}
        >
          <option value="none">No auth</option>
          <option value="bearer">Bearer token</option>
          <option value="basic">Basic</option>
          <option value="apikey">API key</option>
        </select>
      </div>

      {auth.type === 'bearer' && (
        <div style={field}>
          <label className="dim">Token</label>
          <VariableInput
            className="mono"
            placeholder="{{TOKEN}}"
            value={auth.token ?? ''}
            onChange={(e) => onChange({ ...auth, token: e.target.value })}
          />
        </div>
      )}

      {auth.type === 'basic' && (
        <>
          <div style={field}>
            <label className="dim">Username</label>
            <VariableInput
              className="mono"
              value={auth.username ?? ''}
              onChange={(e) => onChange({ ...auth, username: e.target.value })}
            />
          </div>
          <div style={field}>
            <label className="dim">Password</label>
            <VariableInput
              className="mono"
              placeholder="{{PASSWORD}}"
              value={auth.password ?? ''}
              onChange={(e) => onChange({ ...auth, password: e.target.value })}
            />
          </div>
        </>
      )}

      {auth.type === 'apikey' && (
        <>
          <div style={field}>
            <label className="dim">Key</label>
            <VariableInput
              className="mono"
              placeholder="X-API-Key"
              value={auth.key ?? ''}
              onChange={(e) => onChange({ ...auth, key: e.target.value })}
            />
          </div>
          <div style={field}>
            <label className="dim">Value</label>
            <VariableInput
              className="mono"
              placeholder="{{API_KEY}}"
              value={auth.value ?? ''}
              onChange={(e) => onChange({ ...auth, value: e.target.value })}
            />
          </div>
          <div style={field}>
            <label className="dim">Send in</label>
            <select
              value={auth.in ?? 'header'}
              onChange={(e) => onChange({ ...auth, in: e.target.value as 'header' | 'query' })}
            >
              <option value="header">Header</option>
              <option value="query">Query parameter</option>
            </select>
          </div>
        </>
      )}

      <p className="faint" style={{ marginTop: 4 }}>
        Values here support <code className="mono">{'{{VARIABLES}}'}</code>. Keep the real secret in
        your <code className="mono">.env</code> file and reference it, so nothing sensitive is
        committed with the collection.
      </p>
    </div>
  )
}
