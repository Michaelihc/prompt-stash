// The whole privileged surface of the app. Runs sandboxed: no filesystem, no Node
// modules, no dynamic channels — every call below is a fixed name the main process
// registered a handler for, so the renderer cannot reach anything else.
import { contextBridge, ipcRenderer } from 'electron'
import type { StashApi } from '../shared/types'

const invoke =
  <T>(channel: string) =>
  (...args: unknown[]): Promise<T> =>
    ipcRenderer.invoke(channel, ...args) as Promise<T>

const api: StashApi = {
  startup: invoke('startup'),
  list: invoke('list'),
  get: invoke('get'),
  create: invoke('create'),
  duplicate: invoke('duplicate'),
  save: invoke('save'),
  saveDraft: invoke('saveDraft'),
  setPinned: invoke('setPinned'),
  setTags: invoke('setTags'),
  projectList: invoke('projectList'),
  projectCreate: invoke('projectCreate'),
  projectRename: invoke('projectRename'),
  projectDelete: invoke('projectDelete'),
  setProject: invoke('setProject'),
  trash: invoke('trash'),
  restore: invoke('restore'),
  purge: invoke('purge'),
  emptyTrash: invoke('emptyTrash'),
  markUsed: invoke('markUsed'),
  search: invoke('search'),
  versions: invoke('versions'),
  restoreVersion: invoke('restoreVersion'),
  settingsGet: invoke('settingsGet'),
  settingsSet: invoke('settingsSet'),
  stats: invoke('stats'),
  backupNow: invoke('backupNow'),
  exportAll: invoke('exportAll'),
  exportMarkdown: invoke('exportMarkdown'),
  importFile: invoke('importFile'),
  openDataFolder: invoke('openDataFolder'),
  copyText: invoke('copyText'),
  setTitleBarTheme: invoke('setTitleBarTheme'),

  /** Tells main the renderer has nothing left to persist and it is safe to close. */
  flushNow: () => {
    ipcRenderer.send('flush-done')
    return Promise.resolve()
  },

  onBeforeQuit: (cb: () => void) => {
    ipcRenderer.on('before-quit', () => cb())
  },
  onThemeChange: (cb: (isDark: boolean) => void) => {
    ipcRenderer.on('theme-changed', (_e, isDark: boolean) => cb(Boolean(isDark)))
  },
}

contextBridge.exposeInMainWorld('stash', api)
