import type { ID } from '../shared/types'
import type { AppState } from './state'
import { byId, displayTitle, el, formatCount, relativeTime } from './util'

const ROW_H = 58
const OVERSCAN = 6

interface RowEls {
  root: HTMLDivElement
  title: HTMLSpanElement
  meta: HTMLSpanElement
  dot: HTMLSpanElement
  metaText: Text
  id: ID | null
}

/**
 * Fixed-height virtual list. Only the visible window plus a small overscan exists in
 * the DOM, and those elements are recycled rather than recreated, so scrolling a
 * 50,000-prompt library costs the same as scrolling twenty.
 */
export class IndexList {
  private scroll = byId<HTMLDivElement>('list-scroll')
  private sizer = byId<HTMLDivElement>('list-sizer')
  private rows = byId<HTMLDivElement>('list-rows')
  private empty = byId<HTMLDivElement>('list-empty')
  private countLabel = byId<HTMLSpanElement>('count-label')
  private pool: RowEls[] = []
  private frame = 0

  constructor(
    private state: AppState,
    private onSelect: (id: ID) => void,
  ) {
    this.scroll.addEventListener('scroll', this.onScroll, { passive: true })
    this.rows.addEventListener('mousedown', this.onMouseDown)
    window.addEventListener('resize', this.onScroll, { passive: true })
  }

  private onScroll = (): void => {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.paint()
    })
  }

  private onMouseDown = (event: MouseEvent): void => {
    const row = (event.target as HTMLElement).closest('.row') as HTMLDivElement | null
    const id = row?.dataset.id
    if (id) {
      event.preventDefault() // keep focus where it is; selection is explicit
      this.onSelect(id)
    }
  }

  /** Full re-render: the order or contents changed. */
  render(): void {
    const n = this.state.order.length
    this.sizer.style.height = `${n * ROW_H}px`

    const searching = this.state.query.trim().length > 0
    this.empty.hidden = n > 0
    if (n === 0) this.empty.replaceChildren(...emptyMessage(this.state, searching))

    const total = this.state.summaries.filter((s) => s.trashedAt === null).length
    if (searching) {
      this.countLabel.textContent = `${formatCount(n)} of ${formatCount(total)}`
    } else if (this.state.view === 'trash') {
      this.countLabel.textContent = n === 1 ? '1 in trash' : `${formatCount(n)} in trash`
    } else {
      this.countLabel.textContent = n === 1 ? '1 prompt' : `${formatCount(total)} prompts`
    }
    this.paint()
  }

  private paint(): void {
    const n = this.state.order.length
    const viewport = this.scroll.clientHeight || 400
    const first = Math.max(0, Math.floor(this.scroll.scrollTop / ROW_H) - OVERSCAN)
    const visible = Math.ceil(viewport / ROW_H) + OVERSCAN * 2
    const count = Math.min(visible, n - first)

    while (this.pool.length < Math.max(0, count)) this.pool.push(this.makeRow())

    const now = Date.now()
    for (let i = 0; i < this.pool.length; i++) {
      const cell = this.pool[i]!
      const idx = first + i
      if (idx >= n || i >= count) {
        if (cell.root.isConnected) cell.root.remove()
        cell.id = null
        continue
      }
      const id = this.state.order[idx]!
      const s = this.state.index.get(id)
      if (!s) continue
      if (!cell.root.isConnected) this.rows.appendChild(cell.root)
      cell.root.style.top = `${idx * ROW_H}px`
      cell.id = id
      cell.root.dataset.id = id
      cell.root.dataset.pinned = s.pinned ? '1' : '0'
      cell.root.dataset.selected = id === this.state.selectedId ? '1' : '0'

      const shown = displayTitle(s.title, s.excerpt)
      if (cell.title.textContent !== shown.text) cell.title.textContent = shown.text
      cell.title.dataset.untitled = shown.untitled ? '1' : '0'

      const bits = [relativeTime(this.state.view === 'trash' ? (s.trashedAt ?? s.updatedAt) : s.updatedAt, now)]
      if (s.words > 0) bits.push(`${formatCount(s.words)} ${s.words === 1 ? 'word' : 'words'}`)
      const project = this.state.projectName(s.projectId)
      if (project) bits.push(project)
      if (s.tags.length) bits.push(s.tags.slice(0, 3).join(' · '))
      const meta = bits.join('  ·  ')
      if (cell.metaText.data !== meta) cell.metaText.data = meta
      const color = this.state.projectColor(s.projectId)
      cell.dot.hidden = !color
      if (color) cell.dot.style.background = color
    }
  }

  /** Cheap update when only which row is selected changed. */
  repaintSelection(): void {
    for (const cell of this.pool) {
      if (!cell.id) continue
      cell.root.dataset.selected = cell.id === this.state.selectedId ? '1' : '0'
    }
  }

  private makeRow(): RowEls {
    const root = el('div', 'row')
    const title = el('span', 'row-title')
    const meta = el('span', 'row-meta')
    const dot = el('span', 'row-project')
    const metaText = document.createTextNode('')
    meta.append(dot, metaText)
    root.append(title, meta)
    return { root, title, meta, dot, metaText, id: null }
  }

  scrollTo(index: number): void {
    const top = index * ROW_H
    const viewTop = this.scroll.scrollTop
    const viewBottom = viewTop + this.scroll.clientHeight
    if (top < viewTop) this.scroll.scrollTop = top
    else if (top + ROW_H > viewBottom) this.scroll.scrollTop = top + ROW_H - this.scroll.clientHeight
    this.paint()
  }

  indexOf(id: ID | null): number {
    return id === null ? -1 : this.state.order.indexOf(id)
  }
}

function emptyMessage(state: AppState, searching: boolean): Node[] {
  const wrap = el('div')
  if (searching) {
    wrap.append(
      el('p', undefined, `Nothing matches “${state.query.trim()}”.`),
      el('p', undefined, 'Press Ctrl+N to stash it as a new prompt.'),
    )
  } else if (state.view === 'trash') {
    wrap.append(
      el('p', undefined, 'Trash is empty.'),
      el('p', undefined, 'Deleted prompts rest here for 30 days.'),
    )
  } else if (state.view === 'pinned') {
    wrap.append(
      el('p', undefined, 'Nothing pinned yet.'),
      el('p', undefined, 'Ctrl+P pins the prompt you are reading.'),
    )
  } else if (state.tag) {
    wrap.append(el('p', undefined, `No prompts tagged ${state.tag}.`))
  } else if (state.projectScope) {
    wrap.append(
      el('p', undefined, `Nothing in ${state.projectName(state.projectScope) ?? 'this project'} yet.`),
      el('p', undefined, 'Ctrl+N starts one here.'),
    )
  } else {
    wrap.append(
      el('p', undefined, 'No prompts yet.'),
      el('p', undefined, 'Press Ctrl+N to stash your first one.'),
    )
  }
  for (const p of Array.from(wrap.children)) (p as HTMLElement).style.margin = '0 0 4px'
  return Array.from(wrap.childNodes)
}
