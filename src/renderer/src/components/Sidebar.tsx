import { useMemo, useState, type DragEvent, type JSX, type MouseEvent } from 'react'
import type { TreeNode } from '@shared/types'
import { api, type MenuItem } from '../api'
import { isDirty, useStore } from '../store'
import { HistoryList } from './HistoryList'

const SEPARATOR: MenuItem = { type: 'separator' }

function matches(node: TreeNode, needle: string): boolean {
  if (node.name.toLowerCase().includes(needle)) return true
  return (node.children ?? []).some((child) => matches(child, needle))
}

interface RowProps {
  node: TreeNode
  depth: number
  filter: string
  dragOver: string | null
  setDragOver: (path: string | null) => void
}

function Row({ node, depth, filter, dragOver, setDragOver }: RowProps): JSX.Element | null {
  const { state, actions } = useStore()
  const [renaming, setRenaming] = useState(false)

  if (filter && !matches(node, filter)) return null

  const isFolder = node.kind === 'folder'
  // A filtered search reveals everything that matched.
  const open = filter ? true : !state.collapsed[node.path]
  const active = state.activeTab === node.path
  const tab = state.tabs.find((t) => t.path === node.path)
  const unsaved = tab ? isDirty(tab) : false

  const onDragStart = (event: DragEvent): void => {
    event.dataTransfer.setData('text/frap-path', node.path)
    event.dataTransfer.effectAllowed = 'move'
  }

  const onDragOver = (event: DragEvent): void => {
    if (!isFolder || !event.dataTransfer.types.includes('text/frap-path')) return
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

  const onContextMenu = async (event: MouseEvent): Promise<void> => {
    event.preventDefault()
    event.stopPropagation()

    const items: MenuItem[] = isFolder
      ? [
          { id: 'new-request', label: 'New Request' },
          { id: 'new-folder', label: 'New Folder' },
          { id: 'import-curl', label: 'Import from cURL...', accelerator: 'CmdOrCtrl+I' },
          SEPARATOR,
          { id: 'rename', label: 'Rename' },
          { id: 'reveal', label: 'Show in File Manager' },
          SEPARATOR,
          { id: 'delete', label: 'Move to Trash' }
        ]
      : [
          { id: 'open', label: 'Open' },
          SEPARATOR,
          { id: 'copy-curl', label: 'Copy as cURL', accelerator: 'CmdOrCtrl+Shift+C' },
          { id: 'copy-path', label: 'Copy File Path' },
          SEPARATOR,
          { id: 'rename', label: 'Rename' },
          { id: 'duplicate', label: 'Duplicate' },
          { id: 'reveal', label: 'Show in File Manager' },
          SEPARATOR,
          { id: 'delete', label: 'Move to Trash' }
        ]

    const parentDir = isFolder ? node.path : node.path.replace(/[\\/][^\\/]+$/, '')

    switch (await api.contextMenu(items)) {
      case 'open':
        void actions.openTab(node.path)
        break
      case 'new-request':
        void actions.createRequest(node.path)
        break
      case 'new-folder':
        void actions.createFolder(node.path)
        break
      case 'import-curl':
        actions.openImportCurl(parentDir)
        break
      case 'copy-curl':
        void actions.copyCurl(node.path)
        break
      case 'copy-path':
        void api.clipboard.write(node.path)
        actions.toast('success', 'Path copied')
        break
      case 'rename':
        setRenaming(true)
        break
      case 'duplicate':
        void actions.duplicate(node.path)
        break
      case 'reveal':
        void api.reveal(node.path)
        break
      case 'delete':
        void actions.remove(node.path, node.name)
        break
      default:
        break
    }
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
        onClick={() => (isFolder ? actions.toggleFolder(node.path) : void actions.openTab(node.path))}
        onDoubleClick={() => setRenaming(true)}
        onContextMenu={(e) => void onContextMenu(e)}
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
          {isFolder ? (
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
          ) : (
            <button
              className="ghost"
              title="Copy as cURL"
              onClick={() => void actions.copyCurl(node.path)}
            >
              ⌘
            </button>
          )}
        </span>
      </div>

      {isFolder &&
        open &&
        (node.children ?? []).map((child) => (
          <Row
            key={child.path}
            node={child}
            depth={depth + 1}
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
  const [filter, setFilter] = useState('')
  const [dragOver, setDragOver] = useState<string | null>(null)

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

  /** Right-clicking empty space targets the workspace root. */
  const onRootContextMenu = async (event: MouseEvent): Promise<void> => {
    event.preventDefault()
    if (!state.root) return
    const choice = await api.contextMenu([
      { id: 'new-request', label: 'New Request', accelerator: 'CmdOrCtrl+N' },
      { id: 'new-folder', label: 'New Folder', accelerator: 'CmdOrCtrl+Shift+N' },
      { id: 'import-curl', label: 'Import from cURL...', accelerator: 'CmdOrCtrl+I' },
      SEPARATOR,
      { id: 'refresh', label: 'Reload from Disk', accelerator: 'CmdOrCtrl+R' },
      { id: 'reveal', label: 'Show in File Manager' }
    ])
    switch (choice) {
      case 'new-request':
        void actions.createRequest(state.root)
        break
      case 'new-folder':
        void actions.createFolder(state.root)
        break
      case 'import-curl':
        actions.openImportCurl(state.root)
        break
      case 'refresh':
        void actions.refresh()
        break
      case 'reveal':
        void api.reveal(state.root)
        break
      default:
        break
    }
  }

  const showingTree = state.sidebarView === 'tree'

  return (
    <aside className="sidebar">
      <div className="sidebar-tabs">
        <button
          className={showingTree ? 'active' : ''}
          onClick={() => actions.setSidebarView('tree')}
        >
          Collection
        </button>
        <button
          className={showingTree ? '' : 'active'}
          onClick={() => actions.setSidebarView('history')}
          title="Everything you have sent in this workspace (Ctrl+H)"
        >
          History
          {state.history.length > 0 && <span className="badge">{state.history.length}</span>}
        </button>
      </div>

      {showingTree ? (
        <>
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
              title="Import from cURL"
              onClick={() => state.root && actions.openImportCurl(state.root)}
            >
              ⤓
            </button>
          </div>

          <div
            className="tree"
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('text/frap-path')) e.preventDefault()
            }}
            onDrop={onRootDrop}
            onContextMenu={(e) => void onRootContextMenu(e)}
          >
            {state.tree.length === 0 ? (
              <div className="tree-empty">
                Nothing here yet.
                <br />
                <br />
                Right-click to add a request or paste one in from cURL. Every request is one{' '}
                <code className="mono">.frap.json</code> file, so this folder is safe to commit.
              </div>
            ) : (
              state.tree.map((node) => (
                <Row
                  key={node.path}
                  node={node}
                  depth={0}
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
            <button className="ghost" title="Reload from disk" onClick={() => void actions.refresh()}>
              ⟳
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="tree">
            <HistoryList />
          </div>
          <div className="sidebar-foot">
            <span>
              {state.history.length} sent
            </span>
            <span className="spacer" />
            <button
              className="ghost"
              disabled={state.history.length === 0}
              onClick={() => {
                if (window.confirm('Clear the send history for this workspace?')) {
                  void actions.clearHistory()
                }
              }}
            >
              Clear
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
