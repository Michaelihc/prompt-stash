// The persistence layer. SQLite via node:sqlite — no native modules, no rebuild step.
//
// Durability model:
//   journal_mode = WAL      readers never block the writer
//   synchronous  = FULL     every committed transaction is fsynced before it returns
// A save is a single committed transaction. In-progress text is additionally mirrored
// to the drafts table on a much shorter cadence (DRAFT_DEBOUNCE_MS) — one row, no
// triggers — so a hard crash costs at most that much typing, and recoverDrafts() carries
// it back in on the next launch.

import { backup as sqliteBackup, DatabaseSync, type StatementSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  BACKUP_INTERVAL_MS,
  BACKUP_LIMIT,
  DEFAULT_SETTINGS,
  EXCERPT_CHARS,
  TRASH_RETENTION_MS,
  VERSION_LIMIT,
  VERSION_MIN_INTERVAL_MS,
  type ID,
  type ImportResult,
  type Prompt,
  type Project,
  type PromptSummary,
  type SaveResult,
  type SearchHit,
  type Settings,
  type Stats,
  type StartupReport,
  type Version,
} from '../shared/types'

const SCHEMA_VERSION = 4

interface PromptRow {
  id: string
  title: string
  body: string
  tags: string
  pinned: number
  trashed_at: number | null
  created_at: number
  updated_at: number
  used_at: number | null
  use_count: number
  words: number
  project_id: string | null
}

type SummaryRow = Omit<PromptRow, 'body'> & { excerpt: string; chars: number }

/** Assigned round-robin so a new project is immediately distinguishable. */
const PROJECT_COLORS = [
  '#7c6cff', '#4fc08d', '#e0a23c', '#43b3d6',
  '#e2646c', '#d97fd0', '#9aa55c', '#c98a5e',
]

let counter = 0
/** Time-ordered id: lexical sort matches creation order, with a per-ms counter and salt. */
export function newId(): ID {
  const t = Date.now().toString(36).padStart(9, '0')
  const c = (counter = (counter + 1) & 0xfff).toString(36).padStart(3, '0')
  const r = Math.floor(Math.random() * 0x1000000)
    .toString(36)
    .padStart(5, '0')
  return `${t}${c}${r}`
}

function countWords(text: string): number {
  const m = text.match(/\S+/g)
  return m ? m.length : 0
}

/**
 * SQLite stores TEXT as NUL-terminated, so a single U+0000 anywhere in a body would
 * silently truncate everything after it on write. Pasted binary or output from some
 * tools can carry one. Dropping the NUL loses one invisible character; keeping it
 * would lose the rest of the prompt.
 */
function clean(text: string): string {
  return text.indexOf('\u0000') === -1 ? text : text.split('\u0000').join('')
}

/**
 * Turns raw user input into a safe FTS5 query. Every token is quoted, so punctuation
 * the user types can never be parsed as FTS syntax; the final token gets a prefix
 * wildcard so results appear while they are still typing the word.
 */
function ftsQuery(raw: string): string | null {
  const tokens = raw.toLowerCase().match(/[\p{L}\p{N}_]+/gu)
  if (!tokens || tokens.length === 0) return null
  return tokens
    .slice(0, 12)
    .map((t, i) => `"${t}"` + (i === tokens.length - 1 ? '*' : ''))
    .join(' ')
}

export class Store {
  private db!: DatabaseSync
  private stmts = new Map<string, StatementSync>()
  readonly dataDir: string
  readonly dbPath: string
  readonly backupDir: string
  report: StartupReport = { recovered: null, fatal: null, recoveredDrafts: 0 }

  constructor(dataDir: string) {
    this.dataDir = dataDir
    this.dbPath = join(dataDir, 'stash.db')
    this.backupDir = join(dataDir, 'backups')
  }

  // ---------------------------------------------------------------- lifecycle

  open(): StartupReport {
    mkdirSync(this.dataDir, { recursive: true })
    mkdirSync(this.backupDir, { recursive: true })
    try {
      this.connect()
    } catch (err) {
      // The file exists but will not open. Never delete it — quarantine, then try the
      // newest backup so the user is looking at their prompts rather than an error.
      const recovered = this.recoverFromBackup(err)
      if (!recovered) {
        this.report.fatal = String((err as Error)?.message ?? err)
        return this.report
      }
    }
    try {
      this.migrate()
      this.report.recoveredDrafts = this.recoverDrafts()
      this.purgeExpiredTrash()
    } catch (err) {
      this.report.fatal = String((err as Error)?.message ?? err)
    }
    return this.report
  }

  private connect(): void {
    this.db = new DatabaseSync(this.dbPath)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA synchronous = FULL')
    this.db.exec('PRAGMA foreign_keys = ON')
    this.db.exec('PRAGMA busy_timeout = 5000')
    // Cheap structural check. Full integrity_check is O(db) and would delay startup.
    const check = this.db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined
    if (check?.quick_check !== 'ok') {
      throw new Error(`database failed quick_check: ${check?.quick_check ?? 'unknown'}`)
    }
  }

  private recoverFromBackup(cause: unknown): boolean {
    const backups = this.listBackups()
    if (backups.length === 0) return false
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const quarantined = join(this.dataDir, `stash.corrupt-${stamp}.db`)
    try {
      try {
        this.db?.close()
      } catch {
        /* the handle may never have opened */
      }
      if (existsSync(this.dbPath)) renameSync(this.dbPath, quarantined)
      for (const sidecar of ['-wal', '-shm']) {
        const p = this.dbPath + sidecar
        if (existsSync(p)) renameSync(p, quarantined + sidecar)
      }
      const newest = backups[0]!
      // Copy rather than move: the backup stays on disk in case this attempt also fails.
      const src = new DatabaseSync(newest.path, { readOnly: true })
      src.prepare('VACUUM INTO ?').run(this.dbPath)
      src.close()
      this.connect()
      this.report.recovered = { from: newest.path, quarantined }
      console.error('[store] recovered from backup', newest.path, 'cause:', cause)
      return true
    } catch (err) {
      console.error('[store] recovery failed', err)
      return false
    }
  }

  close(): void {
    try {
      // Refreshes stale statistics only when SQLite judges it worthwhile.
      this.db?.exec('PRAGMA optimize')
    } catch {
      /* never block quit on maintenance */
    }
    try {
      this.stmts.clear()
      this.db?.close()
    } catch {
      /* closing twice during quit is harmless */
    }
  }

  private q(sql: string): StatementSync {
    let s = this.stmts.get(sql)
    if (!s) {
      s = this.db.prepare(sql)
      this.stmts.set(sql, s)
    }
    return s
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const out = fn()
      this.db.exec('COMMIT')
      return out
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* already rolled back */
      }
      throw err
    }
  }

  // ----------------------------------------------------------------- schema

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    let v = row.user_version
    if (v === 0) {
      this.db.exec(`
        CREATE TABLE prompts (
          id         TEXT PRIMARY KEY,
          title      TEXT NOT NULL DEFAULT '',
          body       TEXT NOT NULL DEFAULT '',
          tags       TEXT NOT NULL DEFAULT '[]',
          pinned     INTEGER NOT NULL DEFAULT 0,
          trashed_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          used_at    INTEGER,
          use_count  INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_prompts_updated ON prompts(updated_at DESC);
        CREATE INDEX idx_prompts_trashed ON prompts(trashed_at);

        CREATE TABLE versions (
          version_id INTEGER PRIMARY KEY AUTOINCREMENT,
          prompt_id  TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
          title      TEXT NOT NULL,
          body       TEXT NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX idx_versions_prompt ON versions(prompt_id, created_at DESC);

        CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

        CREATE VIRTUAL TABLE prompts_fts USING fts5(
          title, body, tags,
          content='prompts', content_rowid='rowid',
          tokenize="unicode61 remove_diacritics 2"
        );
        CREATE TRIGGER prompts_ai AFTER INSERT ON prompts BEGIN
          INSERT INTO prompts_fts(rowid, title, body, tags)
          VALUES (new.rowid, new.title, new.body, new.tags);
        END;
        CREATE TRIGGER prompts_ad AFTER DELETE ON prompts BEGIN
          INSERT INTO prompts_fts(prompts_fts, rowid, title, body, tags)
          VALUES ('delete', old.rowid, old.title, old.body, old.tags);
        END;
        CREATE TRIGGER prompts_au AFTER UPDATE ON prompts BEGIN
          INSERT INTO prompts_fts(prompts_fts, rowid, title, body, tags)
          VALUES ('delete', old.rowid, old.title, old.body, old.tags);
          INSERT INTO prompts_fts(rowid, title, body, tags)
          VALUES (new.rowid, new.title, new.body, new.tags);
        END;
      `)
      v = 1
      this.db.exec(`PRAGMA user_version = ${v}`)
    }
    if (v === 1) {
      // The list used to estimate word counts from character length, which disagreed
      // with the exact count shown in the editor. Store the real number instead.
      this.db.exec('ALTER TABLE prompts ADD COLUMN words INTEGER NOT NULL DEFAULT 0')
      const rows = this.db.prepare('SELECT id, body FROM prompts').all() as unknown as {
        id: string
        body: string
      }[]
      const up = this.db.prepare('UPDATE prompts SET words = ? WHERE id = ?')
      this.db.exec('BEGIN IMMEDIATE')
      try {
        for (const r of rows) up.run(countWords(r.body), r.id)
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
      v = 2
      this.db.exec(`PRAGMA user_version = ${v}`)
    }
    if (v === 2) {
      // In-progress text, mirrored far more often than the real autosave. Deliberately
      // has no triggers on it: writing here does not touch the full-text index or the
      // version history, which is what makes a 120ms cadence affordable.
      this.db.exec(`
        CREATE TABLE drafts (
          prompt_id TEXT PRIMARY KEY REFERENCES prompts(id) ON DELETE CASCADE,
          title     TEXT NOT NULL,
          body      TEXT NOT NULL,
          at        INTEGER NOT NULL
        );
      `)
      v = 3
      this.db.exec(`PRAGMA user_version = ${v}`)
    }
    if (v === 3) {
      // Projects: a prompt belongs to at most one, which is what makes them useful as
      // a scope to filter by. Tags stay free-form and many-per-prompt.
      this.db.exec(`
        CREATE TABLE projects (
          id         TEXT PRIMARY KEY,
          name       TEXT NOT NULL,
          color      TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX idx_projects_name ON projects(name COLLATE NOCASE);
        ALTER TABLE prompts ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL;
        CREATE INDEX idx_prompts_project ON prompts(project_id);
      `)
      v = 4
      this.db.exec(`PRAGMA user_version = ${v}`)
    }
    // Give the planner real statistics. Without them it can pick a catastrophic plan
    // for the search query (see search()); with them every query plan is stable.
    // Costs ~4ms on a 20k-row database.
    this.db.exec('ANALYZE')
    if (v > SCHEMA_VERSION) {
      throw new Error(
        `This stash was written by a newer version of Prompt Stash (schema ${v}). Update the app to open it.`,
      )
    }
  }

  // ------------------------------------------------------------------ reads

  list(): PromptSummary[] {
    const rows = this.q(
      `SELECT id, title, substr(body, 1, ${EXCERPT_CHARS}) AS excerpt, length(body) AS chars,
              tags, pinned, trashed_at, created_at, updated_at, used_at, use_count, words, project_id
       FROM prompts ORDER BY updated_at DESC`,
    ).all() as unknown as SummaryRow[]
    return rows.map((r) => this.toSummary(r))
  }

  private toSummary(r: SummaryRow): PromptSummary {
    return {
      id: r.id,
      title: r.title,
      tags: safeTags(r.tags),
      pinned: r.pinned === 1,
      trashedAt: r.trashed_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      usedAt: r.used_at,
      useCount: r.use_count,
      excerpt: r.excerpt,
      chars: r.chars,
      words: r.words,
      projectId: r.project_id,
    }
  }

  private toPrompt(r: PromptRow): Prompt {
    return {
      id: r.id,
      title: r.title,
      body: r.body,
      tags: safeTags(r.tags),
      pinned: r.pinned === 1,
      trashedAt: r.trashed_at,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      usedAt: r.used_at,
      useCount: r.use_count,
      projectId: r.project_id,
    }
  }

  get(id: ID): Prompt | null {
    const r = this.q('SELECT * FROM prompts WHERE id = ?').get(id) as unknown as
      | PromptRow
      | undefined
    return r ? this.toPrompt(r) : null
  }

  /** Full-text search over title, body and tags. Excludes trashed prompts. */
  search(raw: string): SearchHit[] {
    const match = ftsQuery(raw)
    if (!match) return []
    try {
      // The subquery is deliberate. Written as a flat JOIN, SQLite drives the join from
      // idx_prompts_trashed and probes the FTS index once per row — on a 20k-prompt
      // database with no ANALYZE stats that measured 15-30 SECONDS per keystroke.
      // Materialising the FTS top-N as a co-routine first pins the order: ~11ms worst case.
      const rows = this.q(
        `SELECT p.id AS id, f.rank AS rank
         FROM (
           SELECT rowid AS rid, bm25(prompts_fts, 12.0, 1.0, 6.0) AS rank
           FROM prompts_fts WHERE prompts_fts MATCH ? ORDER BY rank LIMIT 300
         ) f
         JOIN prompts p ON p.rowid = f.rid
         WHERE p.trashed_at IS NULL
         ORDER BY f.rank LIMIT 200`,
      ).all(match) as unknown as { id: string; rank: number }[]
      // bm25 returns "smaller is better" (negative); flip it so callers can sort desc.
      return rows.map((r) => ({ id: r.id, score: -r.rank }))
    } catch (err) {
      console.error('[store] search failed', err)
      return []
    }
  }

  versions(id: ID): Version[] {
    const rows = this.q(
      'SELECT version_id, prompt_id, title, body, created_at FROM versions WHERE prompt_id = ? ORDER BY created_at DESC',
    ).all(id) as unknown as {
      version_id: number
      prompt_id: string
      title: string
      body: string
      created_at: number
    }[]
    return rows.map((r) => ({
      versionId: r.version_id,
      promptId: r.prompt_id,
      title: r.title,
      body: r.body,
      createdAt: r.created_at,
    }))
  }

  stats(): Stats {
    const agg = this.q(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN trashed_at IS NOT NULL THEN 1 ELSE 0 END) AS trashed,
              SUM(length(body)) AS chars, SUM(words) AS words
       FROM prompts`,
    ).get() as unknown as { total: number; trashed: number; chars: number | null; words: number | null }
    let dbBytes = 0
    try {
      dbBytes = statSync(this.dbPath).size
      for (const s of ['-wal', '-shm']) {
        if (existsSync(this.dbPath + s)) dbBytes += statSync(this.dbPath + s).size
      }
    } catch {
      /* size is cosmetic */
    }
    return {
      total: agg.total ?? 0,
      trashed: agg.trashed ?? 0,
      words: agg.words ?? 0,
      dbBytes,
      dbPath: this.dbPath,
      dataDir: this.dataDir,
      lastBackupAt: this.getMetaNumber('lastBackupAt'),
    }
  }

  // ----------------------------------------------------------------- writes

  create(init: Partial<Pick<Prompt, 'title' | 'body' | 'tags' | 'projectId'>> = {}): Prompt {
    const now = Date.now()
    const id = newId()
    this.q(
      `INSERT INTO prompts (id, title, body, tags, created_at, updated_at, words, project_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      clean(init.title ?? ''),
      clean(init.body ?? ''),
      JSON.stringify((init.tags ?? []).map(clean)),
      now,
      now,
      countWords(clean(init.body ?? '')),
      init.projectId ?? null,
    )
    return this.get(id)!
  }

  duplicate(id: ID): Prompt | null {
    const src = this.get(id)
    if (!src) return null
    return this.create({
      title: nextCopyTitle(src.title),
      body: src.body,
      tags: src.tags,
      projectId: src.projectId,
    })
  }

  /**
   * The autosave path. Writes title+body and, when the body has meaningfully changed
   * and enough time has passed, snapshots the *previous* text into history first.
   */
  save(input: { id: ID; title: string; body: string }): SaveResult | null {
    const patch = { id: input.id, title: clean(input.title), body: clean(input.body) }
    const prev = this.get(patch.id)
    if (!prev) return null
    if (prev.title === patch.title && prev.body === patch.body) {
      return { updatedAt: prev.updatedAt, versioned: false }
    }
    const now = Date.now()
    return this.tx(() => {
      let versioned = false
      if (prev.body !== patch.body && prev.body.length > 0) {
        const last = this.q(
          'SELECT created_at FROM versions WHERE prompt_id = ? ORDER BY created_at DESC LIMIT 1',
        ).get(patch.id) as unknown as { created_at: number } | undefined
        const elapsed = now - (last?.created_at ?? 0)
        const delta = Math.abs(patch.body.length - prev.body.length)
        // Snapshot on a lull, or immediately when a big chunk appeared or vanished.
        if (elapsed > VERSION_MIN_INTERVAL_MS || delta > 400) {
          this.q(
            'INSERT INTO versions (prompt_id, title, body, created_at) VALUES (?, ?, ?, ?)',
          ).run(patch.id, prev.title, prev.body, now)
          this.q(
            `DELETE FROM versions WHERE prompt_id = ? AND version_id NOT IN (
               SELECT version_id FROM versions WHERE prompt_id = ? ORDER BY created_at DESC LIMIT ${VERSION_LIMIT}
             )`,
          ).run(patch.id, patch.id)
          versioned = true
        }
      }
      this.q('UPDATE prompts SET title = ?, body = ?, updated_at = ?, words = ? WHERE id = ?').run(
        patch.title,
        patch.body,
        now,
        countWords(patch.body),
        patch.id,
      )
      this.q('DELETE FROM drafts WHERE prompt_id = ?').run(patch.id)
      return { updatedAt: now, versioned }
    })
  }

  /**
   * Mirrors in-progress text. One row, no triggers, no history — cheap enough to run
   * every few keystrokes so a hard crash costs at most DRAFT_DEBOUNCE_MS of typing.
   */
  saveDraft(patch: { id: ID; title: string; body: string }): void {
    this.q(
      `INSERT INTO drafts (prompt_id, title, body, at) VALUES (?, ?, ?, ?)
       ON CONFLICT(prompt_id) DO UPDATE SET title = excluded.title, body = excluded.body, at = excluded.at`,
    ).run(patch.id, clean(patch.title), clean(patch.body), Date.now())
  }

  /**
   * Startup repair. A draft that is newer than its prompt means the app died between
   * a keystroke and the autosave; carry the text in. It goes through save(), so the
   * text being replaced is snapshotted into history first and nothing is overwritten
   * silently.
   */
  private recoverDrafts(): number {
    const rows = this.q(
      `SELECT d.prompt_id AS id, d.title AS title, d.body AS body
       FROM drafts d JOIN prompts p ON p.id = d.prompt_id
       WHERE d.at > p.updated_at AND (d.body <> p.body OR d.title <> p.title)`,
    ).all() as unknown as { id: string; title: string; body: string }[]
    let n = 0
    for (const r of rows) {
      if (this.save({ id: r.id, title: r.title, body: r.body })) n++
    }
    this.q('DELETE FROM drafts').run()
    return n
  }

  // ---------------------------------------------------------------- projects

  projectList(): Project[] {
    const rows = this.q(
      `SELECT p.id AS id, p.name AS name, p.color AS color, p.created_at AS created_at,
              (SELECT COUNT(*) FROM prompts x WHERE x.project_id = p.id AND x.trashed_at IS NULL) AS count
       FROM projects p ORDER BY p.name COLLATE NOCASE`,
    ).all() as unknown as {
      id: string
      name: string
      color: string
      created_at: number
      count: number
    }[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      color: r.color,
      createdAt: r.created_at,
      count: r.count,
    }))
  }

  /** Creating a project that already exists returns the existing one, case-insensitively. */
  projectCreate(name: string): Project | null {
    const clean_ = clean(name).trim().slice(0, 60)
    if (!clean_) return null
    const existing = this.q('SELECT id FROM projects WHERE name = ? COLLATE NOCASE').get(clean_) as
      | { id: string }
      | undefined
    if (existing) return this.projectList().find((p) => p.id === existing.id) ?? null
    const id = newId()
    const used = (this.q('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n
    this.q('INSERT INTO projects (id, name, color, created_at) VALUES (?, ?, ?, ?)').run(
      id,
      clean_,
      PROJECT_COLORS[used % PROJECT_COLORS.length]!,
      Date.now(),
    )
    return this.projectList().find((p) => p.id === id) ?? null
  }

  projectRename(id: ID, name: string): void {
    const clean_ = clean(name).trim().slice(0, 60)
    if (!clean_) return
    const clash = this.q('SELECT id FROM projects WHERE name = ? COLLATE NOCASE AND id <> ?').get(
      clean_,
      id,
    ) as { id: string } | undefined
    if (clash) return
    this.q('UPDATE projects SET name = ? WHERE id = ?').run(clean_, id)
  }

  projectSetColor(id: ID, color: string): void {
    this.q('UPDATE projects SET color = ? WHERE id = ?').run(clean(color).slice(0, 9), id)
  }

  /** Deleting a project never deletes prompts; they simply become unfiled. */
  projectDelete(id: ID): number {
    return this.tx(() => {
      const n = (
        this.q('SELECT COUNT(*) AS n FROM prompts WHERE project_id = ?').get(id) as { n: number }
      ).n
      this.q('UPDATE prompts SET project_id = NULL WHERE project_id = ?').run(id)
      this.q('DELETE FROM projects WHERE id = ?').run(id)
      return n
    })
  }

  setProject(promptId: ID, projectId: ID | null): void {
    this.q('UPDATE prompts SET project_id = ? WHERE id = ?').run(projectId, promptId)
  }

  setPinned(id: ID, pinned: boolean): void {
    this.q('UPDATE prompts SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
  }

  setTags(id: ID, tags: string[]): void {
    const normalised = [
      ...new Set(tags.map((t) => clean(t).trim().toLowerCase()).filter(Boolean)),
    ].slice(0, 24)
    this.q('UPDATE prompts SET tags = ? WHERE id = ?').run(JSON.stringify(normalised), id)
  }

  trash(ids: ID[]): void {
    const now = Date.now()
    const s = this.q('UPDATE prompts SET trashed_at = ? WHERE id = ?')
    this.tx(() => {
      for (const id of ids) s.run(now, id)
    })
  }

  restore(ids: ID[]): void {
    const s = this.q('UPDATE prompts SET trashed_at = NULL WHERE id = ?')
    this.tx(() => {
      for (const id of ids) s.run(id)
    })
  }

  purge(ids: ID[]): void {
    const s = this.q('DELETE FROM prompts WHERE id = ?')
    this.tx(() => {
      for (const id of ids) s.run(id)
    })
  }

  emptyTrash(): number {
    const n = this.q('SELECT COUNT(*) AS n FROM prompts WHERE trashed_at IS NOT NULL').get() as
      | { n: number }
      | undefined
    this.q('DELETE FROM prompts WHERE trashed_at IS NOT NULL').run()
    return n?.n ?? 0
  }

  markUsed(id: ID): void {
    this.q('UPDATE prompts SET used_at = ?, use_count = use_count + 1 WHERE id = ?').run(
      Date.now(),
      id,
    )
  }

  restoreVersion(id: ID, versionId: number): Prompt | null {
    const v = this.q('SELECT title, body FROM versions WHERE version_id = ? AND prompt_id = ?').get(
      versionId,
      id,
    ) as unknown as { title: string; body: string } | undefined
    if (!v) return null
    // Goes through save(), so the text being replaced is itself snapshotted first.
    this.save({ id, title: v.title, body: v.body })
    return this.get(id)
  }

  private purgeExpiredTrash(): void {
    const cutoff = Date.now() - TRASH_RETENTION_MS
    this.q('DELETE FROM prompts WHERE trashed_at IS NOT NULL AND trashed_at < ?').run(cutoff)
  }

  // ---------------------------------------------------------------- settings

  private getMeta(key: string): string | null {
    const r = this.q('SELECT value FROM meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return r?.value ?? null
  }

  private getMetaNumber(key: string): number | null {
    const v = this.getMeta(key)
    if (v === null) return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }

  private setMeta(key: string, value: string): void {
    this.q(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value)
  }

  settingsGet(): Settings {
    const raw = this.getMeta('settings')
    if (!raw) return { ...DEFAULT_SETTINGS }
    try {
      return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
    } catch {
      return { ...DEFAULT_SETTINGS }
    }
  }

  settingsSet(patch: Partial<Settings>): void {
    this.setMeta('settings', JSON.stringify({ ...this.settingsGet(), ...patch }))
  }

  // ----------------------------------------------------------------- backups

  listBackups(): { path: string; at: number }[] {
    try {
      return readdirSync(this.backupDir)
        .filter((f) => f.startsWith('stash-') && f.endsWith('.db'))
        .map((f) => ({ path: join(this.backupDir, f), at: statSync(join(this.backupDir, f)).mtimeMs }))
        .sort((a, b) => b.at - a.at)
    } catch {
      return []
    }
  }

  /**
   * node:sqlite's backup() streams pages without blocking the event loop, so a large
   * stash does not freeze the window mid-copy, and the copy is consistent even while
   * you keep typing into it.
   */
  async backup(): Promise<{ path: string }> {
    mkdirSync(this.backupDir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const path = join(this.backupDir, `stash-${stamp}.db`)
    if (existsSync(path)) rmSync(path)
    await sqliteBackup(this.db, path)
    this.setMeta('lastBackupAt', String(Date.now()))
    for (const old of this.listBackups().slice(BACKUP_LIMIT)) {
      try {
        rmSync(old.path)
      } catch {
        /* a locked backup will be retried tomorrow */
      }
    }
    return { path }
  }

  /** Called after the window is up, never on the path to the first frame. */
  async maybeBackup(): Promise<void> {
    const last = this.getMetaNumber('lastBackupAt') ?? 0
    const empty = (this.q('SELECT COUNT(*) AS n FROM prompts').get() as { n: number }).n === 0
    if (empty || Date.now() - last < BACKUP_INTERVAL_MS) return
    try {
      await this.backup()
    } catch (err) {
      console.error('[store] scheduled backup failed', err)
    }
  }

  // ------------------------------------------------------------ import/export

  exportAll(): { version: number; exportedAt: number; prompts: Prompt[] } {
    const rows = this.q('SELECT * FROM prompts ORDER BY created_at').all() as unknown as PromptRow[]
    return {
      version: SCHEMA_VERSION,
      exportedAt: Date.now(),
      prompts: rows.map((r) => this.toPrompt(r)),
    }
  }

  /**
   * Merges an export back in. Existing prompts are only overwritten when the incoming
   * copy is strictly newer, and the text being replaced is snapshotted into history —
   * an import can never silently destroy work.
   */
  import(data: unknown): ImportResult {
    const prompts = extractPrompts(data)
    const out: ImportResult = { added: 0, updated: 0, skipped: 0 }
    if (prompts.length === 0) return out
    this.tx(() => {
      for (const p of prompts) {
        const existing = this.q('SELECT * FROM prompts WHERE id = ?').get(p.id) as unknown as
          | PromptRow
          | undefined
        if (!existing) {
          this.q(
            `INSERT INTO prompts (id, title, body, tags, pinned, trashed_at, created_at, updated_at, used_at, use_count)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            p.id,
            p.title,
            p.body,
            JSON.stringify(p.tags),
            p.pinned ? 1 : 0,
            p.trashedAt,
            p.createdAt,
            p.updatedAt,
            p.usedAt,
            p.useCount,
          )
          out.added++
        } else if (p.updatedAt > existing.updated_at && p.body !== existing.body) {
          this.q('INSERT INTO versions (prompt_id, title, body, created_at) VALUES (?, ?, ?, ?)').run(
            existing.id,
            existing.title,
            existing.body,
            Date.now(),
          )
          this.q('UPDATE prompts SET title = ?, body = ?, tags = ?, updated_at = ? WHERE id = ?').run(
            p.title,
            p.body,
            JSON.stringify(p.tags),
            p.updatedAt,
            p.id,
          )
          out.updated++
        } else {
          out.skipped++
        }
      }
    })
    return out
  }
}

function safeTags(raw: string): string[] {
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === 'string') : []
  } catch {
    return []
  }
}

function nextCopyTitle(title: string): string {
  const m = title.match(/^(.*) \((\d+)\)$/)
  if (m) return `${m[1]} (${Number(m[2]) + 1})`
  return title ? `${title} (copy)` : 'Untitled (copy)'
}

/** Accepts either a full export envelope or a bare array of prompts. */
function extractPrompts(data: unknown): Prompt[] {
  const raw = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { prompts?: unknown }).prompts)
      ? ((data as { prompts: unknown[] }).prompts)
      : []
  const now = Date.now()
  const out: Prompt[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const body = clean(typeof o.body === 'string' ? o.body : '')
    const title = clean(typeof o.title === 'string' ? o.title : '')
    if (!body && !title) continue
    out.push({
      id: typeof o.id === 'string' && o.id.length > 0 ? o.id : newId(),
      title,
      body,
      tags: Array.isArray(o.tags)
        ? o.tags.filter((t): t is string => typeof t === 'string').map(clean)
        : [],
      pinned: o.pinned === true,
      trashedAt: typeof o.trashedAt === 'number' ? o.trashedAt : null,
      createdAt: typeof o.createdAt === 'number' ? o.createdAt : now,
      updatedAt: typeof o.updatedAt === 'number' ? o.updatedAt : now,
      usedAt: typeof o.usedAt === 'number' ? o.usedAt : null,
      projectId: typeof o.projectId === 'string' ? o.projectId : null,
      useCount: typeof o.useCount === 'number' ? o.useCount : 0,
    })
  }
  return out
}
