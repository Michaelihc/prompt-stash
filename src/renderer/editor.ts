import { HIGHLIGHT_MAX_CHARS, SECTION_DIVIDER, type Prompt } from '../shared/types'
import type { AppState } from './state'
import {
  byId,
  countWords,
  el,
  escapeHtml,
  estimateTokens,
  formatCount,
  isDividerLine,
  sectionBounds,
  VARIABLE_RE,
} from './util'

/** Wraps every {{placeholder}} on one line, escaping everything else. */
function markVars(line: string): string {
  if (!line.includes('{{')) return escapeHtml(line)
  let html = ''
  let last = 0
  for (const m of line.matchAll(VARIABLE_RE)) {
    html += escapeHtml(line.slice(last, m.index))
    html += `<mark class="var">${escapeHtml(m[0])}</mark>`
    last = m.index + m[0].length
  }
  return html + escapeHtml(line.slice(last))
}

/**
 * The body is a plain <textarea> — native caret, native undo, native selection, no
 * input latency from a custom editor. Placeholder pills are painted by a backdrop
 * div sitting behind it that renders the same text transparently, so the real text
 * stays selectable on top. The two share metrics exactly via CSS or the pills drift.
 */
export class Editor {
  readonly pane = byId<HTMLDivElement>('editor-pane')
  readonly blank = byId<HTMLDivElement>('editor-blank')
  readonly title = byId<HTMLInputElement>('title')
  readonly body = byId<HTMLTextAreaElement>('body')
  private backdrop = byId<HTMLDivElement>('backdrop')
  private tagRow = byId<HTMLDivElement>('tag-row')
  private metrics = byId<HTMLSpanElement>('metrics')
  private saveDot = byId<HTMLSpanElement>('save-state')
  private frame = 0
  private highlightOn = true

  constructor(
    private state: AppState,
    private onTagsChanged: () => void,
    private onPickProject: () => void,
  ) {
    this.title.addEventListener('input', this.onInput)
    this.body.addEventListener('input', this.onInput)
    this.body.addEventListener('scroll', this.syncScroll, { passive: true })
    this.body.addEventListener('keydown', this.onBodyKey)
    this.tagRow.addEventListener('click', this.onTagClick)
  }

  private onBodyKey = (event: KeyboardEvent): void => {
    const ctrl = event.ctrlKey || event.metaKey
    if (!ctrl || event.altKey) return

    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      this.insertDivider()
      return
    }

    if (event.key.toLowerCase() === 'a' && !event.shiftKey) {
      // Select-all stops at the dividers either side of the caret. Pressing it again
      // with that section already selected widens to the whole prompt, so nothing is
      // unreachable.
      const text = this.body.value
      const caret = this.body.selectionDirection === 'backward'
        ? this.body.selectionEnd
        : this.body.selectionStart
      const { start, end } = sectionBounds(text, caret)
      const wholeAlready =
        this.body.selectionStart === start && this.body.selectionEnd === end
      event.preventDefault()
      if (wholeAlready && (start !== 0 || end !== text.length)) {
        this.body.setSelectionRange(0, text.length)
      } else {
        this.body.setSelectionRange(start, end)
      }
    }
  }

  /**
   * Ends the current section and starts a new one. Written through execCommand so it
   * joins the textarea's native undo stack — setRangeText would silently break Ctrl+Z.
   */
  private insertDivider(): void {
    const el = this.body
    const at = el.selectionStart
    const atLineStart = at === 0 || el.value.charCodeAt(at - 1) === 10
    const text = `${atLineStart ? '' : '\n'}${SECTION_DIVIDER}\n`
    el.focus()
    if (!document.execCommand('insertText', false, text)) {
      const end = el.selectionEnd
      el.setRangeText(text, at, end, 'end')
    }
    this.onInput()
    // Keep the new caret line in view when the divider lands at the bottom edge.
    el.scrollTop = Math.min(el.scrollTop + 0, el.scrollHeight)
  }

  private onInput = (): void => {
    this.state.edit(this.title.value, this.body.value)
    this.schedule()
  }

  private syncScroll = (): void => {
    this.backdrop.scrollTop = this.body.scrollTop
    this.backdrop.scrollLeft = this.body.scrollLeft
  }

  /** Coalesces highlight + metrics work into one frame regardless of typing speed. */
  private schedule(): void {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.paintHighlight()
      this.paintMetrics()
    })
  }

  show(prompt: Prompt | null): void {
    if (!prompt) {
      this.pane.hidden = true
      this.blank.hidden = false
      return
    }
    this.blank.hidden = true
    this.pane.hidden = false
    this.title.value = prompt.title
    this.body.value = prompt.body
    this.body.scrollTop = 0
    this.applySettings()
    this.paintTags(prompt)
    this.paintHighlight()
    this.paintMetrics()
    this.syncScroll()
  }

  applySettings(): void {
    this.pane.dataset.font = this.state.settings.editorFont
    this.pane.dataset.measure = this.state.settings.wrapColumn ? 'on' : 'off'
    this.body.spellcheck = this.state.settings.spellcheck
    // Toggling spellcheck only takes effect on the next focus; nudge it.
    if (document.activeElement === this.body) {
      this.body.blur()
      this.body.focus()
    }
  }

  focusBody(): void {
    this.body.focus()
  }

  focusTitle(): void {
    this.title.focus()
    this.title.select()
  }

  private paintHighlight(): void {
    const text = this.body.value
    // Above the cap, rebuilding the overlay would cost more than a frame. The pills
    // switch off; the text itself is unaffected.
    const shouldHighlight = text.length <= HIGHLIGHT_MAX_CHARS
    if (!shouldHighlight) {
      if (this.highlightOn) {
        this.backdrop.textContent = ''
        this.highlightOn = false
      }
      return
    }
    this.highlightOn = true
    if (!text.includes('{{') && !text.includes('---')) {
      // Nothing to paint: skip the escaping work entirely.
      if (this.backdrop.firstChild) this.backdrop.textContent = ''
      return
    }
    // Line by line, because a divider is a whole line and a placeholder never spans one.
    const out: string[] = []
    for (const line of text.split('\n')) {
      out.push(isDividerLine(line) ? `<mark class="rule">${escapeHtml(line)}</mark>` : markVars(line))
    }
    // Keeps the final wrapped line in the backdrop aligned with the textarea.
    this.backdrop.innerHTML = out.join('\n') + '\n'
    this.syncScroll()
  }

  private paintMetrics(): void {
    const text = this.body.value
    const words = countWords(text)
    const bits = [
      `${formatCount(words)} ${words === 1 ? 'word' : 'words'}`,
      `${formatCount(text.length)} chars`,
      `~${formatCount(estimateTokens(text))} tokens`,
    ]
    const vars = new Set<string>()
    VARIABLE_RE.lastIndex = 0
    for (const m of text.matchAll(VARIABLE_RE)) {
      const n = (m[1] ?? '').trim()
      if (n) vars.add(n)
    }
    if (vars.size) bits.push(`${vars.size} ${vars.size === 1 ? 'variable' : 'variables'}`)
    let sections = 1
    for (const line of text.split('\n')) if (isDividerLine(line)) sections++
    if (sections > 1) bits.push(`${sections} sections`)
    this.metrics.textContent = bits.join('   ·   ')
  }

  paintSaveState(): void {
    this.saveDot.dataset.state = this.state.saveState
    this.saveDot.title =
      this.state.saveState === 'error'
        ? `Not saved: ${this.state.lastError ?? 'unknown error'}`
        : this.state.saveState === 'dirty'
          ? 'Saving'
          : 'Saved'
  }

  paintTags(prompt: Prompt): void {
    const nodes: HTMLElement[] = []

    // The project comes first and reads differently from a tag: one per prompt, and
    // it is the thing the whole list can be scoped to.
    const project = this.state.projects.find((p) => p.id === prompt.projectId)
    const chip = el('button', 'tag project-chip')
    chip.type = 'button'
    chip.dataset.action = 'project'
    chip.title = 'Move this prompt to a project'
    if (project) {
      const dot = el('span', 'project-dot')
      dot.style.background = project.color
      chip.append(dot, document.createTextNode(project.name))
    } else {
      chip.classList.add('project-empty')
      chip.textContent = 'No project'
    }
    nodes.push(chip)
    for (const t of prompt.tags) {
      const b = el('button', 'tag')
      b.type = 'button'
      b.dataset.tag = t
      b.textContent = t
      b.title = `Remove tag ${t}`
      nodes.push(b)
    }
    const add = el('button', 'tag tag-add', prompt.tags.length ? '+' : '+ tag')
    add.type = 'button'
    add.dataset.action = 'add'
    add.title = 'Add a tag'
    nodes.push(add)
    this.tagRow.replaceChildren(...nodes)
  }

  private onTagClick = (event: MouseEvent): void => {
    const target = (event.target as HTMLElement).closest('button') as HTMLButtonElement | null
    const prompt = this.state.open
    if (!target || !prompt) return
    if (target.dataset.action === 'project') {
      this.onPickProject()
      return
    }
    if (target.dataset.action === 'add') {
      this.beginAddTag(prompt.tags)
      return
    }
    const tag = target.dataset.tag
    if (!tag) return
    const next = prompt.tags.filter((t) => t !== tag)
    prompt.tags = next
    void window.stash.setTags(prompt.id, next).then(() => {
      const s = this.state.index.get(prompt.id)
      if (s) s.tags = next
      this.paintTags(prompt)
      this.onTagsChanged()
    })
  }

  private beginAddTag(existing: string[]): void {
    const input = el('input', 'tag-input')
    input.type = 'text'
    input.placeholder = 'tag'
    input.maxLength = 30
    const kept = [...this.tagRow.children].filter(
      (n) => !(n as HTMLElement).classList.contains('tag-add'),
    )
    this.tagRow.replaceChildren(...kept, input)
    void existing
    input.focus()
    // Commit exactly once. Repainting the tag row removes this input, which fires blur
    // and would otherwise re-enter commit while the first repaint is still running —
    // replaceChildren then throws and takes the rest of the update with it.
    let settled = false
    const commit = (apply: boolean): void => {
      if (settled) return
      settled = true
      input.removeEventListener('blur', onBlur)
      const prompt = this.state.open
      if (!prompt) return
      const value = apply ? input.value.trim().toLowerCase() : ''
      if (value && !prompt.tags.includes(value)) {
        const next = [...prompt.tags, value]
        prompt.tags = next
        this.paintTags(prompt)
        void window.stash.setTags(prompt.id, next).then(() => {
          const s = this.state.index.get(prompt.id)
          if (s) s.tags = next
          this.onTagsChanged()
        })
      } else {
        this.paintTags(prompt)
      }
    }
    const onBlur = (): void => commit(true)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        commit(true)
        this.body.focus()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        commit(false)
        this.body.focus()
      }
    })
    input.addEventListener('blur', onBlur)
  }
}
