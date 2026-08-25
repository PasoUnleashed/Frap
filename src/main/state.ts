/**
 * Machine-local state, kept in the user's app-data folder.
 *
 * Deliberately out of the workspace folder: recent folders, which environment
 * you picked, which tabs and folders are open, your pane sizes and your send
 * history are yours, not something to commit and conflict over. Only
 * `frap.workspace.json` and the request files are shared.
 *
 * On a portable build this whole file lives in `frap-data` beside the .exe,
 * so all of it travels with the executable.
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import type { HistoryEntry } from '../shared/types.ts'

/** Send history is per workspace and capped, so the file stays small. */
const HISTORY_LIMIT = 300
const RECENT_LIMIT = 12

export interface LayoutState {
  sidebarWidth: number
  responseHeight: number
}

export interface WorkspaceState {
  activeEnvironment: string | null
  openTabs: string[]
  activeTab: string | null
  /** Folders the user has collapsed in the sidebar. Absolute paths. */
  collapsedFolders: string[]
  history: HistoryEntry[]
}

export interface AppState {
  lastWorkspace: string | null
  recentWorkspaces: string[]
  windowBounds?: { width: number; height: number; x?: number; y?: number }
  windowMaximized?: boolean
  layout: LayoutState
  workspaces: Record<string, WorkspaceState>
}

export const DEFAULT_LAYOUT: LayoutState = { sidebarWidth: 280, responseHeight: 45 }

const EMPTY_WORKSPACE: WorkspaceState = {
  activeEnvironment: null,
  openTabs: [],
  activeTab: null,
  collapsedFolders: [],
  history: []
}

const EMPTY: AppState = {
  lastWorkspace: null,
  recentWorkspaces: [],
  layout: DEFAULT_LAYOUT,
  workspaces: {}
}

let cache: AppState | null = null
let writeQueue: Promise<void> = Promise.resolve()

const statePath = (): string => path.join(app.getPath('userData'), 'frap-state.json')

export async function loadState(): Promise<AppState> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(statePath(), 'utf8')
    // Strip a BOM: some editors add one, and JSON.parse chokes on it.
    const parsed = JSON.parse(raw.replace(/^﻿/, '')) as Partial<AppState>
    cache = {
      ...EMPTY,
      ...parsed,
      layout: { ...DEFAULT_LAYOUT, ...(parsed.layout ?? {}) },
      workspaces: parsed.workspaces ?? {}
    }
  } catch {
    cache = { ...EMPTY }
  }
  return cache
}

export async function saveState(patch: Partial<AppState>): Promise<AppState> {
  const current = await loadState()
  cache = { ...current, ...patch }
  const snapshot = cache
  // Serialise writes so two quick updates cannot interleave.
  writeQueue = writeQueue.then(async () => {
    await fs.mkdir(path.dirname(statePath()), { recursive: true })
    await fs.writeFile(statePath(), JSON.stringify(snapshot, null, 2), 'utf8')
  })
  await writeQueue
  return cache
}

export async function getWorkspaceState(root: string): Promise<WorkspaceState> {
  const state = await loadState()
  return { ...EMPTY_WORKSPACE, ...(state.workspaces[root] ?? {}) }
}

export async function setWorkspaceState(
  root: string,
  patch: Partial<WorkspaceState>
): Promise<WorkspaceState> {
  const state = await loadState()
  const next = { ...(await getWorkspaceState(root)), ...patch }
  await saveState({ workspaces: { ...state.workspaces, [root]: next } })
  return next
}

export async function rememberWorkspace(root: string): Promise<void> {
  const state = await loadState()
  const recent = [root, ...state.recentWorkspaces.filter((r) => r !== root)].slice(0, RECENT_LIMIT)
  await saveState({ lastWorkspace: root, recentWorkspaces: recent })
}

export async function forgetWorkspace(root: string): Promise<void> {
  const state = await loadState()
  const workspaces = { ...state.workspaces }
  delete workspaces[root]
  await saveState({
    recentWorkspaces: state.recentWorkspaces.filter((r) => r !== root),
    lastWorkspace: state.lastWorkspace === root ? null : state.lastWorkspace,
    workspaces
  })
}

/* ------------------------------------------------------------------ */
/* Send history                                                        */
/* ------------------------------------------------------------------ */

export async function pushHistory(root: string, entry: HistoryEntry): Promise<void> {
  const current = await getWorkspaceState(root)
  await setWorkspaceState(root, {
    history: [entry, ...current.history].slice(0, HISTORY_LIMIT)
  })
}

export async function clearHistory(root: string): Promise<void> {
  await setWorkspaceState(root, { history: [] })
}

/* ------------------------------------------------------------------ */
/* Layout                                                              */
/* ------------------------------------------------------------------ */

export async function setLayout(patch: Partial<LayoutState>): Promise<LayoutState> {
  const state = await loadState()
  const layout = { ...state.layout, ...patch }
  await saveState({ layout })
  return layout
}
