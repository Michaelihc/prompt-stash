import type { ID, Settings } from '../shared/types'
import { Editor } from './editor'
import { IndexList } from './list'
import {
  closeOverlay,
  isOverlayOpen,
  openConfirmSheet,
  openHistorySheet,
  openPicker,
  openProjectPicker,
  openSettingsSheet,
  openTextSheet,
  openVariableSheet,
  showFatal,
  toast,
  type PickItem,
} from './overlays'
import { AppState } from './state'
import { byId, displayTitle, el, fillVariables, findVariables, relativeTime } from './util'

const state = new AppState()
const search = byId<HTMLInputElement>('search')
const searchClear = byId<HTMLButtonElement>('search-clear')
const filters = byId<HTMLDivElement>('filters')
const context = byId<HTMLSpanElement>('titlebar-context')

const editor = new Editor(
  state,
  () => {
    list.render()
    paintFilters()
  },
  () => openAssignProject(),
)

const scopeButton = byId<HTMLButtonElement>('project-scope')
const scopeName = byId<HTMLSpanElement>('scope-name')
const scopeDot = byId<HTMLSpanElement>('scope-dot')
const list = new IndexList(state, (id) => void selectPrompt(id))

// ------------------------------------------------------------------ theme

const systemDark = window.matchMedia('(prefers-color-scheme: dark)')

function resolveDark(theme: Settings['theme']): boolean {
  return theme === 'system' ? systemDark.matches : theme === 'dark'
}

function applyTheme(): void {
  const dark = resolveDark(state.settings.theme)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  const styles = getComputedStyle(document.documentElement)
  const bg = styles.getPropertyValue('--bg').trim() || (dark ? '#12151c' : '#fbfaf7')
  const symbol = styles.getPropertyValue('--muted').trim() || '#8f98ab'
  void window.stash.setTitleBarTheme(bg, symbol)
}

systemDark.addEventListener('change', () => {
  if (state.settings?.theme === 'system') applyTheme()
})

// ------------------------------------------------------------- selection

async function selectPrompt(id: ID | null): Promise<void> {
  await state.select(id)
  editor.show(state.open)
  editor.paintSaveState()
  list.repaintSelection()
  paintContext()
}

function paintContext(): void {
  const p = state.open
  if (!p) {
    context.textContent = ''
    return
  }
  const name = displayTitle(p.title, p.body.slice(0, 160)).text
  context.textContent = `— ${name}  ·  edited ${relativeTime(p.updatedAt)}`
}

function move(delta: number): void {
  if (state.order.length === 0) return
  const current = list.indexOf(state.selectedId)
  const next = Math.min(Math.max(current + delta, 0), state.order.length - 1)
  const id = state.order[current === -1 ? 0 : next]
  if (id) {
    list.scrollTo(current === -1 ? 0 : next)
    void selectPrompt(id)
  }
}

// --------------------------------------------------------------- filters

function paintFilters(): void {
  const tagCounts = new Map<string, number>()
  for (const s of state.summaries) {
    if (s.trashedAt !== null) continue
    for (const t of s.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1)
  }
  const top = [...tagCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8)

  const chips: HTMLElement[] = []
  const add = (label: string, active: boolean, run: () => void): void => {
    const b = el('button', 'chip', label)
    b.type = 'button'
    b.setAttribute('aria-pressed', String(active))
    b.addEventListener('click', run)
    chips.push(b)
  }
  add('All', state.view === 'all' && !state.tag, () => {
    state.setView('all')
    afterListChange()
  })
  add('Pinned', state.view === 'pinned', () => {
    state.setView('pinned')
    afterListChange()
  })
  for (const [tag, n] of top) {
    add(`${tag} ${n}`, state.tag === tag, () => {
      state.setView('all')
      state.setTag(state.tag === tag ? null : tag)
      afterListChange()
    })
  }
  add('Trash', state.view === 'trash', () => {
    state.setView(state.view === 'trash' ? 'all' : 'trash')
    afterListChange()
  })
  filters.replaceChildren(...chips)
}

function afterListChange(): void {
  paintScope()
  paintFilters()
  list.render()
}

// --------------------------------------------------------------- projects

function paintScope(): void {
  const project = state.projects.find((p) => p.id === state.projectScope)
  scopeName.textContent = project ? project.name : 'All projects'
  scopeDot.style.background = project ? project.color : 'var(--faint)'
  scopeButton.title = project
    ? `Showing ${project.name}. Everything below is scoped to it.`
    : 'Showing every project'
}

function openScopePicker(): void {
  openProjectPicker({
    title: 'Filter by project',
    noneLabel: 'All projects',
    projects: state.projects,
    currentId: state.projectScope,
    onPick: (id) => {
      state.setProjectScope(id)
      afterListChange()
      const first = state.order[0] ?? null
      void selectPrompt(first)
    },
    onCreate: (name) => {
      void window.stash.projectCreate(name).then(async (p) => {
        await state.refresh()
        if (p) state.setProjectScope(p.id)
        afterListChange()
        toast(`Project “${name}” created`)
      })
    },
  })
}

/** Files the open prompt under a project, creating one on the fly if needed. */
function openAssignProject(): void {
  const prompt = state.open
  if (!prompt) return
  openProjectPicker({
    title: 'Move to project',
    noneLabel: 'No project',
    projects: state.projects,
    currentId: prompt.projectId,
    onPick: (id) => void assignProject(prompt.id, id),
    onCreate: (name) => {
      void window.stash.projectCreate(name).then(async (p) => {
        await state.refresh()
        if (p) await assignProject(prompt.id, p.id)
      })
    },
  })
}

async function assignProject(promptId: ID, projectId: ID | null): Promise<void> {
  await window.stash.setProject(promptId, projectId)
  if (state.open?.id === promptId) state.open.projectId = projectId
  const s = state.index.get(promptId)
  if (s) s.projectId = projectId
  await state.refresh()
  afterListChange()
  if (state.open) editor.paintTags(state.open)
  const name = state.projectName(projectId)
  toast(name ? `Moved to ${name}` : 'Removed from its project')
}

function renameProject(): void {
  openProjectPicker({
    title: 'Rename a project',
    noneLabel: 'Cancel',
    projects: state.projects,
    currentId: null,
    onPick: (id) => {
      if (!id) return
      const project = state.projects.find((p) => p.id === id)
      if (!project) return
      openTextSheet({
        title: 'Rename project',
        label: 'Name',
        value: project.name,
        confirmLabel: 'Rename',
        onConfirm: (value) => {
          void window.stash.projectRename(id, value).then(async () => {
            await state.refresh()
            afterListChange()
            if (state.open) editor.paintTags(state.open)
            toast('Renamed')
          })
        },
      })
    },
    onCreate: () => {
      /* renaming never creates */
    },
  })
}

function deleteProject(): void {
  openProjectPicker({
    title: 'Delete a project',
    noneLabel: 'Cancel',
    projects: state.projects,
    currentId: null,
    onPick: (id) => {
      if (!id) return
      const project = state.projects.find((p) => p.id === id)
      if (!project) return
      openConfirmSheet({
        title: `Delete the project “${project.name}”?`,
        note:
          project.count === 0
            ? 'It has no prompts in it.'
            : `Its ${project.count} ${project.count === 1 ? 'prompt stays' : 'prompts stay'} in your stash and simply become unfiled. Nothing is deleted.`,
        confirmLabel: 'Delete project',
        onConfirm: () => {
          void window.stash.projectDelete(id).then(async (n) => {
            if (state.projectScope === id) state.setProjectScope(null)
            await state.refresh()
            afterListChange()
            if (state.open) {
              state.open.projectId = state.open.projectId === id ? null : state.open.projectId
              editor.paintTags(state.open)
            }
            toast(n === 0 ? 'Project deleted' : `Project deleted, ${n} unfiled`)
          })
        },
      })
    },
    onCreate: () => {
      /* deleting never creates */
    },
  })
}

// ---------------------------------------------------------------- actions

async function newPrompt(seedTitle = ''): Promise<void> {
  await state.flush()
  const p = await window.stash.create({ title: seedTitle, projectId: state.projectScope })
  await state.refresh()
  afterListChange()
  await selectPrompt(p.id)
  if (seedTitle) editor.focusBody()
  else editor.focusTitle()
}

async function duplicateCurrent(): Promise<void> {
  const p = state.open
  if (!p) return
  await state.flush()
  const copy = await window.stash.duplicate(p.id)
  if (!copy) return
  await state.refresh()
  afterListChange()
  await selectPrompt(copy.id)
  toast('Duplicated')
}

async function togglePin(): Promise<void> {
  const p = state.open
  if (!p) return
  const next = !p.pinned
  p.pinned = next
  const s = state.index.get(p.id)
  if (s) s.pinned = next
  await window.stash.setPinned(p.id, next)
  state.recompute()
  afterListChange()
  list.repaintSelection()
  toast(next ? 'Pinned' : 'Unpinned')
}

async function trashCurrent(): Promise<void> {
  const p = state.open
  if (!p) return
  await state.flush()
  const id = p.id
  const name = displayTitle(p.title, p.body.slice(0, 160)).text
  const position = list.indexOf(id)
  await window.stash.trash([id])
  await state.refresh()
  afterListChange()
  const next = state.order[Math.min(position, state.order.length - 1)] ?? null
  await selectPrompt(next)
  toast(`Moved “${truncate(name, 32)}” to trash`, {
    label: 'Undo',
    run: () => {
      void (async () => {
        await window.stash.restore([id])
        await state.refresh()
        afterListChange()
        await selectPrompt(id)
      })()
    },
  })
}

async function restoreCurrent(): Promise<void> {
  const p = state.open
  if (!p || p.trashedAt === null) return
  await window.stash.restore([p.id])
  await state.refresh()
  afterListChange()
  await selectPrompt(p.id)
  toast('Restored')
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

// ------------------------------------------------------------------- copy

function varMemoryKey(id: ID): string {
  return `prompt-stash.vars.${id}`
}

function rememberedVars(id: ID): Record<string, string> {
  try {
    const raw = localStorage.getItem(varMemoryKey(id))
    return raw ? (JSON.parse(raw) as Record<string, string>) : {}
  } catch {
    return {}
  }
}

async function copyCurrent(): Promise<void> {
  const p = state.open
  if (!p) return
  await state.flush()
  const text = state.liveText.body
  if (!text.trim()) {
    toast('Nothing to copy yet')
    return
  }
  const names = findVariables(text)
  if (names.length === 0) {
    await finishCopy(p.id, text)
    return
  }
  openVariableSheet(p.id, names, rememberedVars(p.id), (values) => {
    try {
      localStorage.setItem(varMemoryKey(p.id), JSON.stringify(values))
    } catch {
      /* remembering values is a convenience, not a guarantee */
    }
    const filled = fillVariables(text, values)
    const left = findVariables(filled).length
    void finishCopy(p.id, filled, left)
  })
}

async function finishCopy(id: ID, text: string, unfilled = 0): Promise<void> {
  await window.stash.copyText(text)
  await window.stash.markUsed(id)
  const s = state.index.get(id)
  if (s) {
    s.usedAt = Date.now()
    s.useCount += 1
  }
  toast(
    unfilled > 0
      ? `Copied, ${unfilled} placeholder${unfilled === 1 ? '' : 's'} left as-is`
      : 'Copied',
  )
}

// -------------------------------------------------------------- overlays

function openCommandPalette(): void {
  const items: PickItem[] = [
    { label: 'New prompt', hint: 'Ctrl N', run: () => void newPrompt() },
    { label: 'Copy this prompt', hint: 'Ctrl Shift C', run: () => void copyCurrent() },
    { label: 'Duplicate this prompt', hint: 'Ctrl D', run: () => void duplicateCurrent() },
    { label: 'Pin or unpin', hint: 'Ctrl P', run: () => void togglePin() },
    { label: 'Earlier versions', hint: 'Ctrl H', run: () => void openHistory() },
    { label: 'Move to trash', hint: 'Ctrl Shift Del', run: () => void trashCurrent() },
    { label: 'Restore from trash', run: () => void restoreCurrent() },
    { label: 'Move this prompt to a project', hint: 'Ctrl Shift P', run: () => openAssignProject() },
    { label: 'Filter by project', hint: 'Ctrl Shift O', run: () => openScopePicker() },
    { label: 'Rename a project', run: () => renameProject() },
    { label: 'Delete a project', run: () => deleteProject() },
    { label: 'Settings and data', hint: 'Ctrl ,', run: () => void openSettings() },
    { label: 'Show all prompts', run: () => { state.setView('all'); afterListChange() } },
    { label: 'Show pinned', run: () => { state.setView('pinned'); afterListChange() } },
    { label: 'Show trash', run: () => { state.setView('trash'); afterListChange() } },
  ]
  for (const s of state.summaries) {
    if (s.trashedAt !== null) continue
    items.push({
      label: displayTitle(s.title, s.excerpt).text,
      sub: s.tags.join(' '),
      hint: relativeTime(s.updatedAt),
      run: () => void selectPrompt(s.id),
    })
  }
  openPicker('Type a command or a prompt name', items, { emptyText: 'No command or prompt matches.' })
}

async function openHistory(): Promise<void> {
  const p = state.open
  if (!p) return
  await state.flush()
  const versions = await window.stash.versions(p.id)
  openHistorySheet(versions, (v) => {
    void (async () => {
      const restored = await window.stash.restoreVersion(p.id, v.versionId)
      if (!restored) return
      state.open = restored
      await state.select(null)
      await state.refresh()
      afterListChange()
      await selectPrompt(restored.id)
      toast('Restored an earlier version')
    })()
  })
}

async function openSettings(): Promise<void> {
  const stats = await window.stash.stats()
  openSettingsSheet(state.settings, stats, {
    set: (patch) => {
      Object.assign(state.settings, patch)
      void window.stash.settingsSet(patch)
      applyTheme()
      editor.applySettings()
      state.recompute()
      afterListChange()
    },
    backup: () => {
      void window.stash.backupNow().then((r) => toast(r ? 'Backup saved' : 'Backup failed'))
    },
    exportJson: () => {
      void window.stash
        .exportAll()
        .then((r) => r && toast(`Exported ${r.count} prompts`))
        .catch((e: Error) => toast(`Export failed: ${e.message}`))
    },
    exportMarkdown: () => {
      void window.stash
        .exportMarkdown()
        .then((r) => r && toast(`Wrote ${r.count} Markdown files`))
        .catch((e: Error) => toast(`Export failed: ${e.message}`))
    },
    importJson: () => {
      void window.stash
        .importFile()
        .then(async (r) => {
          if (!r) return
          await state.refresh()
          afterListChange()
          toast(`Imported ${r.added} new, updated ${r.updated}, skipped ${r.skipped}`)
        })
        .catch((e: Error) => toast(`Import failed: ${e.message}`))
    },
    openFolder: () => void window.stash.openDataFolder(),
    emptyTrash: () => {
      void window.stash.emptyTrash().then(async (n) => {
        await state.refresh()
        afterListChange()
        if (state.open && !state.index.has(state.open.id)) await selectPrompt(null)
        toast(n === 0 ? 'Trash was already empty' : `Deleted ${n} for good`)
      })
    },
  })
}

// --------------------------------------------------------------- keyboard

const isTyping = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')

window.addEventListener(
  'keydown',
  (e) => {
    const ctrl = e.ctrlKey || e.metaKey

    if (e.key === 'Escape') {
      if (isOverlayOpen()) {
        e.preventDefault()
        closeOverlay()
      } else if (document.activeElement === search) {
        if (search.value) {
          setSearch('')
        } else {
          editor.focusBody()
        }
        e.preventDefault()
      }
      return
    }

    if (isOverlayOpen()) return

    if (ctrl && !e.shiftKey && !e.altKey) {
      switch (e.key.toLowerCase()) {
        case 'n':
          e.preventDefault()
          void newPrompt()
          return
        case 'k':
          e.preventDefault()
          openCommandPalette()
          return
        case 'f':
        case 'l':
          e.preventDefault()
          search.focus()
          search.select()
          return
        case 's':
          e.preventDefault()
          void state.flush().then(() => toast('Saved'))
          return
        case 'd':
          e.preventDefault()
          void duplicateCurrent()
          return
        case 'p':
          e.preventDefault()
          void togglePin()
          return
        case 'h':
          e.preventDefault()
          void openHistory()
          return
        case ',':
          e.preventDefault()
          void openSettings()
          return
      }
    }

    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'c') {
      e.preventDefault()
      void copyCurrent()
      return
    }
    if (ctrl && e.shiftKey && (e.key === 'Delete' || e.key === 'Backspace')) {
      e.preventDefault()
      void (state.view === 'trash' ? restoreCurrent() : trashCurrent())
      return
    }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault()
      openAssignProject()
      return
    }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 'o') {
      e.preventDefault()
      openScopePicker()
      return
    }
    if (ctrl && e.shiftKey && e.key.toLowerCase() === 't') {
      e.preventDefault()
      state.setView(state.view === 'trash' ? 'all' : 'trash')
      afterListChange()
      return
    }

    if (e.key === 'F2') {
      e.preventDefault()
      editor.focusTitle()
      return
    }

    // Alt+arrows move through the list without leaving the text you are writing.
    if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      move(e.key === 'ArrowDown' ? 1 : -1)
      return
    }

    // Plain arrows only navigate when focus is not in a text field.
    if (!isTyping(e.target) && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault()
      move(e.key === 'ArrowDown' ? 1 : -1)
    }
  },
  true,
)

// ----------------------------------------------------------------- search

function setSearch(value: string): void {
  search.value = value
  searchClear.hidden = value.length === 0
  state.setQuery(value)
}

search.addEventListener('input', () => setSearch(search.value))
searchClear.addEventListener('click', () => {
  setSearch('')
  search.focus()
})
search.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'Enter') {
    e.preventDefault()
    const id = state.order[0]
    if (id) {
      void selectPrompt(id).then(() => {
        list.scrollTo(0)
        if (e.key === 'Enter') editor.focusBody()
      })
    } else if (e.key === 'Enter' && search.value.trim()) {
      void newPrompt(search.value.trim())
    }
  }
})

scopeButton.addEventListener('click', () => openScopePicker())
byId<HTMLButtonElement>('new-button').addEventListener('click', () => void newPrompt())
byId<HTMLButtonElement>('copy-button').addEventListener('click', () => void copyCurrent())

// -------------------------------------------------------------- lifecycle

state.on('list', () => list.render())
state.on('save', () => {
  editor.paintSaveState()
  paintContext()
})

// Any moment the app stops being the thing in front of you is a moment to persist.
window.addEventListener('blur', () => void state.flush())
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') void state.flush()
})

window.stash.onBeforeQuit(() => {
  void state.flush().finally(() => void window.stash.flushNow())
})

window.stash.onThemeChange(() => {
  if (state.settings?.theme === 'system') applyTheme()
})

async function boot(): Promise<void> {
  const report = await window.stash.startup()
  if (report.fatal) {
    const stats = await window.stash.stats().catch(() => null)
    showFatal(report.fatal, stats?.dataDir ?? '')
    return
  }

  await state.load()
  applyTheme()

  // Unsaved text is carried back in by the store before the list is even read, so by
  // this point it is already part of the prompt.
  afterListChange()

  const first = state.settings.lastPromptId ?? state.order[0] ?? null
  if (first && state.index.has(first)) {
    await selectPrompt(first)
    const idx = list.indexOf(first)
    if (idx >= 0) list.scrollTo(idx)
  } else {
    editor.show(null)
  }

  if (report.recovered) {
    toast('Your stash was restored from a backup after a problem was found')
  }
  if (report.recoveredDrafts > 0) {
    const n = report.recoveredDrafts
    toast(`Recovered text in ${n} prompt${n === 1 ? '' : 's'} that had not finished saving`)
  }
  if (state.summaries.length === 0) {
    await seedWelcome()
  }
}

/** First run: one prompt that demonstrates placeholders rather than an empty screen. */
async function seedWelcome(): Promise<void> {
  await window.stash.create({
    title: 'How this works',
    tags: ['start'],
    body: [
      'Everything you write here saves itself. There is no save button and no cloud —',
      'your prompts live in a local SQLite file you can export or back up at any time.',
      '',
      'Placeholders',
      'Wrap a word in double braces and Prompt Stash will ask for it when you copy:',
      '',
      '  Refactor {{file}} so that {{goal}}. Keep the public API unchanged.',
      '',
      'Press Ctrl+Shift+C on this prompt to see the fill-in step.',
      '',
      'Worth knowing',
      '  Ctrl+N    stash a new prompt',
      '  Ctrl+K    command palette, and jump to any prompt by name',
      '  Ctrl+F    search everything, including the full text of every prompt',
      '  Ctrl+P    pin, so it stays at the top',
      '  Ctrl+H    earlier versions of whatever you are reading',
      '',
      'Delete this one whenever you like — Ctrl+Shift+Delete, and it waits 30 days in the trash.',
    ].join('\n'),
  })
  await state.refresh()
  afterListChange()
  const id = state.order[0]
  if (id) await selectPrompt(id)
}

void boot().catch((err: Error) => {
  showFatal(err.message, '')
})
