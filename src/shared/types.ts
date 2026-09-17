// The contract between main and renderer. Both sides import from here; nothing in
// this file may import from either process.

export type ID = string

export interface Prompt {
  id: ID
  title: string
  body: string
  tags: string[]
  pinned: boolean
  /** Unix ms when the prompt was moved to trash, or null if live. */
  trashedAt: number | null
  createdAt: number
  updatedAt: number
  usedAt: number | null
  useCount: number
  /** The project this prompt is filed under, or null when unfiled. */
  projectId: ID | null
}

export interface Project {
  id: ID
  name: string
  /** Hex colour, assigned on creation so projects are scannable in the list. */
  color: string
  createdAt: number
  /** Live prompts filed under it. */
  count: number
}

/**
 * What the list needs to render and filter. Deliberately excludes `body` so the
 * renderer can hold the whole library in memory without holding the whole text.
 */
export interface PromptSummary {
  id: ID
  title: string
  tags: string[]
  pinned: boolean
  trashedAt: number | null
  createdAt: number
  updatedAt: number
  usedAt: number | null
  useCount: number
  /** First ~160 characters of the body, for the index row and instant filtering. */
  excerpt: string
  chars: number
  words: number
  projectId: ID | null
}

export interface Version {
  versionId: number
  promptId: ID
  title: string
  body: string
  createdAt: number
}

export interface SearchHit {
  id: ID
  /** Higher is better. Body matches score below title/tag matches. */
  score: number
}

export interface Settings {
  theme: 'dark' | 'light' | 'system'
  sort: SortKey
  showTrash: boolean
  editorFont: 'sans' | 'mono'
  wrapColumn: boolean
  spellcheck: boolean
  lastPromptId: ID | null
  /** Project scope the list is filtered to, or null for everything. */
  projectScope: ID | null
  windowBounds: { x?: number; y?: number; width: number; height: number; maximized: boolean } | null
}

export type SortKey = 'updated' | 'created' | 'used' | 'title'

export interface Stats {
  total: number
  trashed: number
  words: number
  dbBytes: number
  dbPath: string
  dataDir: string
  lastBackupAt: number | null
}

export interface SaveResult {
  updatedAt: number
  /** Present when this save created a version snapshot. */
  versioned: boolean
}

export interface ImportResult {
  added: number
  updated: number
  skipped: number
}

export interface StartupReport {
  /** Set when the database failed its integrity check and a backup was restored. */
  recovered: { from: string; quarantined: string } | null
  /** Set when the store could not be opened at all; the app runs read-only. */
  fatal: string | null
  /** Prompts whose unsaved text was carried in from the drafts table after a crash. */
  recoveredDrafts: number
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'dark',
  sort: 'updated',
  showTrash: false,
  editorFont: 'sans',
  wrapColumn: true,
  spellcheck: false,
  lastPromptId: null,
  projectScope: null,
  windowBounds: null,
}

/** Trashed prompts older than this are purged on startup. */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
/** Versions kept per prompt. */
export const VERSION_LIMIT = 50
/** A new version snapshot is taken at most this often per prompt. */
export const VERSION_MIN_INTERVAL_MS = 5 * 60 * 1000
/** Rotating backups kept on disk. */
export const BACKUP_LIMIT = 10
/** Automatic backup interval. */
export const BACKUP_INTERVAL_MS = 24 * 60 * 60 * 1000
/** Autosave idle delay. An edit is never more than this far from durable. */
export const AUTOSAVE_DEBOUNCE_MS = 300
/**
 * How often in-progress text is mirrored to the drafts table. Shorter than the real
 * autosave because the write is a single row with no full-text reindexing behind it,
 * so it costs a fraction of a millisecond. This is the number that bounds how much
 * typing a hard crash can cost you.
 */
export const DRAFT_DEBOUNCE_MS = 120
/** Force a save during continuous typing even if the user never pauses. */
export const AUTOSAVE_MAX_WAIT_MS = 2000
/** Above this body size the variable-highlight overlay switches off to protect frame time. */
export const HIGHLIGHT_MAX_CHARS = 40000
export const EXCERPT_CHARS = 160

/**
 * Ctrl+Enter drops one of these into the body. It is a plain line of hyphens so the
 * text stays useful anywhere else it is pasted, and it reads as a rule in Markdown.
 */
export const SECTION_DIVIDER = '----------'
/** Any line that is only hyphens (three or more). Tolerates CRLF from imported text. */
export const SECTION_DIVIDER_RE = /^[ \t]*-{3,}[ \t]*\r?$/

/** The API surface exposed on `window.stash` by the preload script. */
export interface StashApi {
  startup(): Promise<StartupReport>
  list(): Promise<PromptSummary[]>
  get(id: ID): Promise<Prompt | null>
  create(init?: Partial<Pick<Prompt, 'title' | 'body' | 'tags' | 'projectId'>>): Promise<Prompt>
  duplicate(id: ID): Promise<Prompt | null>
  save(patch: { id: ID; title: string; body: string }): Promise<SaveResult | null>
  saveDraft(patch: { id: ID; title: string; body: string }): Promise<void>
  setPinned(id: ID, pinned: boolean): Promise<void>
  setTags(id: ID, tags: string[]): Promise<void>
  projectList(): Promise<Project[]>
  projectCreate(name: string): Promise<Project | null>
  projectRename(id: ID, name: string): Promise<void>
  projectDelete(id: ID): Promise<number>
  setProject(promptId: ID, projectId: ID | null): Promise<void>
  trash(ids: ID[]): Promise<void>
  restore(ids: ID[]): Promise<void>
  purge(ids: ID[]): Promise<void>
  emptyTrash(): Promise<number>
  markUsed(id: ID): Promise<void>
  search(query: string): Promise<SearchHit[]>
  versions(id: ID): Promise<Version[]>
  restoreVersion(id: ID, versionId: number): Promise<Prompt | null>
  settingsGet(): Promise<Settings>
  settingsSet(patch: Partial<Settings>): Promise<void>
  stats(): Promise<Stats>
  backupNow(): Promise<{ path: string } | null>
  exportAll(): Promise<{ path: string; count: number } | null>
  exportMarkdown(): Promise<{ path: string; count: number } | null>
  importFile(): Promise<ImportResult | null>
  openDataFolder(): Promise<void>
  copyText(text: string): Promise<void>
  setTitleBarTheme(background: string, symbol: string): Promise<void>
  flushNow(): Promise<void>
  onBeforeQuit(cb: () => void): void
  onThemeChange(cb: (isDark: boolean) => void): void
}

declare global {
  interface Window {
    stash: StashApi
  }
}
