import type { ID, Project, Settings, SortKey, Version } from '../shared/types'
import { byId, el, firstLine, formatBytes, formatCount, fuzzyScore, relativeTime } from './util'

const overlay = byId<HTMLDivElement>('overlay')
const sheet = byId<HTMLDivElement>('sheet')
const toastEl = byId<HTMLDivElement>('toast')

let closeCurrent: (() => void) | null = null

export function isOverlayOpen(): boolean {
  return !overlay.hidden
}

export function closeOverlay(): void {
  closeCurrent?.()
}

/** One modal at a time. Escape and a click on the scrim both dismiss. */
function openSheet(build: (close: () => void) => HTMLElement, onClose?: () => void): void {
  closeOverlay()
  const close = (): void => {
    if (overlay.hidden) return
    overlay.hidden = true
    sheet.replaceChildren()
    closeCurrent = null
    onClose?.()
  }
  closeCurrent = close
  sheet.replaceChildren(build(close))
  overlay.hidden = false
}

overlay.addEventListener('mousedown', (e) => {
  if (e.target === overlay) closeOverlay()
})

// ------------------------------------------------------------------- toast

let toastTimer = 0

export function toast(message: string, action?: { label: string; run: () => void }): void {
  clearTimeout(toastTimer)
  const nodes: Node[] = [document.createTextNode(message)]
  if (action) {
    const b = el('button', 'toast-action', action.label)
    b.type = 'button'
    b.addEventListener('click', () => {
      clearTimeout(toastTimer)
      toastEl.hidden = true
      action.run()
    })
    nodes.push(b)
  }
  toastEl.replaceChildren(...nodes)
  toastEl.hidden = false
  toastTimer = window.setTimeout(() => {
    toastEl.hidden = true
  }, action ? 6000 : 2200)
}

// ------------------------------------------------------------ pick-a-thing

export interface PickItem {
  label: string
  sub?: string
  hint?: string
  run: () => void
}

/**
 * The command palette and the "jump to prompt" list are the same widget: a filter box
 * over a scored list, driven entirely from the keyboard.
 */
export function openPicker(
  placeholder: string,
  items: PickItem[],
  opts: { initialQuery?: string; emptyText?: string } = {},
): void {
  openSheet((close) => {
    const wrap = el('div')
    const input = el('input', 'sheet-input')
    input.type = 'text'
    input.placeholder = placeholder
    input.spellcheck = false
    input.value = opts.initialQuery ?? ''
    const list = el('div', 'sheet-list')
    wrap.append(input, list)

    let shown: PickItem[] = []
    let active = 0

    const paint = (): void => {
      const q = input.value.trim()
      shown = q
        ? items
            .map((i) => ({ i, s: Math.max(fuzzyScore(i.label, q), fuzzyScore(i.sub ?? '', q) * 0.6) }))
            .filter((x) => x.s > 0)
            .sort((a, b) => b.s - a.s)
            .slice(0, 60)
            .map((x) => x.i)
        : items.slice(0, 60)
      if (active >= shown.length) active = Math.max(0, shown.length - 1)

      if (shown.length === 0) {
        const none = el('div', 'sheet-item')
        none.append(el('span', 'sheet-item-sub', opts.emptyText ?? 'No matches.'))
        list.replaceChildren(none)
        return
      }
      list.replaceChildren(
        ...shown.map((item, idx) => {
          const row = el('div', 'sheet-item')
          row.dataset.active = idx === active ? '1' : '0'
          row.dataset.idx = String(idx)
          const label = el('span', 'sheet-item-label', item.label)
          row.append(label)
          if (item.sub) row.append(el('span', 'sheet-item-sub', item.sub))
          if (item.hint) row.append(el('span', 'sheet-item-hint', item.hint))
          return row
        }),
      )
      list.children[active]?.scrollIntoView({ block: 'nearest' })
    }

    const choose = (): void => {
      const item = shown[active]
      if (!item) return
      close()
      item.run()
    }

    input.addEventListener('input', () => {
      active = 0
      paint()
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        active = Math.min(active + 1, shown.length - 1)
        paint()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        active = Math.max(active - 1, 0)
        paint()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        choose()
      }
    })
    list.addEventListener('mousedown', (e) => {
      const row = (e.target as HTMLElement).closest('.sheet-item') as HTMLElement | null
      if (!row?.dataset.idx) return
      e.preventDefault()
      active = Number(row.dataset.idx)
      choose()
    })

    paint()
    queueMicrotask(() => input.focus())
    return wrap
  })
}

// ---------------------------------------------------------------- projects

export interface ProjectPickerOptions {
  title: string
  /** Label for the entry that clears the project — "All projects" or "No project". */
  noneLabel: string
  projects: Project[]
  currentId: ID | null
  onPick: (id: ID | null) => void
  onCreate: (name: string) => void
}

/**
 * Pick a project, or type a name that does not exist yet and create it in the same
 * keystroke. The filter box doubles as the new-project field, so there is no separate
 * "new project" dialog to find.
 */
export function openProjectPicker(opts: ProjectPickerOptions): void {
  openSheet((close) => {
    const wrap = el('div')
    const input = el('input', 'sheet-input')
    input.type = 'text'
    input.placeholder = 'Filter projects, or type a new name'
    input.spellcheck = false
    const list = el('div', 'sheet-list')
    wrap.append(input, list)

    type Row = { label: string; sub?: string; color?: string; run: () => void }
    let shown: Row[] = []
    let active = 0

    const build = (): Row[] => {
      const q = input.value.trim()
      const rows: Row[] = []
      const matches = q
        ? opts.projects.filter((p) => fuzzyScore(p.name, q) > 0)
        : opts.projects
      const exact = opts.projects.some((p) => p.name.toLowerCase() === q.toLowerCase())
      if (q && !exact) {
        rows.push({
          label: `Create “${q}”`,
          run: () => opts.onCreate(q),
        })
      }
      if (!q) {
        rows.push({
          label: opts.noneLabel,
          sub: opts.currentId === null ? 'current' : undefined,
          run: () => opts.onPick(null),
        })
      }
      for (const p of matches) {
        rows.push({
          label: p.name,
          sub: `${p.count} ${p.count === 1 ? 'prompt' : 'prompts'}`,
          color: p.color,
          run: () => opts.onPick(p.id),
        })
      }
      return rows
    }

    const paint = (): void => {
      shown = build()
      if (active >= shown.length) active = Math.max(0, shown.length - 1)
      if (shown.length === 0) {
        const none = el('div', 'sheet-item')
        none.append(el('span', 'sheet-item-sub', 'No projects yet. Type a name to make one.'))
        list.replaceChildren(none)
        return
      }
      list.replaceChildren(
        ...shown.map((row, idx) => {
          const node = el('div', 'sheet-item')
          node.dataset.active = idx === active ? '1' : '0'
          node.dataset.idx = String(idx)
          if (row.color) {
            const dot = el('span', 'project-dot')
            dot.style.background = row.color
            node.append(dot)
          }
          node.append(el('span', 'sheet-item-label', row.label))
          if (row.sub) node.append(el('span', 'sheet-item-sub', row.sub))
          return node
        }),
      )
      list.children[active]?.scrollIntoView({ block: 'nearest' })
    }

    const choose = (): void => {
      const row = shown[active]
      if (!row) return
      close()
      row.run()
    }

    input.addEventListener('input', () => {
      active = 0
      paint()
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        active = Math.min(active + 1, shown.length - 1)
        paint()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        active = Math.max(active - 1, 0)
        paint()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        choose()
      }
    })
    list.addEventListener('mousedown', (e) => {
      const node = (e.target as HTMLElement).closest('.sheet-item') as HTMLElement | null
      if (!node?.dataset.idx) return
      e.preventDefault()
      active = Number(node.dataset.idx)
      choose()
    })

    paint()
    queueMicrotask(() => input.focus())
    void opts.title
    return wrap
  })
}

/** A single-field sheet, used for renaming. */
export function openTextSheet(opts: {
  title: string
  note?: string
  label: string
  value: string
  confirmLabel: string
  onConfirm: (value: string) => void
}): void {
  openSheet((close) => {
    const wrap = el('div')
    const head = el('div', 'sheet-head')
    head.append(el('h2', 'sheet-title', opts.title))
    if (opts.note) head.append(el('p', 'sheet-note', opts.note))
    const body = el('div', 'sheet-body')
    const field = el('div', 'field')
    const label = el('label', 'field-label', opts.label)
    const input = el('input', 'field-input')
    input.type = 'text'
    input.value = opts.value
    input.id = 'text-sheet-input'
    label.htmlFor = input.id
    field.append(label, input)
    body.append(field)
    const foot = el('div', 'sheet-foot')
    const cancel = el('button', 'ghost-button', 'Cancel')
    cancel.type = 'button'
    const ok = el('button', 'primary-button', opts.confirmLabel)
    ok.type = 'button'
    foot.append(cancel, ok)
    wrap.append(head, body, foot)

    const submit = (): void => {
      const v = input.value.trim()
      close()
      if (v) opts.onConfirm(v)
    }
    ok.addEventListener('click', submit)
    cancel.addEventListener('click', close)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        submit()
      }
    })
    queueMicrotask(() => {
      input.focus()
      input.select()
    })
    return wrap
  })
}

/** Destructive, so it asks. */
export function openConfirmSheet(opts: {
  title: string
  note: string
  confirmLabel: string
  onConfirm: () => void
}): void {
  openSheet((close) => {
    const wrap = el('div')
    const head = el('div', 'sheet-head')
    head.append(el('h2', 'sheet-title', opts.title), el('p', 'sheet-note', opts.note))
    const foot = el('div', 'sheet-foot')
    const cancel = el('button', 'ghost-button', 'Cancel')
    cancel.type = 'button'
    const ok = el('button', 'primary-button', opts.confirmLabel)
    ok.type = 'button'
    foot.append(cancel, ok)
    wrap.append(head, foot)
    ok.addEventListener('click', () => {
      close()
      opts.onConfirm()
    })
    cancel.addEventListener('click', close)
    queueMicrotask(() => ok.focus())
    return wrap
  })
}

// --------------------------------------------------------------- variables

/**
 * The fill-in step before copying. Values are remembered per prompt so re-using a
 * template is a matter of pressing Enter.
 */
export function openVariableSheet(
  promptId: string,
  names: string[],
  remembered: Record<string, string>,
  onCopy: (values: Record<string, string>) => void,
): void {
  openSheet((close) => {
    const wrap = el('div')
    const head = el('div', 'sheet-head')
    head.append(
      el('h2', 'sheet-title', names.length === 1 ? 'Fill in the placeholder' : 'Fill in the placeholders'),
      el('p', 'sheet-note', 'Leave a field empty to copy the placeholder through unchanged.'),
    )
    const body = el('div', 'sheet-body')
    const inputs: Record<string, HTMLInputElement> = {}
    for (const name of names) {
      const field = el('div', 'field')
      const label = el('label', 'field-label', name)
      const input = el('input', 'field-input')
      input.type = 'text'
      input.value = remembered[name] ?? ''
      input.id = `var-${name.replace(/\W+/g, '-')}`
      label.htmlFor = input.id
      inputs[name] = input
      field.append(label, input)
      body.append(field)
    }
    const foot = el('div', 'sheet-foot')
    const cancel = el('button', 'ghost-button', 'Cancel')
    cancel.type = 'button'
    const copy = el('button', 'primary-button', 'Copy')
    copy.type = 'button'
    foot.append(cancel, copy)
    wrap.append(head, body, foot)

    const submit = (): void => {
      const values: Record<string, string> = {}
      for (const [k, input] of Object.entries(inputs)) values[k] = input.value
      close()
      onCopy(values)
    }
    copy.addEventListener('click', submit)
    cancel.addEventListener('click', close)
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        submit()
      }
    })
    queueMicrotask(() => inputs[names[0]!]?.focus())
    void promptId
    return wrap
  })
}

// ----------------------------------------------------------------- history

export function openHistorySheet(
  versions: Version[],
  onRestore: (v: Version) => void,
): void {
  openSheet((close) => {
    const wrap = el('div')
    const head = el('div', 'sheet-head')
    head.append(
      el('h2', 'sheet-title', 'Earlier versions'),
      el(
        'p',
        'sheet-note',
        versions.length === 0
          ? 'No earlier versions yet. A snapshot is kept whenever a prompt changes substantially.'
          : 'Restoring keeps the current text as a version too, so nothing is lost either way.',
      ),
    )
    const list = el('div', 'sheet-list')
    let active = 0
    const paint = (): void => {
      list.replaceChildren(
        ...versions.map((v, idx) => {
          const row = el('div', 'version-row')
          row.dataset.active = idx === active ? '1' : '0'
          row.dataset.idx = String(idx)
          row.append(
            el('span', 'version-when', relativeTime(v.createdAt)),
            el('span', 'version-preview', firstLine(v.body) || '(empty)'),
            el('span', 'sheet-item-hint', `${formatCount(v.body.length)}c`),
          )
          return row
        }),
      )
      list.children[active]?.scrollIntoView({ block: 'nearest' })
    }
    const choose = (): void => {
      const v = versions[active]
      if (!v) return
      close()
      onRestore(v)
    }
    wrap.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        active = Math.min(active + 1, versions.length - 1)
        paint()
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        active = Math.max(active - 1, 0)
        paint()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        choose()
      }
    })
    list.addEventListener('mousedown', (e) => {
      const row = (e.target as HTMLElement).closest('.version-row') as HTMLElement | null
      if (!row?.dataset.idx) return
      e.preventDefault()
      active = Number(row.dataset.idx)
      choose()
    })
    wrap.append(head, list)
    wrap.tabIndex = -1
    paint()
    queueMicrotask(() => wrap.focus())
    return wrap
  })
}

// ---------------------------------------------------------------- settings

export interface SettingsActions {
  set: (patch: Partial<Settings>) => void
  backup: () => void
  exportJson: () => void
  exportMarkdown: () => void
  importJson: () => void
  openFolder: () => void
  emptyTrash: () => void
}

export function openSettingsSheet(
  settings: Settings,
  stats: { total: number; trashed: number; dbBytes: number; dataDir: string; lastBackupAt: number | null },
  actions: SettingsActions,
): void {
  openSheet((close) => {
    const wrap = el('div')
    const head = el('div', 'sheet-head')
    head.append(el('h2', 'sheet-title', 'Settings'))
    const body = el('div', 'sheet-body')

    body.append(
      segmentRow('Theme', ['dark', 'light', 'system'], settings.theme, (v) =>
        actions.set({ theme: v as Settings['theme'] }),
      ),
      segmentRow('Editor font', ['sans', 'mono'], settings.editorFont, (v) =>
        actions.set({ editorFont: v as Settings['editorFont'] }),
      ),
      segmentRow('Sort by', ['updated', 'created', 'used', 'title'], settings.sort, (v) =>
        actions.set({ sort: v as SortKey }),
      ),
      toggleRow('Narrow measure', 'Caps the text column at about 78 characters.', settings.wrapColumn, (v) =>
        actions.set({ wrapColumn: v }),
      ),
      toggleRow('Spell check', 'Red underlines in the editor.', settings.spellcheck, (v) =>
        actions.set({ spellcheck: v }),
      ),
    )

    const dataHead = el('p', 'section-label', 'Your data')
    const where = el('p', 'sheet-note')
    where.append(
      document.createTextNode(
        `${formatCount(stats.total)} ${stats.total === 1 ? 'prompt' : 'prompts'} · ` +
          `${formatCount(stats.trashed)} in trash · ${formatBytes(stats.dbBytes)} on disk. ` +
          `Last backup ${stats.lastBackupAt ? relativeTime(stats.lastBackupAt) : 'not yet taken'}.`,
      ),
    )
    const buttons = el('div', 'sheet-foot')
    buttons.style.justifyContent = 'flex-start'
    buttons.style.flexWrap = 'wrap'
    buttons.style.borderTop = '0'
    buttons.style.padding = '0'
    for (const [label, run] of [
      ['Open data folder', actions.openFolder],
      ['Back up now', actions.backup],
      ['Export JSON', actions.exportJson],
      ['Export Markdown', actions.exportMarkdown],
      ['Import JSON', actions.importJson],
      ['Empty trash', actions.emptyTrash],
    ] as [string, () => void][]) {
      const b = el('button', 'ghost-button', label)
      b.type = 'button'
      b.addEventListener('click', () => {
        close()
        run()
      })
      buttons.append(b)
    }
    body.append(dataHead, where, buttons)

    const foot = el('div', 'sheet-foot')
    const done = el('button', 'primary-button', 'Done')
    done.type = 'button'
    done.addEventListener('click', close)
    foot.append(done)

    wrap.append(head, body, foot)
    queueMicrotask(() => done.focus())
    return wrap
  })
}

function segmentRow(
  label: string,
  options: string[],
  value: string,
  onPick: (v: string) => void,
): HTMLElement {
  const row = el('div', 'setting-row')
  row.append(el('span', undefined, label))
  const seg = el('div', 'seg')
  for (const o of options) {
    const b = el('button', undefined, o)
    b.type = 'button'
    b.setAttribute('aria-pressed', String(o === value))
    b.addEventListener('click', () => {
      for (const child of Array.from(seg.children)) child.setAttribute('aria-pressed', 'false')
      b.setAttribute('aria-pressed', 'true')
      onPick(o)
    })
    seg.append(b)
  }
  row.append(seg)
  return row
}

function toggleRow(
  label: string,
  note: string,
  value: boolean,
  onPick: (v: boolean) => void,
): HTMLElement {
  const row = el('div', 'setting-row')
  const left = el('div')
  left.append(el('span', undefined, label), el('span', 'sheet-item-sub', note))
  row.append(left)
  const seg = el('div', 'seg')
  for (const [text, v] of [
    ['on', true],
    ['off', false],
  ] as [string, boolean][]) {
    const b = el('button', undefined, text)
    b.type = 'button'
    b.setAttribute('aria-pressed', String(v === value))
    b.addEventListener('click', () => {
      for (const child of Array.from(seg.children)) child.setAttribute('aria-pressed', 'false')
      b.setAttribute('aria-pressed', 'true')
      onPick(v)
    })
    seg.append(b)
  }
  row.append(seg)
  return row
}

// ------------------------------------------------------------------- fatal

export function showFatal(message: string, dataDir: string): void {
  const node = byId<HTMLDivElement>('fatal')
  const dir = el('code', undefined, dataDir)
  node.replaceChildren(
    el('h1', undefined, 'Your stash could not be opened'),
    el(
      'p',
      undefined,
      'Nothing has been deleted. The database file is still in your data folder, along with any backups.',
    ),
    el('p', undefined, message),
    dir,
  )
  node.hidden = false
}
