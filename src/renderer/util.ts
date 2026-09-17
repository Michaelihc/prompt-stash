import { SECTION_DIVIDER_RE } from '../shared/types'

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

export function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`missing element #${id}`)
  return node as T
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const UNITS: [number, string][] = [
  [60_000, 'm'],
  [3_600_000, 'h'],
  [86_400_000, 'd'],
]

export function relativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts
  if (diff < 45_000) return 'just now'
  if (diff < UNITS[1]![0]) return `${Math.round(diff / 60_000)}m ago`
  if (diff < UNITS[2]![0]) return `${Math.round(diff / 3_600_000)}h ago`
  const days = Math.round(diff / 86_400_000)
  if (days < 7) return `${days}d ago`
  const d = new Date(ts)
  const sameYear = d.getFullYear() === new Date(now).getFullYear()
  return d.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })
}

export function countWords(text: string): number {
  const m = text.match(/\S+/g)
  return m ? m.length : 0
}

/**
 * A rough token count. Deliberately labelled as an estimate in the UI: the real
 * number depends on the model's tokeniser, which is not available offline.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.round(text.length / 3.9))
}

export function formatCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`
  return `${Math.round(n / 1000)}k`
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1048576) return `${(n / 1024).toFixed(0)} KB`
  return `${(n / 1048576).toFixed(1)} MB`
}

export function firstLine(text: string): string {
  const line = text.split('\n', 1)[0] ?? ''
  return line.trim()
}

export function displayTitle(title: string, excerpt: string): { text: string; untitled: boolean } {
  const t = title.trim()
  if (t) return { text: t, untitled: false }
  const l = firstLine(excerpt)
  if (l) return { text: l.slice(0, 90), untitled: false }
  return { text: 'Untitled', untitled: true }
}

/** Matches `{{ name }}`; the name may not contain braces or newlines. */
export const VARIABLE_RE = /\{\{\s*([^{}\n]{1,60}?)\s*\}\}/g

export function findVariables(text: string): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const m of text.matchAll(VARIABLE_RE)) {
    const name = (m[1] ?? '').trim()
    if (name && !seen.has(name)) {
      seen.add(name)
      out.push(name)
    }
  }
  return out
}

export function fillVariables(text: string, values: Record<string, string>): string {
  return text.replace(VARIABLE_RE, (whole, rawName: string) => {
    const name = rawName.trim()
    const v = values[name]
    return v === undefined || v === '' ? whole : v
  })
}

/**
 * Subsequence match with a score. Used for the command palette and the instant
 * index filter, where the whole library is scanned on every keystroke — so this
 * stays allocation-light and bails early.
 */
export function fuzzyScore(haystack: string, needle: string): number {
  if (!needle) return 1
  const h = haystack.toLowerCase()
  const n = needle.toLowerCase()
  const direct = h.indexOf(n)
  if (direct === 0) return 1000 - h.length * 0.01
  if (direct > 0) return 700 - direct * 0.5 - h.length * 0.01

  let hi = 0
  let score = 0
  let streak = 0
  for (let ni = 0; ni < n.length; ni++) {
    const c = n.charCodeAt(ni)
    let found = -1
    while (hi < h.length) {
      if (h.charCodeAt(hi) === c) {
        found = hi
        break
      }
      hi++
    }
    if (found === -1) return 0
    streak = found === hi ? streak + 1 : 1
    const atWordStart = found === 0 || /[\s\-_/.]/.test(h[found - 1] ?? '')
    score += 10 + streak * 4 + (atWordStart ? 12 : 0)
    hi = found + 1
  }
  return score - h.length * 0.02
}

/**
 * The span of the section the caret sits in, where sections are separated by divider
 * lines. Blank lines either side are trimmed off so a select-all grabs the text and
 * not the padding around it.
 */
export function sectionBounds(text: string, caret: number): { start: number; end: number } {
  let start = 0
  let end = text.length
  let offset = 0
  for (const line of text.split('\n')) {
    const from = offset
    const to = offset + line.length
    offset = to + 1
    if (!SECTION_DIVIDER_RE.test(line)) continue
    if (caret > to) {
      start = Math.min(to + 1, text.length)
    } else if (caret < from) {
      end = Math.max(from - 1, 0)
      break
    } else {
      // The caret is on the divider itself; treat the divider as its own section.
      return { start: from, end: to }
    }
  }
  while (start < end && text.charCodeAt(start) === 10) start++
  while (end > start && text.charCodeAt(end - 1) === 10) end--
  return { start, end: Math.max(start, end) }
}

export function isDividerLine(line: string): boolean {
  return SECTION_DIVIDER_RE.test(line)
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  ms: number,
): ((...args: A) => void) & { cancel(): void; flush(...args: A): void } {
  let timer: number | null = null
  const wrapped = (...args: A): void => {
    if (timer !== null) clearTimeout(timer)
    timer = window.setTimeout(() => {
      timer = null
      fn(...args)
    }, ms)
  }
  wrapped.cancel = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  wrapped.flush = (...args: A): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    fn(...args)
  }
  return wrapped
}
