/**
 * Machine-local UI state.
 *
 * Deliberately kept out of the workspace folder: which environment you have
 * selected and which tabs you have open are yours, not something to commit and
 * conflict over. Only `frap.workspace.json` and the request files are shared.
 */
import { app } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

export interface WorkspaceState {
  activeEnvironment: string | null
  openTabs: string[]
  activeTab: string | null
}

export interface AppState {
  lastWorkspace: string | null
  recentWorkspaces: string[]
  windowBounds?: { width: number; height: number; x?: number; y?: number }
  workspaces: Record<string, WorkspaceState>
}

const EMPTY: AppState = { lastWorkspace: null, recentWorkspaces: [], workspaces: {} }

let cache: AppState | null = null
let writeQueue: Promise<void> = Promise.resolve()

const statePath = (): string => path.join(app.getPath('userData'), 'frap-state.json')

export async function loadState(): Promise<AppState> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(statePath(), 'utf8')
    // Strip a BOM: some editors add one, and JSON.parse chokes on it.
    cache = { ...EMPTY, ...(JSON.parse(raw.replace(/^﻿/, '')) as AppState) }
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
  return state.workspaces[root] ?? { activeEnvironment: null, openTabs: [], activeTab: null }
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
  const recent = [root, ...state.recentWorkspaces.filter((r) => r !== root)].slice(0, 10)
  await saveState({ lastWorkspace: root, recentWorkspaces: recent })
}

export async function forgetWorkspace(root: string): Promise<void> {
  const state = await loadState()
  await saveState({
    recentWorkspaces: state.recentWorkspaces.filter((r) => r !== root),
    lastWorkspace: state.lastWorkspace === root ? null : state.lastWorkspace
  })
}
