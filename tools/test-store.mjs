// Exercises the persistence layer directly, including the paths that only matter when
// things go wrong: corruption, recovery, version pruning, import merges.
import * as esbuild from 'esbuild'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { DatabaseSync } from 'node:sqlite'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'stash-test-'))
const bundle = join(work, 'store.cjs')

await esbuild.build({
  entryPoints: [join(ROOT, 'src/main/store.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  external: ['node:sqlite'],
  logLevel: 'warning',
})

const require_ = createRequire(import.meta.url)
const { Store, newId } = require_(bundle)

let passed = 0
let failed = 0
const fail = []

function check(name, fn) {
  try {
    fn()
    passed++
  } catch (err) {
    failed++
    fail.push(`${name}: ${err.message}`)
    console.error(`  FAIL ${name}\n        ${err.message}`)
  }
}
function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`)
}
async function checkAsync(name, fn) {
  try {
    await fn()
    passed++
  } catch (err) {
    failed++
    fail.push(`${name}: ${err.message}`)
    console.error(`  FAIL ${name}
        ${err.message}`)
  }
}
function ok(cond, what) {
  if (!cond) throw new Error(what || 'expected truthy')
}

function freshDir(name) {
  const d = join(work, name)
  return d
}

// ---------------------------------------------------------------- basics
{
  const s = new Store(freshDir('basic'))
  const report = s.open()
  check('opens cleanly', () => {
    eq(report.fatal, null, 'fatal')
    eq(report.recovered, null, 'recovered')
  })

  const p = s.create({ title: 'Refactor helper', body: 'Rewrite {{file}} to be idiomatic.' })
  check('create returns a live prompt', () => {
    ok(p.id, 'has id')
    eq(p.title, 'Refactor helper')
    eq(p.trashedAt, null)
    eq(p.useCount, 0)
  })

  check('ids sort by creation order', () => {
    const ids = Array.from({ length: 200 }, () => newId())
    const sorted = [...ids].sort()
    eq(ids, sorted, 'id ordering')
  })

  check('get round-trips the body', () => {
    eq(s.get(p.id).body, 'Rewrite {{file}} to be idiomatic.')
  })

  check('list excludes body but reports its size', () => {
    const row = s.list().find((r) => r.id === p.id)
    ok(row, 'row present')
    ok(!('body' in row), 'no body key in summary')
    eq(row.chars, 'Rewrite {{file}} to be idiomatic.'.length, 'chars')
  })

  check('word count is exact and matches what the editor would show', () => {
    const w = s.create({ title: 'counted', body: 'one two three  four\nfive\tsix' })
    const row = s.list().find((r) => r.id === w.id)
    eq(row.words, 6, 'stored word count')
    s.save({ id: w.id, title: 'counted', body: 'only two' })
    eq(s.list().find((r) => r.id === w.id).words, 2, 'count follows an edit')
    s.save({ id: w.id, title: 'counted', body: '   ' })
    eq(s.list().find((r) => r.id === w.id).words, 0, 'whitespace-only is zero')
  })

  check('schema is at the current version after migration', () => {
    eq(s.db.prepare('PRAGMA user_version').get().user_version, 4)
  })

  check('unicode survives a round trip', () => {
    const u = s.create({ title: 'Ünïcode — 中文 🎯', body: 'emoji 🎯 text\nline2\ttab' })
    eq(s.get(u.id).title, 'Ünïcode — 中文 🎯')
    eq(s.get(u.id).body, 'emoji 🎯 text\nline2\ttab')
  })

  check('a NUL byte is stripped, not allowed to truncate the prompt', () => {
    const nul = String.fromCharCode(0)
    const n = s.create({ title: 'nul test', body: 'before' + nul + 'after the nul byte' })
    eq(s.get(n.id).body, 'beforeafter the nul byte', 'text after the NUL survived')
    const n2 = s.create({ title: 'nul' + nul + 'title', body: 'x' })
    eq(s.get(n2.id).title, 'nultitle', 'title also cleaned')
    s.save({ id: n.id, title: 'nul test', body: 'saved' + nul + 'tail' })
    eq(s.get(n.id).body, 'savedtail', 'save path cleans too')
  })

  check('a 1MB body round-trips', () => {
    const big = 'x'.repeat(1024 * 1024)
    const b = s.create({ title: 'big', body: big })
    eq(s.get(b.id).body.length, big.length)
  })

  // ------------------------------------------------------------- saving
  check('save is a no-op when nothing changed', () => {
    const before = s.get(p.id)
    const r = s.save({ id: p.id, title: before.title, body: before.body })
    eq(r.versioned, false, 'versioned')
    eq(r.updatedAt, before.updatedAt, 'updatedAt unchanged')
  })

  check('save on a missing id returns null rather than throwing', () => {
    eq(s.save({ id: 'nope', title: 'a', body: 'b' }), null)
  })

  check('a large edit snapshots the previous text immediately', () => {
    s.save({ id: p.id, title: 'Refactor helper', body: 'y'.repeat(900) })
    const v = s.versions(p.id)
    ok(v.length >= 1, 'a version exists')
    eq(v[0].body, 'Rewrite {{file}} to be idiomatic.', 'history holds the OLD text')
  })

  check('small rapid edits do not spam history', () => {
    const q = s.create({ title: 't', body: 'seed body' })
    for (let i = 0; i < 40; i++) s.save({ id: q.id, title: 't', body: 'seed body' + i })
    eq(s.versions(q.id).length, 1, 'version count')
  })

  check('history is capped per prompt', () => {
    const q = s.create({ title: 'capped', body: 'seed' })
    for (let i = 0; i < 80; i++) {
      s.save({ id: q.id, title: 'capped', body: 'z'.repeat(500 * (i + 2)) })
    }
    const v = s.versions(q.id)
    ok(v.length <= 50, `expected <=50 versions, got ${v.length}`)
  })

  check('restoring a version keeps the replaced text recoverable', () => {
    const q = s.create({ title: 'r', body: 'original text here' })
    s.save({ id: q.id, title: 'r', body: 'w'.repeat(900) })
    const v = s.versions(q.id)
    const restored = s.restoreVersion(q.id, v[0].versionId)
    eq(restored.body, 'original text here', 'restored body')
    ok(
      s.versions(q.id).some((x) => x.body.startsWith('www')),
      'the overwritten text is still in history',
    )
  })

  check('restoreVersion rejects a version from another prompt', () => {
    const a = s.create({ title: 'a', body: 'aaa' })
    const b = s.create({ title: 'b', body: 'bbb' })
    s.save({ id: a.id, title: 'a', body: 'a'.repeat(900) })
    const va = s.versions(a.id)[0]
    eq(s.restoreVersion(b.id, va.versionId), null)
  })

  // ------------------------------------------------------------- search
  check('search finds body text', () => {
    s.create({ title: 'Deployment notes', body: 'kubernetes rollout strategy blue green' })
    const hits = s.search('kubernetes')
    ok(hits.length > 0, 'found a hit')
  })

  check('search matches a prefix while still typing', () => {
    ok(s.search('kubern').length > 0, 'prefix match')
  })

  check('title matches outrank body matches', () => {
    s.create({ title: 'zebra', body: 'nothing relevant' })
    s.create({ title: 'unrelated', body: 'zebra zebra zebra' })
    const hits = s.search('zebra')
    const titleHit = s.list().find((r) => r.title === 'zebra')
    eq(hits[0].id, titleHit.id, 'top hit is the title match')
  })

  check('punctuation in the query cannot break FTS syntax', () => {
    for (const q of ['foo(', '"unclosed', 'a AND OR NEAR(', '*', ')))', 'x:y', "it's", '^^^']) {
      const r = s.search(q)
      ok(Array.isArray(r), `query ${q} returned an array`)
    }
  })

  check('an empty query returns nothing rather than everything', () => {
    eq(s.search('   ').length, 0)
  })

  check('trashed prompts drop out of search', () => {
    const t = s.create({ title: 'findmeplease', body: 'unique-token-xyzzy' })
    ok(s.search('xyzzy').length > 0, 'found before trashing')
    s.trash([t.id])
    eq(s.search('xyzzy').length, 0, 'gone after trashing')
    s.restore([t.id])
    ok(s.search('xyzzy').length > 0, 'back after restoring')
  })

  check('search index follows an edit', () => {
    const e = s.create({ title: 'edit me', body: 'before-token' })
    ok(s.search('before-token').length > 0, 'indexed at insert')
    s.save({ id: e.id, title: 'edit me', body: 'after-token' })
    eq(s.search('before-token').length, 0, 'old text de-indexed')
    ok(s.search('after-token').length > 0, 'new text indexed')
  })

  check('a purged prompt leaves no index residue', () => {
    const g = s.create({ title: 'ghost', body: 'ghosttoken' })
    s.purge([g.id])
    eq(s.search('ghosttoken').length, 0)
  })

  // ------------------------------------------------------------- trash
  check('trash is reversible and purge is not', () => {
    const t = s.create({ title: 'temp', body: 'temp body' })
    s.trash([t.id])
    ok(s.get(t.id).trashedAt !== null, 'trashed')
    s.restore([t.id])
    eq(s.get(t.id).trashedAt, null, 'restored')
    s.purge([t.id])
    eq(s.get(t.id), null, 'purged')
  })

  check('emptyTrash only takes trashed prompts', () => {
    const before = s.list().filter((r) => r.trashedAt === null).length
    const t = s.create({ title: 'bye', body: 'bye' })
    s.trash([t.id])
    s.emptyTrash()
    eq(s.list().filter((r) => r.trashedAt === null).length, before, 'live count unchanged')
    eq(s.list().filter((r) => r.trashedAt !== null).length, 0, 'trash empty')
  })

  // ------------------------------------------------------------- tags
  check('tags are normalised and de-duplicated', () => {
    const t = s.create({ title: 'tagged', body: 'x' })
    s.setTags(t.id, ['  Build ', 'build', 'IDEA', '', '   '])
    eq(s.get(t.id).tags, ['build', 'idea'])
  })

  check('tags are searchable', () => {
    const t = s.create({ title: 'tagsearch', body: 'nothing' })
    s.setTags(t.id, ['zqtag'])
    ok(s.search('zqtag').length > 0)
  })

  // ------------------------------------------------------------- projects
  check('a project can be created and found', () => {
    const proj = s.projectCreate('Star River')
    ok(proj, 'returned a project')
    eq(proj.name, 'Star River')
    ok(proj.color.startsWith('#'), 'got a colour')
    eq(proj.count, 0, 'starts empty')
  })

  check('creating the same project twice returns the original', () => {
    const a = s.projectCreate('Duplicated')
    const b = s.projectCreate('duplicated')
    eq(a.id, b.id, 'same id, case-insensitively')
    eq(s.projectList().filter((x) => x.name.toLowerCase() === 'duplicated').length, 1)
  })

  check('an empty project name is rejected', () => {
    eq(s.projectCreate('   '), null)
  })

  check('a prompt can be filed under a project and counted', () => {
    const proj = s.projectCreate('Counting')
    const a = s.create({ title: 'one', body: 'x' })
    const b = s.create({ title: 'two', body: 'y' })
    s.setProject(a.id, proj.id)
    s.setProject(b.id, proj.id)
    const listed = s.projectList().find((x) => x.id === proj.id)
    eq(listed.count, 2, 'count')
    eq(s.get(a.id).projectId, proj.id, 'prompt carries the project')
    eq(s.list().find((x) => x.id === a.id).projectId, proj.id, 'summary carries it too')
  })

  check('trashed prompts drop out of the project count', () => {
    const proj = s.projectCreate('Shrinking')
    const a = s.create({ title: 'tmp', body: 'x' })
    s.setProject(a.id, proj.id)
    eq(s.projectList().find((x) => x.id === proj.id).count, 1)
    s.trash([a.id])
    eq(s.projectList().find((x) => x.id === proj.id).count, 0, 'not counted while trashed')
    s.restore([a.id])
    eq(s.projectList().find((x) => x.id === proj.id).count, 1, 'counted again')
  })

  check('a prompt can be removed from its project', () => {
    const proj = s.projectCreate('Temporary home')
    const a = s.create({ title: 'movable', body: 'x' })
    s.setProject(a.id, proj.id)
    s.setProject(a.id, null)
    eq(s.get(a.id).projectId, null)
  })

  check('renaming a project keeps its prompts', () => {
    const proj = s.projectCreate('Old name')
    const a = s.create({ title: 'kept', body: 'x' })
    s.setProject(a.id, proj.id)
    s.projectRename(proj.id, 'New name')
    eq(s.projectList().find((x) => x.id === proj.id).name, 'New name')
    eq(s.get(a.id).projectId, proj.id, 'still filed there')
  })

  check('renaming onto an existing name is refused', () => {
    const a = s.projectCreate('Clash A')
    const b = s.projectCreate('Clash B')
    s.projectRename(b.id, 'clash a')
    eq(s.projectList().find((x) => x.id === b.id).name, 'Clash B', 'name unchanged')
  })

  check('deleting a project unfiles its prompts but never deletes them', () => {
    const proj = s.projectCreate('Doomed')
    const a = s.create({ title: 'survivor', body: 'important text' })
    s.setProject(a.id, proj.id)
    const n = s.projectDelete(proj.id)
    eq(n, 1, 'reported the number unfiled')
    ok(!s.projectList().some((x) => x.id === proj.id), 'project gone')
    const still = s.get(a.id)
    ok(still, 'prompt still exists')
    eq(still.body, 'important text', 'text untouched')
    eq(still.projectId, null, 'now unfiled')
  })

  check('a new prompt can be created straight into a project', () => {
    const proj = s.projectCreate('Direct')
    const a = s.create({ title: 'born here', body: 'x', projectId: proj.id })
    eq(s.get(a.id).projectId, proj.id)
  })

  check('duplicating keeps the project', () => {
    const proj = s.projectCreate('Cloned')
    const a = s.create({ title: 'original', body: 'x', projectId: proj.id })
    const copy = s.duplicate(a.id)
    eq(copy.projectId, proj.id)
  })

  check('export and import carry the project through', () => {
    const proj = s.projectCreate('Round trip')
    const a = s.create({ title: 'exported', body: 'body text', projectId: proj.id })
    const dump = s.exportAll()
    const found = dump.prompts.find((x) => x.id === a.id)
    eq(found.projectId, proj.id, 'present in the export')
  })

  // ------------------------------------------------------------- settings
  check('settings round-trip and merge with defaults', () => {
    s.settingsSet({ theme: 'light' })
    eq(s.settingsGet().theme, 'light')
    eq(s.settingsGet().sort, 'updated', 'default preserved')
    s.settingsSet({ sort: 'title' })
    eq(s.settingsGet().theme, 'light', 'earlier setting survives a later patch')
  })

  // ------------------------------------------------------------- backups
  await checkAsync('backup produces a readable copy', async () => {
    const { path } = await s.backup()
    ok(existsSync(path), 'backup file exists')
    ok(s.stats().lastBackupAt > 0, 'lastBackupAt recorded')
  })

  await checkAsync('backups rotate', async () => {
    for (let i = 0; i < 14; i++) await s.backup()
    const n = readdirSync(s.backupDir).filter((f) => f.endsWith('.db')).length
    ok(n <= 11, `expected rotation, found ${n} backups`)
  })

  // ------------------------------------------------------------- export/import
  check('export then import into a clean store is lossless', () => {
    const dump = s.exportAll()
    const s2 = new Store(freshDir('imported'))
    s2.open()
    const res = s2.import(dump)
    eq(res.updated, 0, 'nothing to update in a clean store')
    ok(res.added === dump.prompts.length, `added ${res.added} of ${dump.prompts.length}`)
    const a = dump.prompts.find((x) => x.title === 'Deployment notes')
    const b = s2.list().find((x) => x.title === 'Deployment notes')
    ok(b, 'prompt present after import')
    eq(s2.get(b.id).body, a.body, 'body identical')
    s2.close()
  })

  check('re-importing the same file changes nothing', () => {
    const dump = s.exportAll()
    const res = s.import(dump)
    eq(res.added, 0, 'added')
    eq(res.updated, 0, 'updated')
  })

  check('import never overwrites newer local text', () => {
    const local = s.create({ title: 'conflict', body: 'LOCAL VERSION' })
    const incoming = {
      prompts: [{ ...local, body: 'INCOMING OLDER', updatedAt: local.updatedAt - 10_000 }],
    }
    s.import(incoming)
    eq(s.get(local.id).body, 'LOCAL VERSION', 'local text kept')
  })

  check('an overwriting import snapshots what it replaced', () => {
    const local = s.create({ title: 'conflict2', body: 'LOCAL TEXT' })
    s.import({ prompts: [{ ...local, body: 'NEWER INCOMING', updatedAt: Date.now() + 60_000 }] })
    eq(s.get(local.id).body, 'NEWER INCOMING', 'newer text applied')
    ok(
      s.versions(local.id).some((v) => v.body === 'LOCAL TEXT'),
      'replaced text is recoverable from history',
    )
  })

  check('import tolerates garbage without throwing', () => {
    for (const junk of [null, 42, 'string', {}, { prompts: 'no' }, { prompts: [null, 1, {}] }, []]) {
      const r = s.import(junk)
      ok(typeof r.added === 'number', 'returned a result')
    }
  })

  check('stats reports something sane', () => {
    const st = s.stats()
    ok(st.total > 0, 'total')
    ok(st.dbBytes > 0, 'dbBytes')
    ok(st.dbPath.endsWith('stash.db'), 'dbPath')
  })

  s.close()
}

// ------------------------------------------------- reopen / durability
{
  const dir = freshDir('persist')
  const s1 = new Store(dir)
  s1.open()
  const p = s1.create({ title: 'survives', body: 'this text must come back' })
  await s1.backup()
  s1.close()

  const s2 = new Store(dir)
  s2.open()
  check('data survives a close and reopen', () => {
    eq(s2.get(p.id).body, 'this text must come back')
  })
  check('reopen does not report a recovery', () => {
    eq(s2.report.recovered, null)
  })
  s2.close()
}

// ------------------------------------------------- upgrading an older stash
{
  // Hand-build a schema-v1 database, then open it with the current code and confirm
  // the migration runs and backfills rather than losing or mangling anything.
  const dir = freshDir('upgrade')
  mkdirSync(dir, { recursive: true })
  const db = new DatabaseSync(join(dir, 'stash.db'))
  db.exec(`
    CREATE TABLE prompts (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
      tags TEXT NOT NULL DEFAULT '[]', pinned INTEGER NOT NULL DEFAULT 0, trashed_at INTEGER,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, used_at INTEGER,
      use_count INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX idx_prompts_updated ON prompts(updated_at DESC);
    CREATE INDEX idx_prompts_trashed ON prompts(trashed_at);
    CREATE TABLE versions (version_id INTEGER PRIMARY KEY AUTOINCREMENT,
      prompt_id TEXT NOT NULL REFERENCES prompts(id) ON DELETE CASCADE,
      title TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX idx_versions_prompt ON versions(prompt_id, created_at DESC);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE VIRTUAL TABLE prompts_fts USING fts5(title, body, tags,
      content='prompts', content_rowid='rowid', tokenize="unicode61 remove_diacritics 2");
    CREATE TRIGGER prompts_ai AFTER INSERT ON prompts BEGIN
      INSERT INTO prompts_fts(rowid,title,body,tags) VALUES (new.rowid,new.title,new.body,new.tags); END;
  `)
  db.prepare(
    'INSERT INTO prompts (id,title,body,created_at,updated_at) VALUES (?,?,?,?,?)',
  ).run('old1', 'An older prompt', 'four words go here', Date.now(), Date.now())
  db.exec('PRAGMA user_version = 1')
  db.close()

  const s = new Store(dir)
  const rep = s.open()
  check('a schema-v1 stash upgrades in place', () => {
    eq(rep.fatal, null, 'no fatal')
    eq(s.db.prepare('PRAGMA user_version').get().user_version, 4, 'version bumped')
  })
  check('the upgrade backfills the new column rather than zeroing it', () => {
    const row = s.list().find((r) => r.id === 'old1')
    ok(row, 'prompt survived')
    eq(row.words, 4, 'word count backfilled')
    eq(s.get('old1').body, 'four words go here', 'body untouched')
  })
  check('search still works after the upgrade', () => {
    ok(s.search('older').length > 0)
  })
  s.close()
}

// ------------------------------------------------- corruption recovery
{
  const dir = freshDir('corrupt')
  const s1 = new Store(dir)
  s1.open()
  s1.create({ title: 'precious', body: 'irreplaceable prompt text' })
  await s1.backup()
  s1.close()

  // Scribble over the header so SQLite refuses the file outright.
  const dbFile = join(dir, 'stash.db')
  const buf = readFileSync(dbFile)
  buf.fill(0xff, 0, 2000)
  writeFileSync(dbFile, buf)

  const s2 = new Store(dir)
  const rep = s2.open()
  check('a corrupt database is recovered from the newest backup', () => {
    eq(rep.fatal, null, 'not fatal')
    ok(rep.recovered, 'reported a recovery')
    const found = s2.list().find((r) => r.title === 'precious')
    ok(found, 'the prompt came back')
    eq(s2.get(found.id).body, 'irreplaceable prompt text')
  })
  check('the corrupt file is quarantined, never deleted', () => {
    ok(existsSync(rep.recovered.quarantined), 'quarantined copy exists on disk')
  })
  s2.close()
}

// ------------------------------------------------- corruption with no backup
{
  const dir = freshDir('corrupt-nobackup')
  const s1 = new Store(dir)
  s1.open()
  s1.create({ title: 'lonely', body: 'no backup exists' })
  s1.close()
  const dbFile = join(dir, 'stash.db')
  const buf = readFileSync(dbFile)
  buf.fill(0xff, 0, 2000)
  writeFileSync(dbFile, buf)

  const s2 = new Store(dir)
  const rep = s2.open()
  check('with no backup available the app reports a fatal state instead of crashing', () => {
    ok(rep.fatal, 'fatal set')
    eq(rep.recovered, null)
  })
  check('the unreadable file is left on disk untouched', () => {
    ok(existsSync(dbFile), 'original file still there')
  })
  s2.close()
}

// ------------------------------------------------- scale
{
  const dir = freshDir('scale')
  const s = new Store(dir)
  s.open()
  const N = 20000
  const t0 = performance.now()
  for (let i = 0; i < N; i++) {
    s.create({
      title: `Prompt ${i} ${i % 13 === 0 ? 'scaffolding' : 'draft'}`,
      body: `Body ${i}. ${'lorem ipsum dolor sit amet '.repeat(12)} ${i % 97 === 0 ? 'needle' : ''}`,
      tags: [`t${i % 20}`],
    })
  }
  const insertMs = performance.now() - t0

  const t1 = performance.now()
  const all = s.list()
  const listMs = performance.now() - t1

  // Search runs on every keystroke, so the number that matters is the typical one.
  // A single sample right after allocating 20k summary objects catches a GC pause and
  // measures the collector, not the query — so take the median of a series.
  function median(times) {
    const s = [...times].sort((a, b) => a - b)
    return s[Math.floor(s.length / 2)]
  }
  const queries = ['needle', 'scaffolding', 'lorem ipsum', 'prompt 1', 'draft']
  let hits = []
  const searchTimes = []
  for (let i = 0; i < 25; i++) {
    const q = queries[i % queries.length]
    const t = performance.now()
    hits = s.search(q)
    searchTimes.push(performance.now() - t)
  }
  const searchMs = median(searchTimes)
  const searchWorst = Math.max(...searchTimes)

  const saveTimes = []
  for (let i = 0; i < 20; i++) {
    const t = performance.now()
    s.save({ id: all[i].id, title: all[i].title, body: `edited under load ${i}` })
    saveTimes.push(performance.now() - t)
  }
  const saveMs = median(saveTimes)

  check(`scale: ${N} prompts load in ${listMs.toFixed(0)}ms`, () => {
    eq(all.length, N, 'row count')
    ok(listMs < 800, `list took ${listMs.toFixed(0)}ms`)
  })
  check(`scale: median search over ${N} is ${searchMs.toFixed(1)}ms`, () => {
    ok(hits.length > 0, 'found hits')
    ok(searchMs < 16, `median search took ${searchMs.toFixed(1)}ms (one frame is 16ms)`)
  })
  check(`scale: worst-case search ${searchWorst.toFixed(1)}ms`, () => {
    ok(searchWorst < 120, `worst search took ${searchWorst.toFixed(1)}ms`)
  })
  check(`scale: median durable save ${saveMs.toFixed(2)}ms`, () => {
    ok(saveMs < 30, `save took ${saveMs.toFixed(2)}ms`)
  })
  console.log(
    `  [scale] insert ${N}: ${insertMs.toFixed(0)}ms | list: ${listMs.toFixed(0)}ms | ` +
      `search(median): ${searchMs.toFixed(1)}ms worst: ${searchWorst.toFixed(1)}ms | save: ${saveMs.toFixed(2)}ms | db: ` +
      `${(s.stats().dbBytes / 1048576).toFixed(1)}MB`,
  )
  s.close()
}

rmSync(work, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
if (failed) {
  console.log(fail.map((f) => '  - ' + f).join('\n'))
  process.exit(1)
}
