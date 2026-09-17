import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeTheme,
  shell,
} from 'electron'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { Store } from './store'
import type { ID, Settings } from '../shared/types'

// Note for anyone debugging a launch that does nothing: if ELECTRON_RUN_AS_NODE is set
// in the environment, this executable behaves as plain `node`, and with no script
// argument it exits before a single line of this file runs. No in-app guard can catch
// that. Clear the variable in the shell you are launching from.

// Fixed before app.ready: keeps the taskbar icon and jump list attached to the
// installed app rather than to electron.exe.
app.setAppUserModelId('com.michael.promptstash')
// Pins userData to %APPDATA%\Prompt Stash. Without this a development run resolves
// the name to "Electron" and reads a different stash than the installed app.
app.setName('Prompt Stash')

const isDev = process.env.PROMPT_STASH_DEV === '1'

// One window owns the database. A second instance would open the same file and the two
// would overwrite each other's in-memory view, so hand focus to the first instead.
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}

let win: BrowserWindow | null = null
let store: Store | null = null

// Startup work is ordered so nothing competes with the first paint.
function getStore(): Store {
  if (!store) {
    store = new Store(app.getPath('userData'))
    store.open()
  }
  return store
}

function themeColors(dark: boolean): { color: string; symbolColor: string } {
  return dark
    ? { color: '#12151c', symbolColor: '#8f98ab' }
    : { color: '#fbfaf7', symbolColor: '#6b7180' }
}

async function createWindow(): Promise<void> {
  const s = getStore()
  const settings = s.report.fatal ? null : s.settingsGet()
  const bounds = settings?.windowBounds
  const dark = resolveDark(settings?.theme ?? 'dark')

  win = new BrowserWindow({
    width: bounds?.width ?? 1180,
    height: bounds?.height ?? 780,
    x: bounds?.x,
    y: bounds?.y,
    minWidth: 720,
    minHeight: 480,
    // Painting starts with the app's own background, so there is no white flash
    // between the window appearing and the first frame of the UI.
    backgroundColor: dark ? '#12151c' : '#fbfaf7',
    show: false,
    autoHideMenuBar: true,
    title: 'Prompt Stash',
    titleBarStyle: 'hidden',
    titleBarOverlay: { ...themeColors(dark), height: 38 },
    webPreferences: {
      preload: join(__dirname, '../preload/preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: true,
      // The renderer is a single local page that never idles work; leaving it
      // throttled when hidden keeps background CPU at zero.
      backgroundThrottling: true,
    },
  })

  if (bounds?.maximized) win.maximize()

  // Nothing in this app should ever navigate or open a second window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  win.webContents.on('will-attach-webview', (e) => e.preventDefault())

  // Windows is ending the session (logoff, restart). There is no time for an IPC
  // round-trip here, but the drafts table already holds anything typed in the last
  // fraction of a second, so the only job is to close the database cleanly.
  win.on('session-end', () => {
    closeState = 'done'
    store?.close()
  })

  win.once('ready-to-show', () => {
    win?.show()
    // Deferred so it cannot compete with the first frame.
    setTimeout(() => void store?.maybeBackup(), 2000)
    if (isDev && process.env.PROMPT_STASH_DEVTOOLS === '1') {
      win?.webContents.openDevTools({ mode: 'detach' })
    }
    void maybeCapture()
  })

  let boundsTimer: NodeJS.Timeout | null = null
  const rememberBounds = () => {
    if (!win || win.isDestroyed()) return
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      if (!win || win.isDestroyed() || !store || store.report.fatal) return
      const maximized = win.isMaximized()
      const b = win.getNormalBounds()
      store.settingsSet({
        windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height, maximized },
      })
    }, 400)
  }
  win.on('resize', rememberBounds)
  win.on('move', rememberBounds)
  win.on('maximize', rememberBounds)
  win.on('unmaximize', rememberBounds)
  // The renderer may hold text that has not reached the database yet. Closing is
  // deferred until it confirms a flush, with a hard timeout so a wedged renderer can
  // never stop the window from closing. app.quit() routes through here too.
  win.on('close', (event) => {
    if (closeState === 'done' || !win) return
    event.preventDefault()
    if (closeState === 'flushing') return
    closeState = 'flushing'
    const finish = (): void => {
      if (closeState === 'done') return
      closeState = 'done'
      clearTimeout(timer)
      ipcMain.removeListener('flush-done', finish)
      win?.destroy()
    }
    const timer = setTimeout(finish, 1500)
    ipcMain.once('flush-done', finish)
    win.webContents.send('before-quit')
  })

  win.on('closed', () => {
    win = null
  })

  if (isDev) {
    win.webContents.on('before-input-event', (_e, input) => {
      if (input.type === 'keyDown' && input.key === 'F12') win?.webContents.toggleDevTools()
      if (input.type === 'keyDown' && input.key === 'F5') win?.webContents.reload()
    })
  }

  await win.loadFile(join(__dirname, '../renderer/index.html'))
}

function resolveDark(theme: Settings['theme']): boolean {
  if (theme === 'system') return nativeTheme.shouldUseDarkColors
  return theme === 'dark'
}

/**
 * Development-only screenshot hook, used to review the interface during build.
 * Inert unless PROMPT_STASH_DEV is set, so it cannot fire in a packaged app.
 */
async function maybeCapture(): Promise<void> {
  const target = process.env.PROMPT_STASH_SHOT
  if (!isDev || !target || !win) return
  const setup = process.env.PROMPT_STASH_SHOT_JS
  await new Promise((r) => setTimeout(r, 700))
  if (setup) {
    let result: unknown = null
    try {
      result = await win.webContents.executeJavaScript(setup, true)
    } catch (err) {
      console.error('[shot] setup script failed', err)
      result = { error: String((err as Error)?.message ?? err) }
    }
    const resultPath = process.env.PROMPT_STASH_SHOT_RESULT
    if (resultPath) await writeFile(resultPath, JSON.stringify(result ?? null), 'utf8')
    await new Promise((r) => setTimeout(r, 450))
  }
  const image = await win.webContents.capturePage()
  await writeFile(target, image.toPNG())
  console.log(`[shot] wrote ${target}`)
  if (process.env.PROMPT_STASH_SHOT_QUIT === '1') {
    closeState = 'done'
    app.exit(0)
  }
}

// ------------------------------------------------------------------ IPC

/** Wraps a handler so a store failure surfaces as a rejected promise, never a crash. */
function handle(channel: string, fn: (...args: never[]) => unknown): void {
  ipcMain.handle(channel, async (_event, ...args) => {
    try {
      return await (fn as (...a: unknown[]) => unknown)(...args)
    } catch (err) {
      console.error(`[ipc] ${channel} failed`, err)
      throw new Error(String((err as Error)?.message ?? err))
    }
  })
}

function registerIpc(): void {
  handle('startup', () => getStore().report)
  handle('list', () => getStore().list())
  handle('get', (id: ID) => getStore().get(id))
  handle('create', (init?: { title?: string; body?: string; tags?: string[] }) =>
    getStore().create(init ?? {}),
  )
  handle('duplicate', (id: ID) => getStore().duplicate(id))
  handle('save', (patch: { id: ID; title: string; body: string }) => getStore().save(patch))
  handle('saveDraft', (patch: { id: ID; title: string; body: string }) => getStore().saveDraft(patch))
  handle('setPinned', (id: ID, pinned: boolean) => getStore().setPinned(id, pinned))
  handle('setTags', (id: ID, tags: string[]) => getStore().setTags(id, tags))
  handle('projectList', () => getStore().projectList())
  handle('projectCreate', (name: string) => getStore().projectCreate(name))
  handle('projectRename', (id: ID, name: string) => getStore().projectRename(id, name))
  handle('projectDelete', (id: ID) => getStore().projectDelete(id))
  handle('setProject', (promptId: ID, projectId: ID | null) => getStore().setProject(promptId, projectId))
  handle('trash', (ids: ID[]) => getStore().trash(ids))
  handle('restore', (ids: ID[]) => getStore().restore(ids))
  handle('purge', (ids: ID[]) => getStore().purge(ids))
  handle('emptyTrash', () => getStore().emptyTrash())
  handle('markUsed', (id: ID) => getStore().markUsed(id))
  handle('search', (q: string) => getStore().search(q))
  handle('versions', (id: ID) => getStore().versions(id))
  handle('restoreVersion', (id: ID, versionId: number) => getStore().restoreVersion(id, versionId))
  handle('settingsGet', () => getStore().settingsGet())
  handle('settingsSet', (patch: Partial<Settings>) => getStore().settingsSet(patch))
  handle('stats', () => getStore().stats())
  handle('backupNow', () => getStore().backup())
  handle('openDataFolder', () => shell.openPath(getStore().dataDir))
  handle('copyText', (text: string) => clipboard.writeText(text))

  handle('setTitleBarTheme', (background: string, symbol: string) => {
    if (!win || win.isDestroyed()) return
    try {
      win.setTitleBarOverlay({ color: background, symbolColor: symbol, height: 38 })
      win.setBackgroundColor(background)
    } catch {
      /* the overlay is Windows-only and cosmetic */
    }
  })

  handle('exportAll', async () => {
    if (!win) return null
    const stamp = new Date().toISOString().slice(0, 10)
    const res = await dialog.showSaveDialog(win, {
      title: 'Export all prompts',
      defaultPath: `prompt-stash-${stamp}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    })
    if (res.canceled || !res.filePath) return null
    const data = getStore().exportAll()
    await writeFile(res.filePath, JSON.stringify(data, null, 2), 'utf8')
    return { path: res.filePath, count: data.prompts.length }
  })

  handle('exportMarkdown', async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Choose a folder for the Markdown files',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (res.canceled || !res.filePaths[0]) return null
    const dir = join(res.filePaths[0], 'prompt-stash')
    await mkdir(dir, { recursive: true })
    const { prompts } = getStore().exportAll()
    const used = new Set<string>()
    let count = 0
    for (const p of prompts) {
      if (p.trashedAt) continue
      let name = slugify(p.title) || 'untitled'
      let n = 2
      while (used.has(name)) name = `${slugify(p.title) || 'untitled'}-${n++}`
      used.add(name)
      const front = [
        '---',
        `title: ${JSON.stringify(p.title)}`,
        `tags: [${p.tags.map((t) => JSON.stringify(t)).join(', ')}]`,
        `created: ${new Date(p.createdAt).toISOString()}`,
        `updated: ${new Date(p.updatedAt).toISOString()}`,
        '---',
        '',
      ].join('\n')
      await writeFile(join(dir, `${name}.md`), front + p.body, 'utf8')
      count++
    }
    return { path: dir, count }
  })

  handle('importFile', async () => {
    if (!win) return null
    const res = await dialog.showOpenDialog(win, {
      title: 'Import prompts',
      filters: [{ name: 'JSON', extensions: ['json'] }],
      properties: ['openFile'],
    })
    if (res.canceled || !res.filePaths[0]) return null
    const text = await readFile(res.filePaths[0], 'utf8')
    return getStore().import(JSON.parse(text))
  })
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

// ------------------------------------------------------- lifecycle & shutdown

let closeState: 'open' | 'flushing' | 'done' = 'open'

// Runs after every window is gone, on every quit path, so the database is always
// closed cleanly and its statistics refreshed.
app.on('will-quit', () => {
  store?.close()
  store = null
})

app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.focus()
})

app.on('window-all-closed', () => app.quit())

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void createWindow()
})

nativeTheme.on('updated', () => {
  win?.webContents.send('theme-changed', nativeTheme.shouldUseDarkColors)
})

app.whenReady().then(async () => {
  // No application menu: the app is keyboard-driven from the renderer, and an empty
  // menu bar would intrude on the custom title bar. Native editing shortcuts in text
  // fields are handled by Chromium and are unaffected.
  Menu.setApplicationMenu(null)
  registerIpc()
  await createWindow()
})
