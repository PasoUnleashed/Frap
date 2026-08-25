/**
 * The only bridge between the renderer and the outside world.
 *
 * Every call goes through a named channel; the renderer never gets `require`,
 * `fs` or raw `ipcRenderer`.
 */
import { contextBridge, ipcRenderer } from 'electron'

interface Envelope<T> {
  ok: boolean
  data?: T
  error?: string
}

/** Unwraps the main-process envelope, turning failures back into exceptions. */
async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as Envelope<T>
  if (!result?.ok) throw new Error(result?.error ?? `${channel} failed`)
  return result.data as T
}

/** Channels main may push to the renderer. Nothing else is forwarded. */
const EVENTS = [
  'workspace:changed',
  'window:maximized',
  'menu:openWorkspace',
  'menu:newRequest',
  'menu:newFolder',
  'menu:importCurl',
  'menu:copyCurl',
  'menu:save',
  'menu:closeTab',
  'menu:send',
  'menu:cancel',
  'menu:focusUrl',
  'menu:environments',
  'menu:history',
  'menu:refresh',
  'menu:scriptingHelp'
] as const

export type FrapEvent = (typeof EVENTS)[number]

const api = {
  workspace: {
    pick: () => call<string | null>('workspace:pick'),
    open: (root: string) => call<unknown>('workspace:open', root),
    refresh: () => call<unknown>('workspace:refresh'),
    saveConfig: (config: unknown) => call<unknown>('workspace:saveConfig', config),
    recent: () => call<{ recent: string[]; last: string | null }>('workspace:recent'),
    forget: (root: string) => call<void>('workspace:forget', root),
    reveal: (target: string) => call<void>('workspace:reveal', target)
  },
  state: {
    get: () => call<unknown>('state:get'),
    set: (patch: unknown) => call<unknown>('state:set', patch)
  },
  requests: {
    read: (absPath: string) => call<unknown>('request:read', absPath),
    save: (absPath: string, req: unknown) => call<boolean>('request:save', absPath, req),
    create: (parentDir: string, name?: string) => call<string>('request:create', parentDir, name),
    duplicate: (absPath: string) => call<string>('request:duplicate', absPath),
    toCurl: (absPath: string, req?: unknown) =>
      call<{ command: string; missing: string[] }>('request:toCurl', absPath, req)
  },
  curl: {
    parse: (text: string, substitute: boolean) =>
      call<{ request: unknown; warnings: string[] }>('curl:parse', text, substitute),
    import: (parentDir: string, text: string, substitute: boolean, name?: string) =>
      call<{ path: string; warnings: string[] }>('curl:import', parentDir, text, substitute, name)
  },
  history: {
    list: () => call<unknown[]>('history:list'),
    clear: () => call<boolean>('history:clear')
  },
  layout: {
    get: () => call<{ sidebarWidth: number; responseHeight: number }>('layout:get'),
    set: (patch: { sidebarWidth?: number; responseHeight?: number }) =>
      call<{ sidebarWidth: number; responseHeight: number }>('layout:set', patch)
  },
  menu: {
    context: (items: unknown[]) => call<string | null>('menu:context', items),
    app: () => call<boolean>('menu:app')
  },
  window: {
    minimize: () => call<boolean>('window:minimize'),
    toggleMaximize: () => call<boolean>('window:toggleMaximize'),
    close: () => call<boolean>('window:close'),
    isMaximized: () => call<boolean>('window:isMaximized')
  },
  clipboard: {
    write: (text: string) => call<boolean>('clipboard:write', text),
    read: () => call<string>('clipboard:read')
  },
  nodes: {
    createFolder: (parentDir: string, name?: string) => call<string>('folder:create', parentDir, name),
    rename: (absPath: string, name: string) => call<string>('node:rename', absPath, name),
    move: (absPath: string, destDir: string) => call<string>('node:move', absPath, destDir),
    reorder: (parentDir: string, ordered: string[]) => call<boolean>('node:reorder', parentDir, ordered),
    remove: (absPath: string) => call<boolean>('node:delete', absPath)
  },
  env: {
    list: () => call<unknown[]>('env:list'),
    add: () => call<unknown>('env:add'),
    createFile: (fileName: string, envName: string) => call<unknown>('env:createFile', fileName, envName),
    remove: (name: string) => call<unknown>('env:remove', name),
    setValue: (name: string, key: string, value: string | null) =>
      call<unknown[]>('env:setValue', name, key, value),
    saveRaw: (name: string, raw: string) => call<unknown[]>('env:saveRaw', name, raw)
  },
  exec: {
    send: (absPath: string, req: unknown) => call<unknown>('exec:send', absPath, req),
    cancel: (runId: string) => call<boolean>('exec:cancel', runId),
    cancelAll: () => call<boolean>('exec:cancelAll')
  },
  vars: {
    scope: () => call<unknown>('vars:scope'),
    list: () => call<Record<string, string>>('vars:list'),
    clear: () => call<boolean>('vars:clear')
  },
  dialog: {
    pickFile: () => call<string | null>('dialog:pickFile'),
    saveFile: (defaultName: string, base64: string) =>
      call<string | null>('dialog:saveFile', defaultName, base64)
  },
  shell: {
    openExternal: (url: string) => call<void>('shell:openExternal', url)
  },
  platform: process.platform,
  /** Subscribes to a main-process event; returns an unsubscribe function. */
  on(event: FrapEvent, listener: (...args: unknown[]) => void): () => void {
    if (!EVENTS.includes(event)) throw new Error(`Unknown event: ${event}`)
    const wrapped = (_e: unknown, ...args: unknown[]): void => listener(...args)
    ipcRenderer.on(event, wrapped)
    return () => ipcRenderer.removeListener(event, wrapped)
  }
}

export type FrapApi = typeof api

contextBridge.exposeInMainWorld('frap', api)
