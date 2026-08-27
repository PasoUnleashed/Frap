import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type JSX,
  type KeyboardEvent,
  type MouseEvent
} from 'react'
import { FOLDER_TAB_PREFIX, REQUEST_EXT, isDraftPath, type TreeNode } from '@shared/types'
import { api, type MenuItem } from '../api'
import { isDirty, isRequestTab, useStore, type RequestTabState } from '../store'
import { HistoryList } from './HistoryList'

const SEPARATOR: MenuItem = { type: 'separator' }

const dirOf = (target: string): string => target.replace(/[\\/][^\\/]+$/, '')

function matches(node: TreeNode, needle: string): boolean {
  if (node.name.toLowerCase().includes(needle)) return true
  return (node.children ?? []).some((child) => matches(child, needle))
}

/**
 * The tree as a flat list of visible rows.
 *
 * Rendering it flat rather than recursively is what makes arrow-key
 * navigation a one-line index change instead of a tree walk.
 */
interface FlatRow {
  node: TreeNode
  depth: number
}

function flatten(
  nodes: TreeNode[],
  collapsed: Record<string, boolean>,
  filter: string,
  depth = 0,
  out: FlatRow[] = []
): FlatRow[] {
  for (const node of nodes) {
    if (filter && !matches(node, filter)) continue
    out.push({ node, depth })
    // A filter reveals everything that matched, however folders were left.
    const open = filter ? true : !collapsed[node.path]
    if (node.kind === 'folder' && open) {
      flatten(node.children ?? [], collapsed, filter, depth + 1, out)
    }
  }
  return out
}

/* ------------------------------------------------------------------ */
/* Row                                                                 */
/* ------------------------------------------------------------------ */

interface RowProps {
  row: FlatRow
  filter: string
  dragOver: string | null
  setDragOver: (path: string | null) => void
}

function Row({ row, filter, dragOver, setDragOver }: RowProps): JSX.Element {
  const { state, actions } = useStore()
  const { node, depth } = row

  const isFolder = node.kind === 'folder'
  const open = filter ? true : !state.collapsed[node.path]
  // A folder's tab is addressed with the `folder:` prefix, so the "currently
  // open" highlight and the unsaved dot have to look for that, not the path.
  const tabPath = isFolder ? FOLDER_TAB_PREFIX + node.path : node.path
  const openInTab = state.activeTab === tabPath
  const selected = state.selected === node.path
  const renaming = state.renaming === node.path
  const cut = state.clip?.mode === 'cut' && state.clip.path === node.path
  const tab = state.tabs.find((t) => t.path === tabPath)
  const unsaved = tab ? isDirty(tab) : false

  const parentDir = isFolder ? node.path : dirOf(node.path)

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
    actions.beginRename(null)
    const next = value.trim()
    if (next && next !== node.name) void actions.rename(node.path, next)
  }

  const onContextMenu = async (event: MouseEvent): Promise<void> => {
    event.preventDefault()
    event.stopPropagation()
    actions.select(node.path)

    const clipboardItems: MenuItem[] = [
      { id: 'copy', label: 'Copy', accelerator: 'CmdOrCtrl+C' },
      { id: 'cut', label: 'Cut', accelerator: 'CmdOrCtrl+X' },
      { id: 'paste', label: isFolder ? 'Paste Into Folder' : 'Paste', accelerator: 'CmdOrCtrl+V' }
    ]

    const items: MenuItem[] = isFolder
      ? [
          { id: 'new-request', label: 'New Request' },
          { id: 'new-folder', label: 'New Folder' },
          { id: 'import-curl', label: 'Import from cURL...', accelerator: 'CmdOrCtrl+I' },
          SEPARATOR,
          { id: 'settings', label: 'Folder Settings...' },
          SEPARATOR,
          ...clipboardItems,
          SEPARATOR,
          { id: 'rename', label: 'Rename', accelerator: 'F2' },
          { id: 'reveal', label: 'Show in File Manager' },
          SEPARATOR,
          { id: 'delete', label: 'Move to Trash', accelerator: 'Delete' }
        ]
      : [
          { id: 'open', label: 'Open' },
          SEPARATOR,
          ...clipboardItems,
          { id: 'duplicate', label: 'Duplicate', accelerator: 'CmdOrCtrl+D' },
          SEPARATOR,
          { id: 'copy-curl', label: 'Copy as cURL', accelerator: 'CmdOrCtrl+Shift+C' },
          { id: 'copy-path', label: 'Copy File Path' },
          SEPARATOR,
          { id: 'rename', label: 'Rename', accelerator: 'F2' },
          { id: 'reveal', label: 'Show in File Manager' },
          SEPARATOR,
          { id: 'delete', label: 'Move to Trash', accelerator: 'Delete' }
        ]

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
      case 'settings':
        void actions.openFolderSettings(node.path, node.name)
        break
      case 'copy':
        void actions.copyNode(node.path)
        break
      case 'cut':
        actions.cutNode(node.path)
        break
      case 'paste':
        void actions.paste(parentDir)
        break
      case 'duplicate':
        void actions.duplicate(node.path)
        break
      case 'copy-curl':
        void actions.copyCurl(node.path)
        break
      case 'copy-path':
        void api.clipboard.write(node.path)
        actions.toast('success', 'Path copied')
        break
      case 'rename':
        actions.beginRename(node.path)
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

  const classes = [
    'tree-row',
    openInTab ? 'open' : '',
    selected ? 'selected' : '',
    cut ? 'cut' : '',
    dragOver === node.path ? 'drop-target' : ''
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div
      className={classes}
      data-path={node.path}
      style={{ paddingLeft: 6 + depth * 12 }}
      draggable={!renaming}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragLeave={() => dragOver === node.path && setDragOver(null)}
      onDrop={onDrop}
      onClick={() => {
        actions.select(node.path)
        // A folder opens its settings, exactly as a request opens itself.
        // Collapsing is the caret's job, and the arrow keys'.
        if (isFolder) void actions.openFolderSettings(node.path, node.name)
        else void actions.openTab(node.path)
      }}
      onDoubleClick={() => actions.beginRename(node.path)}
      onContextMenu={(e) => void onContextMenu(e)}
      title={node.relPath}
    >
      <span
        className={`caret${isFolder ? ' toggle' : ''}`}
        title={isFolder ? (open ? 'Collapse' : 'Expand') : undefined}
        onClick={(e) => {
          if (!isFolder) return
          // Without this the row's own handler would open the tab as well.
          e.stopPropagation()
          actions.select(node.path)
          actions.toggleFolder(node.path)
        }}
      >
        {isFolder ? (open ? '▼' : '▶') : ''}
      </span>
      {isFolder ? (
        <span
          className={`method other${node.hasSettings ? ' has-settings' : ''}`}
          title={node.hasSettings ? 'This folder sets headers, auth or scripts' : undefined}
        >
          DIR
        </span>
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
            e.stopPropagation()
            if (e.key === 'Enter') commitRename((e.target as HTMLInputElement).value)
            if (e.key === 'Escape') actions.beginRename(null)
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
  )
}

/* ------------------------------------------------------------------ */
/* Unsaved collection                                                  */
/* ------------------------------------------------------------------ */

/**
 * The sidebar before a folder has been chosen.
 *
 * There is nothing on disk to scan, so the collection is exactly the drafts
 * that are open. Folders, drag-and-drop and the clipboard need real files, so
 * they are simply not offered here rather than half-working.
 */
function DraftSidebar(): JSX.Element {
  const { state, actions } = useStore()
  const drafts = state.tabs.filter(
    (tab): tab is RequestTabState => isRequestTab(tab) && isDraftPath(tab.path)
  )

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <button className="primary" style={{ flex: 1 }} onClick={() => actions.newDraft()}>
          New request
        </button>
        <button
          title="Paste a cURL command as a request"
          onClick={() => actions.openImportCurl('')}
        >
          ⤓
        </button>
      </div>

      <div className="tree">
        {drafts.length === 0 ? (
          <div className="tree-empty">
            Nothing yet.
            <br />
            <br />
            Add a request and start sending. You choose where the collection
            lives when you save it.
          </div>
        ) : (
          drafts.map((tab) => (
            <div
              key={tab.path}
              className={`tree-row${state.activeTab === tab.path ? ' open' : ''}`}
              style={{ paddingLeft: 6 }}
              onClick={() => actions.selectTab(tab.path)}
              title={tab.request.url || tab.request.name}
            >
              <span className="caret" />
              <span className={`method ${tab.request.method.toLowerCase()}`}>
                {tab.request.method}
              </span>
              <span className="label unsaved">{tab.request.name}</span>
              <span className="actions" onClick={(e) => e.stopPropagation()}>
                <button
                  className="ghost"
                  title="Discard this request"
                  onClick={() => void actions.closeTab(tab.path)}
                >
                  ×
                </button>
              </span>
            </div>
          ))
        )}
      </div>

      <div className="sidebar-foot">
        <span>
          {drafts.length} unsaved request{drafts.length === 1 ? '' : 's'}
        </span>
        <span className="spacer" />
        <button
          disabled={drafts.length === 0}
          title="Choose a folder for this collection (Ctrl+S)"
          onClick={() => void actions.saveDrafts()}
        >
          Save…
        </button>
      </div>
    </aside>
  )
}

/* ------------------------------------------------------------------ */
/* Sidebar                                                             */
/* ------------------------------------------------------------------ */

export function Sidebar(): JSX.Element {
  const { state, actions } = useStore()
  const [filter, setFilter] = useState('')
  const [dragOver, setDragOver] = useState<string | null>(null)
  const treeRef = useRef<HTMLDivElement | null>(null)

  const needle = filter.trim().toLowerCase()
  const rows = useMemo(
    () => flatten(state.tree, state.collapsed, needle),
    [state.tree, state.collapsed, needle]
  )

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

  // When the rename box closes, its input unmounts and focus would otherwise
  // fall to the body, leaving the tree deaf to the keyboard.
  const wasRenaming = useRef(false)
  useEffect(() => {
    if (wasRenaming.current && !state.renaming) treeRef.current?.focus()
    wasRenaming.current = state.renaming !== null
  }, [state.renaming])

  // Keep the selected row on screen when the keyboard moves it.
  useEffect(() => {
    if (!state.selected) return
    treeRef.current
      ?.querySelector<HTMLElement>(`[data-path="${CSS.escape(state.selected)}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [state.selected])

  const onRootDrop = (event: DragEvent): void => {
    event.preventDefault()
    setDragOver(null)
    const source = event.dataTransfer.getData('text/frap-path')
    if (source && state.root) void actions.move(source, state.root)
  }

  /** Where a paste lands: the selected folder, or the folder holding it. */
  const pasteTarget = (): string | null => {
    if (!state.root) return null
    if (!state.selected) return state.root
    const row = rows.find((r) => r.node.path === state.selected)
    if (!row) return state.root
    return row.node.kind === 'folder' ? row.node.path : dirOf(row.node.path)
  }

  /**
   * Shortcuts live here rather than on the window, so Ctrl+C in the URL bar or
   * a script editor still means "copy text".
   */
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const target = event.target as HTMLElement
    // The inline rename box handles its own keys.
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return

    const index = rows.findIndex((r) => r.node.path === state.selected)
    const current = index >= 0 ? rows[index] : null
    const mod = event.ctrlKey || event.metaKey
    const handled = (): void => {
      event.preventDefault()
      event.stopPropagation()
    }
    const selectAt = (next: number): void => {
      const row = rows[Math.min(rows.length - 1, Math.max(0, next))]
      if (row) actions.select(row.node.path)
    }

    if (mod && !event.altKey) {
      switch (event.key.toLowerCase()) {
        case 'c':
          if (!current) return
          handled()
          void actions.copyNode(current.node.path)
          return
        case 'x':
          if (!current) return
          handled()
          actions.cutNode(current.node.path)
          return
        case 'v': {
          const dest = pasteTarget()
          if (!dest) return
          handled()
          void actions.paste(dest)
          return
        }
        case 'd':
          if (!current || current.node.kind !== 'request') return
          handled()
          void actions.duplicate(current.node.path)
          return
        default:
          return
      }
    }

    switch (event.key) {
      case 'ArrowDown':
        handled()
        selectAt(index < 0 ? 0 : index + 1)
        return
      case 'ArrowUp':
        handled()
        selectAt(index < 0 ? rows.length - 1 : index - 1)
        return
      case 'ArrowRight':
        if (!current) return
        handled()
        if (current.node.kind === 'folder' && state.collapsed[current.node.path]) {
          actions.expandFolder(current.node.path)
        } else {
          selectAt(index + 1)
        }
        return
      case 'ArrowLeft': {
        if (!current) return
        handled()
        if (current.node.kind === 'folder' && !state.collapsed[current.node.path]) {
          actions.toggleFolder(current.node.path)
          return
        }
        // Otherwise jump to the folder this row sits in.
        const parent = dirOf(current.node.path)
        const parentRow = rows.find((r) => r.node.path === parent)
        if (parentRow) actions.select(parentRow.node.path)
        return
      }
      case 'Home':
        handled()
        selectAt(0)
        return
      case 'End':
        handled()
        selectAt(rows.length - 1)
        return
      case 'Enter':
        if (!current) return
        handled()
        // Mirrors clicking the row: open it. Left and Right collapse.
        if (current.node.kind === 'folder') {
          void actions.openFolderSettings(current.node.path, current.node.name)
        } else {
          void actions.openTab(current.node.path)
        }
        return
      case 'F2':
        if (!current) return
        handled()
        actions.beginRename(current.node.path)
        return
      case 'Delete':
      case 'Backspace':
        if (!current) return
        handled()
        void actions.remove(current.node.path, current.node.name)
        return
      case 'Escape':
        if (!state.clip) return
        handled()
        actions.clearClip()
        return
      default:
        break
    }
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
      { id: 'settings', label: 'Collection Settings...' },
      SEPARATOR,
      { id: 'paste', label: 'Paste', accelerator: 'CmdOrCtrl+V' },
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
      case 'settings':
        void actions.openFolderSettings('', 'Collection')
        break
      case 'paste':
        void actions.paste(state.root)
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

  // Before a folder is chosen there is no tree to scan and no history to
  // show: the collection is whatever drafts are open.
  if (!state.root) return <DraftSidebar />

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
            ref={treeRef}
            tabIndex={0}
            onKeyDown={onKeyDown}
            onMouseDown={() => treeRef.current?.focus()}
            onDragOver={(e) => {
              if (e.dataTransfer.types.includes('text/frap-path')) e.preventDefault()
            }}
            onDrop={onRootDrop}
            onContextMenu={(e) => void onRootContextMenu(e)}
          >
            {rows.length === 0 ? (
              <div className="tree-empty">
                {state.tree.length === 0 ? (
                  <>
                    Nothing here yet.
                    <br />
                    <br />
                    Right-click to add a request, or copy a cURL command and press{' '}
                    <b>Ctrl+V</b>. Every request is one <code className="mono">.frap.json</code>{' '}
                    file, so this folder is safe to commit.
                  </>
                ) : (
                  <>No request matches “{filter.trim()}”.</>
                )}
              </div>
            ) : (
              rows.map((row) => (
                <Row
                  key={row.node.path}
                  row={row}
                  filter={needle}
                  dragOver={dragOver}
                  setDragOver={setDragOver}
                />
              ))
            )}
          </div>

          <div className="sidebar-foot">
            {state.clip ? (
              <button
                className="clip-chip"
                title="Click to clear. Ctrl+V pastes into the selected folder."
                onClick={() => actions.clearClip()}
              >
                <span className="what">{state.clip.mode === 'cut' ? 'Cut' : 'Copied'}</span>
                <span className="who">
                  {state.clip.path.split(/[\\/]/).pop()?.replace(REQUEST_EXT, '')}
                </span>
                <span className="x">✕</span>
              </button>
            ) : (
              <span>
                {counts.requests} request{counts.requests === 1 ? '' : 's'}
                {counts.folders > 0 &&
                  ` · ${counts.folders} folder${counts.folders === 1 ? '' : 's'}`}
              </span>
            )}
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
            <span>{state.history.length} sent</span>
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
