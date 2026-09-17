// End-to-end durability: drive the real app, kill it the way a crash would, and see
// what actually survived on disk. Asserting crash-safety without testing it is how
// apps lose people's writing.
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'node_modules/electron/dist/electron.exe')

let passed = 0
let failed = 0
function check(name, cond, detail = '') {
  if (cond) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Boots the app against an isolated data directory, runs `js` in the renderer, and
 * leaves it running. Resolves once the signal file proves `js` finished.
 */
async function launch(dataDir, js) {
  const signal = join(dataDir, 'ready.png')
  if (existsSync(signal)) unlinkSync(signal)
  const env = {
    ...process.env,
    PROMPT_STASH_DEV: '1',
    PROMPT_STASH_SHOT: signal,
    PROMPT_STASH_SHOT_JS: js,
    PROMPT_STASH_SHOT_QUIT: '0',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(ELECTRON, [join(ROOT, 'dist/main/main.js'), `--user-data-dir=${dataDir}`], {
    stdio: 'ignore',
    env,
  })
  for (let i = 0; i < 300; i++) {
    if (existsSync(signal)) return child
    if (child.exitCode !== null) throw new Error(`app exited early: ${child.exitCode}`)
    await sleep(100)
  }
  throw new Error('app never signalled ready')
}

function hardKill(child) {
  // /T takes the renderer and GPU children too: an abrupt, no-cleanup death, which is
  // what a real crash or a Task Manager "End task" looks like.
  try {
    execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' })
  } catch {
    /* already gone */
  }
}

function open(dataDir, readOnly = true) {
  return new DatabaseSync(join(dataDir, 'stash.db'), { readOnly })
}
function readPrompts(dataDir) {
  const db = open(dataDir)
  const rows = db.prepare('SELECT id, title, body, updated_at FROM prompts').all()
  db.close()
  return rows
}
function readDrafts(dataDir) {
  const db = open(dataDir)
  const rows = db.prepare('SELECT prompt_id, title, body, at FROM drafts').all()
  db.close()
  return rows
}

const typeJs = (text, waitMs) => `(async () => {
  const body = document.getElementById('body');
  const title = document.getElementById('title');
  title.value = 'crash test';
  title.dispatchEvent(new Event('input'));
  body.value = ${JSON.stringify(text)};
  body.dispatchEvent(new Event('input'));
  await new Promise(r => setTimeout(r, ${waitMs}));
  return 'done';
})()`

// --------------------------------------------- 1: killed after the autosave tick
{
  const dir = mkdtempSync(join(tmpdir(), 'stash-dur-a-'))
  console.log('\nkilled 1.5s after typing (past the 300ms autosave):')
  const child = await launch(dir, typeJs('SURVIVES-THE-AUTOSAVE', 1500))
  hardKill(child)
  await sleep(600)
  const rows = readPrompts(dir)
  check(
    'the typed text is in the database',
    rows.some((r) => r.body === 'SURVIVES-THE-AUTOSAVE'),
    JSON.stringify(rows.map((r) => r.body.slice(0, 40))),
  )
  check(
    'the title saved too',
    rows.some((r) => r.title === 'crash test'),
  )
  rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------- 2: the draft mirror is genuinely on disk
{
  // Read the database from a second process while the app is still running and the
  // text is still inside the autosave window. WAL allows the concurrent reader, so
  // this proves the mirror reached disk rather than sitting in memory — which is
  // exactly what the old localStorage version failed to do.
  const dir = mkdtempSync(join(tmpdir(), 'stash-dur-b-'))
  console.log('\nstill typing, read from another process:')
  // Keep typing in the background. Continuous keystrokes keep resetting the 300ms
  // autosave debounce, so the real save has not run yet — but the 120ms mirror has.
  // That is the window this test needs to observe.
  const keepTyping = `(() => {
    const body = document.getElementById('body');
    body.value = 'IN-FLIGHT';
    body.dispatchEvent(new Event('input'));
    let n = 0;
    const t = setInterval(() => {
      body.value = 'IN-FLIGHT-' + (++n);
      body.dispatchEvent(new Event('input'));
      if (n > 40) clearInterval(t);
    }, 100);
    return 'typing';
  })()`
  const child = await launch(dir, keepTyping)
  const drafts = readDrafts(dir)
  const prompts = readPrompts(dir)
  check(
    'the in-progress text is on disk in the drafts table',
    drafts.some((d) => d.body.startsWith('IN-FLIGHT')),
    JSON.stringify(drafts.map((d) => d.body.slice(0, 40))),
  )
  check(
    'and the autosave has not written it to the prompt yet',
    !prompts.some((r) => r.body.startsWith('IN-FLIGHT')),
    'the mirror is only meaningful if it leads the real save',
  )
  hardKill(child)
  await sleep(500)

  const child2 = await launch(dir, `'idle'`)
  await sleep(500)
  hardKill(child2)
  await sleep(600)
  check(
    'after the crash, relaunching restores what was being typed',
    readPrompts(dir).some((r) => r.body.startsWith('IN-FLIGHT')),
    JSON.stringify(readPrompts(dir).map((r) => r.body.slice(0, 40))),
  )
  rmSync(dir, { recursive: true, force: true })
}

// ------------------------------------------------- 3: a clean close flushes first
{
  const dir = mkdtempSync(join(tmpdir(), 'stash-dur-c-'))
  console.log('\nwindow closed normally immediately after typing:')
  const child = await launch(dir, typeJs('CLOSED-WHILE-DIRTY', 30))
  try {
    execSync(`taskkill /PID ${child.pid}`, { stdio: 'ignore' }) // WM_CLOSE, not /F
  } catch {
    /* ignore */
  }
  await sleep(2500)
  hardKill(child)
  await sleep(400)
  const rows = readPrompts(dir)
  check(
    'closing flushed the pending edit',
    rows.some((r) => r.body === 'CLOSED-WHILE-DIRTY'),
    JSON.stringify(rows.map((r) => r.body.slice(0, 40))),
  )
  rmSync(dir, { recursive: true, force: true })
}

// --------------------------------- 4: recovery on the next launch, deterministic
{
  const dir = mkdtempSync(join(tmpdir(), 'stash-dur-d-'))
  console.log('\nunsaved draft left behind by a crash:')
  const child = await launch(dir, typeJs('THE-SAVED-TEXT', 1200))
  hardKill(child)
  await sleep(600)

  // Plant exactly the state a crash mid-keystroke leaves: a draft newer than the
  // prompt. Done directly so the test never races the autosave.
  const id = readPrompts(dir)[0].id
  const db = open(dir, false)
  db.exec('PRAGMA journal_mode = WAL')
  db.prepare('INSERT INTO drafts (prompt_id,title,body,at) VALUES (?,?,?,?)').run(
    id,
    'crash test',
    'UNSAVED-WHEN-IT-DIED ' + 'x'.repeat(600),
    Date.now() + 60_000,
  )
  db.close()

  const child2 = await launch(dir, `'idle'`)
  await sleep(500)
  hardKill(child2)
  await sleep(600)
  const after = readPrompts(dir)
  check(
    'the unsaved text is carried in on the next launch',
    after.some((r) => r.body.startsWith('UNSAVED-WHEN-IT-DIED')),
    JSON.stringify(after.map((r) => r.body.slice(0, 40))),
  )
  check('the draft row is cleared once recovered', readDrafts(dir).length === 0)

  const db2 = open(dir)
  const versions = db2.prepare('SELECT body FROM versions WHERE prompt_id = ?').all(id)
  db2.close()
  check(
    'the text it replaced went into history first',
    versions.some((v) => v.body === 'THE-SAVED-TEXT'),
    JSON.stringify(versions.map((v) => v.body.slice(0, 30))),
  )
  rmSync(dir, { recursive: true, force: true })
}

// --------------------------- 5: a stale draft must never revert a newer save
{
  const dir = mkdtempSync(join(tmpdir(), 'stash-dur-e-'))
  console.log('\nstale draft left over from an older session:')
  const child = await launch(dir, typeJs('THE-GOOD-CURRENT-TEXT', 1200))
  hardKill(child)
  await sleep(600)

  const row = readPrompts(dir)[0]
  const db = open(dir, false)
  db.exec('PRAGMA journal_mode = WAL')
  db.prepare('INSERT INTO drafts (prompt_id,title,body,at) VALUES (?,?,?,?)').run(
    row.id,
    'old',
    'STALE-AND-OLDER',
    row.updated_at - 600_000,
  )
  db.close()

  const child2 = await launch(dir, `'idle'`)
  await sleep(500)
  hardKill(child2)
  await sleep(600)
  const after = readPrompts(dir)
  check(
    'the stale draft is discarded, not applied',
    after.some((r) => r.body === 'THE-GOOD-CURRENT-TEXT') &&
      !after.some((r) => r.body === 'STALE-AND-OLDER'),
    JSON.stringify(after.map((r) => r.body.slice(0, 40))),
  )
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
