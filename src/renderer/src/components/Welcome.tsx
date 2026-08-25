import type { JSX } from 'react'
import { useStore } from '../store'

export function Welcome(): JSX.Element {
  const { state, actions } = useStore()

  return (
    <div className="welcome">
      <div className="welcome-inner">
        <h1>Frap</h1>
        <p className="tagline">
          An API client whose collections are just files.
          <br />
          One JSON file per request, environments as <code className="mono">.env</code> files —
          commit them, branch them, merge them like the rest of your code.
        </p>

        <div className="row" style={{ justifyContent: 'center' }}>
          <button className="primary" onClick={() => void actions.pickAndOpen()}>
            Open a folder
          </button>
        </div>

        {state.recent.length > 0 && (
          <div className="recent">
            {state.recent.map((entry) => (
              <div
                key={entry.root}
                className="item"
                onClick={() => void actions.open(entry.root)}
              >
                <span>{entry.name}</span>
                <span className="spacer" />
                <span className="p" title={entry.root}>
                  {entry.root}
                </span>
              </div>
            ))}
          </div>
        )}

        <p className="faint" style={{ marginTop: 22, lineHeight: 1.8 }}>
          Any folder works. Frap adds a <code className="mono">frap.workspace.json</code> and reads
          every <code className="mono">*.frap.json</code> below it.
        </p>
      </div>
    </div>
  )
}
