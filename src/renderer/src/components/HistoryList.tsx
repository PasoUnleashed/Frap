import { useMemo, type JSX } from 'react'
import type { HistoryEntry, TreeNode } from '@shared/types'
import { useStore } from '../store'

function relativeTime(at: number): string {
  const seconds = Math.round((Date.now() - at) / 1000)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  const days = Math.floor(seconds / 86_400)
  return days === 1 ? 'yesterday' : `${days}d ago`
}

/** Finds the file a history entry came from, if it still exists. */
function findByRequestId(nodes: TreeNode[], id: string): TreeNode | null {
  for (const node of nodes) {
    if (node.kind === 'request' && node.id === id) return node
    if (node.children) {
      const found = findByRequestId(node.children, id)
      if (found) return found
    }
  }
  return null
}

function statusClass(entry: HistoryEntry): string {
  if (entry.error || entry.status === undefined) return 's0'
  return `s${Math.floor(entry.status / 100)}`
}

/**
 * Everything sent in this workspace, newest first. Stored per machine in app
 * data, so it never shows up in a diff.
 */
export function HistoryList(): JSX.Element {
  const { state, actions } = useStore()

  const grouped = useMemo(() => {
    const groups = new Map<string, HistoryEntry[]>()
    for (const entry of state.history) {
      const day = new Date(entry.at).toDateString()
      const today = new Date().toDateString()
      const label = day === today ? 'Today' : day
      const bucket = groups.get(label)
      if (bucket) bucket.push(entry)
      else groups.set(label, [entry])
    }
    return [...groups.entries()]
  }, [state.history])

  if (state.history.length === 0) {
    return (
      <div className="tree-empty">
        Nothing sent yet.
        <br />
        <br />
        Every request you send is recorded here, per workspace, in your app data
        folder.
      </div>
    )
  }

  return (
    <>
      {grouped.map(([label, entries]) => (
        <div key={label}>
          <div className="history-day">{label}</div>
          {entries.map((entry) => {
            const node = findByRequestId(state.tree, entry.requestId)
            return (
              <div
                key={entry.id}
                className={`history-row${node ? '' : ' orphan'}`}
                title={
                  `${entry.method} ${entry.url}\n` +
                  (entry.error ?? `${entry.status} · ${entry.timeMs} ms`) +
                  (node ? '' : '\n\nThe request this came from no longer exists.')
                }
                onClick={() => node && void actions.openTab(node.path)}
              >
                <span className={`method ${entry.method.toLowerCase()}`}>{entry.method}</span>
                <div className="info">
                  <div className="name">{entry.name}</div>
                  <div className="url mono">{entry.url}</div>
                </div>
                <div className="meta">
                  <span className={`status-code ${statusClass(entry)}`}>
                    {entry.error ? 'ERR' : entry.status}
                  </span>
                  <span className="faint">{relativeTime(entry.at)}</span>
                </div>
              </div>
            )
          })}
        </div>
      ))}
    </>
  )
}
