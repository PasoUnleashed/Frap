import { app, BrowserWindow, Menu, shell, nativeTheme } from 'electron'
import * as path from 'node:path'
import { disposeIpc, registerIpc } from './ipc.ts'
import { loadState, saveState } from './state.ts'

// electron-builder's portable target sets this to the folder the .exe lives
// in. Keeping settings beside the executable is what makes the build portable
// in practice: copy the exe to a USB stick and your recent workspaces come too.
const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
if (portableDir) {
  app.setPath('userData', path.join(portableDir, 'frap-data'))
}

let mainWindow: BrowserWindow | null = null

const isDev = !app.isPackaged

async function createWindow(): Promise<void> {
  const state = await loadState()
  const bounds = state.windowBounds

  mainWindow = new BrowserWindow({
    width: bounds?.width ?? 1440,
    height: bounds?.height ?? 900,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 940,
    minHeight: 560,
    show: false,
    backgroundColor: '#111318',
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  const persistBounds = (): void => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.isMinimized()) return
    const { width, height, x, y } = mainWindow.getBounds()
    void saveState({ windowBounds: { width, height, x, y } })
  }
  mainWindow.on('resized', persistBounds)
  mainWindow.on('moved', persistBounds)
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // The renderer only ever shows our own UI. Anything else opens in the
  // system browser instead of navigating the app away.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url !== mainWindow?.webContents.getURL()) event.preventDefault()
  })

  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const send = (channel: string): void => {
    mainWindow?.webContents.send(channel)
  }

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(isMac ? [{ role: 'appMenu' as const }] : []),
      {
        label: '&File',
        submenu: [
          { label: 'Open Workspace...', accelerator: 'CmdOrCtrl+O', click: () => send('menu:openWorkspace') },
          { label: 'New Request', accelerator: 'CmdOrCtrl+N', click: () => send('menu:newRequest') },
          { label: 'New Folder', accelerator: 'CmdOrCtrl+Shift+N', click: () => send('menu:newFolder') },
          { type: 'separator' },
          { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('menu:save') },
          { label: 'Close Tab', accelerator: 'CmdOrCtrl+W', click: () => send('menu:closeTab') },
          { type: 'separator' },
          isMac ? { role: 'close' as const } : { role: 'quit' as const }
        ]
      },
      { role: 'editMenu' },
      {
        label: '&Request',
        submenu: [
          { label: 'Send', accelerator: 'CmdOrCtrl+Return', click: () => send('menu:send') },
          { label: 'Cancel', accelerator: 'CmdOrCtrl+.', click: () => send('menu:cancel') },
          { type: 'separator' },
          { label: 'Focus URL', accelerator: 'CmdOrCtrl+L', click: () => send('menu:focusUrl') }
        ]
      },
      {
        label: '&View',
        submenu: [
          { label: 'Environments', accelerator: 'CmdOrCtrl+E', click: () => send('menu:environments') },
          { label: 'Refresh from Disk', accelerator: 'CmdOrCtrl+R', click: () => send('menu:refresh') },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          { role: 'toggleDevTools' }
        ]
      },
      {
        label: '&Help',
        submenu: [
          {
            label: 'Scripting Reference',
            accelerator: 'F1',
            click: () => send('menu:scriptingHelp')
          }
        ]
      }
    ])
  )
}

// One window is the whole app; a second instance should focus the first.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    nativeTheme.themeSource = 'dark'
    registerIpc(() => mainWindow)
    buildMenu()
    await createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', disposeIpc)
}
