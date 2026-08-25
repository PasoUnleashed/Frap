import { useMemo, useState, type DragEvent, type JSX } from 'react'
import type { TreeNode } from '@shared/types'
import { isDirty, useStore } from '../store'

/** Folder open/closed state lives here; it is UI-only and not persisted. */
type Expanded = Record<string, boolean>

function matches(node: TreeNode, needle: string): boolean {
  if (node.name.toLowerCase().includes(needle)) return true
  return (node.children ?? []).some((child) => matches(child, needle))
}

interface RowProps {
  node: TreeNode
  depth: number
  expanded: Expanded
  toggle: (path: string) => void
  filter: string
  dragOver: string | null
  setDragOver: (path: string | null) => void
}

function Row({
  node,
  depth,
  expanded,
  toggle,
  filter,
  dragOver,
  setDragOver
}: RowProps): JSX.Element | null {
  const { state, actions } = useStore()
  const [renaming, setRenaming] = useState(false)

  if (filter && !matches(node, filter)) return null

  const isFolder = node.kind === 'folder'
  // A filtered search reveals everything that matched.
  const open = filter ? true : (expanded[node.path] ?? depth === 0)
  const active = state.activeTab === node.path
  const tab = state.tabs.find((t) => t.path === node.path)
  const unsaved = tab ? isDirty(tab) : false

  const onDragStart = (event: DragEvent): void => {
    event.dataTransfer.setData('text/frap-path', node.path)
    event.dataTransfer.effectAllowed = 'move'
  }

  const onDragOver = (event: DragEvent): void => {
    if (!isFolder) return
    const source = event.dataTransfer.types.includes('text/frap-path')
    if (!source) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'move'
    setDragOver(node.path)
  }

  const onDrop = (event: DragEvent): void => {
    if (!isFolder) return
    event.preventDefault()
    setDragOver(null)
    const source = event.dataTransfer.getData('text/frap-path')
    if (source && source !== node.path) void actions.move(source, node.path)
  }

  const commitRename = (value: string): void => {
    setRenaming(false)
    const next = value.trim()
    if (next && next !== node.name) void actions.rename(node.path, next)
  }

  return (
    <>
      <div
        className={`tree-row${active ? ' active' : ''}${dragOver === node.path ? ' drop-target' : ''}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        draggable={!renaming}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={() => dragOver === node.path && setDragOver(null)}
        onDrop={onDrop}
        onClick={() => (isFolder ? toggle(node.path) : void actions.openTab(node.path))}
        onDoubleClick={() => setRenaming(true)}
        title={node.relPath}
      >
        <span className="caret">{isFolder ? (open ? '▼' : '▶') : ''}</span>
        {isFolder ? (
          <span className="method other">DIR</span>
        ) : (
          <span className={`method ${(node.method ?? 'get').toLowerCase()}`}>{node.method}</span>
        )}

        {renaming ? (
          <input
            type="text"
            defaultValue={node.name}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onBlur={(e) => commitRename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename((e.target as HTMLInputElement).value)
              if (e.key === 'Escape') setRenaming(false)
            }}
          />
        ) : (
          <span className={`label${unsaved ? ' unsaved' : ''}`}>{node.name}</span>
        )}

        <span className="actions" onClick={(e) => e.stopPropagation()}>
          {isFolder && (
            <>
              <button
                className="ghost"
                title="New request here"
                onClick={() => void actions.createRequest(node.path)}
              >
                +
              </button>
              <button
                className="ghost"
                title="New folder here"
                onClick={() => void actions.createFolder(node.path)}
              >
                ⊞
              </button>
            </>
          )}
          {!isFolder && (
            <button
              className="ghost"
              title="Duplicate"
              onClick={() => void actions.duplicate(node.path)}
            >
              ⧉
            </button>
          )}
          <button
            className="ghost danger"
            title="Move to trash"
            onClick={() => void actions.remove(node.path, node.name)}
          >
            ×
          </button>
        </span>
      </div>

      {isFolder &&
        open &&
        (node.children ?? []).map((child) => (
          <Row
            key={child.path}
            node={child}
            depth={depth + 1}
            expanded={expanded}
            toggle={toggle}
            filter={filter}
            dragOver={dragOver}
            setDragOver={setDragOver}
          />
        ))}
    </>
  )
}

export function Sidebar(): JSX.Element {
  const { state, actions } = useStore()
  const [expanded, setExpanded] = useState<Expanded>({})
  const [filter, setFilter] = useState('')
  const [dragOver, setDragOver] = useState<string | null>(null)

  const toggle = (path: string): void =>
    setExpanded((prev) => ({ ...prev, [path]: !(prev[path] ?? true) }))

  const counts = useMemo(() => {
    let requests = 0
    let folders = 0
    const walk = (nodes: TreeNode[]): void => {
      for (const node of nodes) {
        if (node.kind === 'folder') {
          folders++
          walk(node.children ?? [])
        } else requests++
      }
    }
    walk(state.tree)
    return { requests, folders }
  }, [state.tree])

  const onRootDrop = (event: DragEvent): void => {
    event.preventDefault()
    setDragOver(null)
    const source = event.dataTransfer.getData('text/frap-path')
    if (source && state.root) void actions.move(source, state.root)
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <input
          type="search"
          placeholder="Filter requests"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button
          title="New request"
          onClick={() => state.root && void actions.createRequest(state.root)}
        >
          +
        </button>
        <button
          title="New folder"
          onClick={() => state.root && void actions.createFolder(state.root)}
        >
          ⊞
        </button>
      </div>

      <div
        className="tree"
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('text/frap-path')) e.preventDefault()
        }}
        onDrop={onRootDrop}
      >
        {state.tree.length === 0 ? (
          <div className="tree-empty">
            Nothing here yet.
            <br />
            <br />
            Every request is one <code className="mono">.frap.json</code> file, so this folder is
            safe to commit.
          </div>
        ) : (
          state.tree.map((node) => (
            <Row
              key={node.path}
              node={node}
              depth={0}
              expanded={expanded}
              toggle={toggle}
              filter={filter.trim().toLowerCase()}
              dragOver={dragOver}
              setDragOver={setDragOver}
            />
          ))
        )}
      </div>

      <div className="sidebar-foot">
        <span>
          {counts.requests} request{counts.requests === 1 ? '' : 's'}
          {counts.folders > 0 && ` · ${counts.folders} folder${counts.folders === 1 ? '' : 's'}`}
        </span>
        <span className="spacer" />
        <button
          className="ghost"
          title="Reload from disk"
          onClick={() => void actions.refresh()}
        >
          ⟳
        </button>
      </div>
    </aside>
  )
}
