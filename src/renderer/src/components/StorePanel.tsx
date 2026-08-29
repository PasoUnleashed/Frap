import { useState, type JSX } from 'react'
import { STORE_LABEL, type MapStore } from '@shared/types'
import { useStore } from '../store'

interface Props {
  store: MapStore
}

const BLURB: Record<MapStore, string> = {
  session:
    'Values that live only for this run of Frap. Scripts write them with ' +
    'frap.session.set(), and they are gone when you quit.',
  user:
    'Values that persist for you on this machine, per collection. Kept out of ' +
    'the collection folder on purpose, so a personal token is never committed.'
}

/**
 * The session and user stores.
 *
 * Both are plain key/value maps, so unlike the environment editor there is no
 * file to preserve - a change lands immediately.
 */
export function StorePanel({ store }: Props): JSX.Element {
  const { state, actions } = useStore()
  const values = state.stores[store]
  const [newKey, setNewKey] = useState('')
  const [newValue, setNewValue] = useState('')

  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b))

  const add = async (): Promise<void> => {
    const key = newKey.trim()
    if (!key) return
    await actions.setStoreValue(store, key, newValue)
    setNewKey('')
    setNewValue('')
  }

  return (
    <div className="env-detail">
      <div className="editor-toolbar">
        <span className="dim">{STORE_LABEL[store]} store</span>
        <span className="spacer" />
        <button
          className="ghost"
          disabled={entries.length === 0}
          onClick={() => {
            if (window.confirm(`Clear every value in the ${STORE_LABEL[store]} store?`)) {
              void actions.clearStore(store)
            }
          }}
        >
          Clear all
        </button>
      </div>

      <div className="pane-body">
        <table className="kv">
          <thead>
            <tr>
              <th>Key</th>
              <th>Value</th>
              <th className="tools" />
            </tr>
          </thead>
          <tbody>
            {entries.map(([key, value]) => (
              <tr key={key}>
                <td>
                  <input type="text" className="mono" value={key} readOnly />
                </td>
                <td>
                  <input
                    type="text"
                    className="mono"
                    defaultValue={value}
                    onBlur={(e) => {
                      if (e.target.value !== value) {
                        void actions.setStoreValue(store, key, e.target.value)
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    }}
                  />
                </td>
                <td className="tools">
                  <button
                    className="ghost"
                    title="Remove this key"
                    onClick={() => void actions.setStoreValue(store, key, null)}
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
                  onKeyDown={(e) => e.key === 'Enter' && void add()}
                />
              </td>
              <td className="tools">
                <button className="ghost" onClick={() => void add()}>
                  +
                </button>
              </td>
            </tr>
          </tbody>
        </table>

        <div className="kv-add faint" style={{ lineHeight: 1.7 }}>
          {BLURB[store]}
          <br />
          {'{{name}}'} resolves session first, then user, then the environment file.
        </div>
      </div>
    </div>
  )
}
