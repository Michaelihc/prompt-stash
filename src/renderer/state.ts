import {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_MAX_WAIT_MS,
  DRAFT_DEBOUNCE_MS,
  type ID,
  type Project,
  type Prompt,
  type PromptSummary,
  type Settings,
  type SortKey,
} from '../shared/types'
import { countWords, displayTitle, fuzzyScore } from './util'

export type View = 'all' | 'pinned' | 'trash'

type Listener = () => void

export class AppState {
  summaries: PromptSummary[] = []
  index = new Map<ID, PromptSummary>()
  order: ID[] = []
  selectedId: ID | null = null
  open: Prompt | null = null
  query = ''
  view: View = 'all'
  tag: string | null = null
  projects: Project[] = []
  projectScope: ID | null = null
  settings!: Settings
  saveState: 'saved' | 'dirty' | 'error' = 'saved'
  lastError: string | null = null

  /** Body/title as last written to disk, for change detection. */
  private savedTitle = ''
  private savedBody = ''
  /** The live editor text, mirrored here so a flush can run without touching the DOM. */
  private liveTitle = ''
  private liveBody = ''

  private ftsHits: Map<ID, number> | null = null
  private ftsQuery = ''
  private saveTimer: number | null = null
  private maxWaitTimer: number | null = null
  private draftTimer: number | null = null
  private inFlight: Promise<void> | null = null

  private listeners = new Map<string, Set<Listener>>()

  on(event: 'list' | 'open' | 'save' | 'settings', fn: Listener): void {
    let set = this.listeners.get(event)
    if (!set) this.listeners.set(event, (set = new Set()))
    set.add(fn)
  }

  private emit(event: 'list' | 'open' | 'save' | 'settings'): void {
    for (const fn of this.listeners.get(event) ?? []) fn()
  }

  // ------------------------------------------------------------- loading

  async load(): Promise<void> {
    this.settings = await window.stash.settingsGet()
    this.view = this.settings.showTrash ? 'trash' : 'all'
    this.projectScope = this.settings.projectScope
    this.projects = await window.stash.projectList()
    this.summaries = await window.stash.list()
    this.reindex()
    this.recompute()
  }

  private reindex(): void {
    this.index.clear()
    for (const s of this.summaries) this.index.set(s.id, s)
  }

  async refresh(): Promise<void> {
    this.projects = await window.stash.projectList()
    this.summaries = await window.stash.list()
    this.reindex()
    this.recompute()
  }

  // ------------------------------------------------------------ filtering

  setQuery(q: string): void {
    this.query = q
    // Fire the full-text search alongside the instant local filter. The local pass
    // paints this frame; body-only matches join a few milliseconds later.
    if (q.trim()) {
      const mine = q
      void window.stash
        .search(q)
        .then((hits) => {
          if (this.query !== mine) return
          this.ftsQuery = mine
          this.ftsHits = new Map(hits.map((h) => [h.id, h.score]))
          this.recompute()
          this.emit('list')
        })
        .catch(() => {
          /* search failing must never break typing */
        })
    } else {
      this.ftsHits = null
      this.ftsQuery = ''
    }
    this.recompute()
    this.emit('list')
  }

  setView(view: View): void {
    this.view = view
    this.tag = null
    void window.stash.settingsSet({ showTrash: view === 'trash' })
    this.settings.showTrash = view === 'trash'
    this.recompute()
    this.emit('list')
  }

  setProjectScope(id: ID | null): void {
    this.projectScope = id
    this.settings.projectScope = id
    void window.stash.settingsSet({ projectScope: id })
    this.recompute()
    this.emit('list')
  }

  projectName(id: ID | null): string | null {
    if (!id) return null
    return this.projects.find((p) => p.id === id)?.name ?? null
  }

  projectColor(id: ID | null): string | null {
    if (!id) return null
    return this.projects.find((p) => p.id === id)?.color ?? null
  }

  setTag(tag: string | null): void {
    this.tag = tag
    this.recompute()
    this.emit('list')
  }

  setSort(sort: SortKey): void {
    this.settings.sort = sort
    void window.stash.settingsSet({ sort })
    this.recompute()
    this.emit('list')
    this.emit('settings')
  }

  private passesView(s: PromptSummary): boolean {
    if (this.view === 'trash') return s.trashedAt !== null
    if (s.trashedAt !== null) return false
    // Project scope narrows everything else: search, pinned, tags all act within it.
    if (this.projectScope && s.projectId !== this.projectScope) return false
    if (this.view === 'pinned' && !s.pinned) return false
    if (this.tag && !s.tags.includes(this.tag)) return false
    return true
  }

  recompute(): void {
    const q = this.query.trim()
    const pool = this.summaries.filter((s) => this.passesView(s))

    if (!q) {
      this.order = sortSummaries(pool, this.settings?.sort ?? 'updated').map((s) => s.id)
      return
    }

    // Pass one: title, tags and the stored excerpt — no IPC, runs every keystroke.
    const scored: { s: PromptSummary; score: number }[] = []
    const matched = new Set<ID>()
    for (const s of pool) {
      const name = displayTitle(s.title, s.excerpt).text
      let score = fuzzyScore(name, q)
      if (s.tags.length) {
        const tagScore = fuzzyScore(s.tags.join(' '), q) * 0.75
        if (tagScore > score) score = tagScore
      }
      if (score <= 0 && s.excerpt.toLowerCase().includes(q.toLowerCase())) score = 240
      if (score <= 0) {
        const project = this.projectName(s.projectId)
        if (project && fuzzyScore(project, q) > 0) score = 200
      }
      if (score > 0) {
        scored.push({ s, score })
        matched.add(s.id)
      }
    }
    scored.sort((a, b) => b.score - a.score || b.s.updatedAt - a.s.updatedAt)

    // Pass two: anything the full-text index found deeper in the body, appended so a
    // title match always outranks a body match.
    const deep: { s: PromptSummary; score: number }[] = []
    if (this.ftsHits && this.ftsQuery === this.query) {
      for (const [id, score] of this.ftsHits) {
        if (matched.has(id)) continue
        const s = this.index.get(id)
        if (s && this.passesView(s)) deep.push({ s, score })
      }
      deep.sort((a, b) => b.score - a.score)
    }

    this.order = [...scored.map((x) => x.s.id), ...deep.map((x) => x.s.id)]
  }

  // -------------------------------------------------------------- opening

  async select(id: ID | null): Promise<void> {
    if (id === this.selectedId) return
    await this.flush()
    this.selectedId = id
    if (id === null) {
      this.open = null
    } else {
      const p = await window.stash.get(id)
      this.open = p
      this.savedTitle = p?.title ?? ''
      this.savedBody = p?.body ?? ''
      this.liveTitle = this.savedTitle
      this.liveBody = this.savedBody
      void window.stash.settingsSet({ lastPromptId: id })
      this.settings.lastPromptId = id
    }
    this.setSaveState('saved')
    this.emit('open')
  }

  // ------------------------------------------------------------- autosave

  /**
   * Called on every keystroke. Two writes follow: a cheap mirror into the drafts table
   * within DRAFT_DEBOUNCE_MS, and the real save (history, full-text index) once typing
   * settles. Both land on disk before they return.
   */
  edit(title: string, body: string): void {
    if (!this.open) return
    this.liveTitle = title
    this.liveBody = body
    if (title === this.savedTitle && body === this.savedBody) {
      this.cancelTimers()
      this.cancelDraft()
      this.setSaveState('saved')
      return
    }
    this.setSaveState('dirty')
    this.writeDraft()

    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    this.saveTimer = window.setTimeout(() => void this.flush(), AUTOSAVE_DEBOUNCE_MS)
    // A long uninterrupted burst of typing would otherwise keep pushing the debounce
    // out forever; this caps how far behind the database can fall.
    if (this.maxWaitTimer === null) {
      this.maxWaitTimer = window.setTimeout(() => void this.flush(), AUTOSAVE_MAX_WAIT_MS)
    }
  }

  private cancelTimers(): void {
    this.cancelDraft()
    if (this.saveTimer !== null) clearTimeout(this.saveTimer)
    if (this.maxWaitTimer !== null) clearTimeout(this.maxWaitTimer)
    this.saveTimer = null
    this.maxWaitTimer = null
  }

  /** Writes any pending edit now. Safe to call at any time, including during quit. */
  async flush(): Promise<void> {
    this.cancelTimers()
    if (this.inFlight) await this.inFlight
    const p = this.open
    if (!p) return
    const title = this.liveTitle
    const body = this.liveBody
    if (title === this.savedTitle && body === this.savedBody) {
      this.setSaveState('saved')
      return
    }
    const run = async (): Promise<void> => {
      try {
        const res = await window.stash.save({ id: p.id, title, body })
        if (!res) return
        this.savedTitle = title
        this.savedBody = body
        p.title = title
        p.body = body
        p.updatedAt = res.updatedAt
        const s = this.index.get(p.id)
        if (s) {
          s.title = title
          s.excerpt = body.slice(0, 160)
          s.chars = body.length
          // Must match the whole body, not the excerpt, or the list disagrees with
          // the count in the editor footer.
          s.words = countWords(body)
          s.updatedAt = res.updatedAt
        }
        this.setSaveState('saved')
        // Autosave fires every few hundred milliseconds while typing, and recompute()
        // sorts the whole library. Skip it when the result cannot have changed: no
        // search active and the edited prompt is already at the top of the order.
        // Only safe for the "updated" sort: under "title" an edited title reorders even
        // from the top, and a search re-scores on every change.
        const orderUnchanged =
          !this.query.trim() && this.settings.sort === 'updated' && this.order[0] === p.id
        if (!orderUnchanged) this.recompute()
        this.emit('list')
      } catch (err) {
        // Keep the draft on disk and keep the text on screen; never discard an edit
        // because the write failed.
        this.lastError = String((err as Error)?.message ?? err)
        this.setSaveState('error')
      }
    }
    this.inFlight = run().finally(() => {
      this.inFlight = null
    })
    await this.inFlight
  }

  private setSaveState(s: 'saved' | 'dirty' | 'error'): void {
    if (this.saveState === s) return
    this.saveState = s
    this.emit('save')
  }

  // ---------------------------------------------------------- crash mirror

  /**
   * Mirrors in-progress text to the drafts table. This used to write to localStorage,
   * which turned out to be useless for the job: Chromium buffers it in memory and it
   * never reaches disk before a hard kill (verified — see tools/test-durability.mjs).
   * A SQLite row with synchronous=FULL is on disk by the time the call returns.
   */
  private writeDraft(): void {
    if (!this.open) return
    if (this.draftTimer !== null) return
    this.draftTimer = window.setTimeout(() => {
      this.draftTimer = null
      const p = this.open
      if (!p) return
      if (this.liveTitle === this.savedTitle && this.liveBody === this.savedBody) return
      void window.stash
        .saveDraft({ id: p.id, title: this.liveTitle, body: this.liveBody })
        .catch(() => {
          /* the real autosave is still the guarantee */
        })
    }, DRAFT_DEBOUNCE_MS)
  }

  private cancelDraft(): void {
    if (this.draftTimer !== null) clearTimeout(this.draftTimer)
    this.draftTimer = null
  }

  get liveText(): { title: string; body: string } {
    return { title: this.liveTitle, body: this.liveBody }
  }
}

export function sortSummaries(list: PromptSummary[], sort: SortKey): PromptSummary[] {
  const out = [...list]
  const cmp: Record<SortKey, (a: PromptSummary, b: PromptSummary) => number> = {
    updated: (a, b) => b.updatedAt - a.updatedAt,
    created: (a, b) => b.createdAt - a.createdAt,
    used: (a, b) => (b.usedAt ?? 0) - (a.usedAt ?? 0) || b.updatedAt - a.updatedAt,
    title: (a, b) =>
      displayTitle(a.title, a.excerpt).text.localeCompare(displayTitle(b.title, b.excerpt).text),
  }
  const by = cmp[sort] ?? cmp.updated
  // Pinned prompts float to the top of whatever order is in effect.
  out.sort((a, b) => Number(b.pinned) - Number(a.pinned) || by(a, b))
  return out
}
