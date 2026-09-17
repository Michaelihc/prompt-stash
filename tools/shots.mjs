// Captures UI states to shots/ using Electron's own page capture.
// Seeds a dedicated, reproducible profile first so the screenshots show the app
// doing real work rather than an empty stash.
// Usage: node tools/shots.mjs [name ...]
import { spawn } from 'node:child_process'
import * as esbuild from 'esbuild'
import { mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'shots')
const PROFILE = join(ROOT, '.shots-profile')
mkdirSync(OUT, { recursive: true })

// ------------------------------------------------------------------ seeding

rmSync(PROFILE, { recursive: true, force: true })
mkdirSync(PROFILE, { recursive: true })

const bundle = join(PROFILE, 'store.cjs')
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
const { Store } = createRequire(import.meta.url)(bundle)

const store = new Store(PROFILE)
store.open()

const stash = store.projectCreate('Prompt Stash')
const river = store.projectCreate('Star River')
const scratch = store.projectCreate('Scratch')

const SEED = [
  {
    project: river.id,
    title: 'Landing page copy',
    tags: ['copy', 'web'],
    body: `Write hero copy for {{product}}. Plain and confident, no superlatives, no
exclamation marks. Two sentences at most, then one line of supporting detail.

----------

Same brief, but for the pricing page. Lead with what it costs, not with the value
story. Keep it under {{words}} words.

----------

Now rewrite the strongest of the two as a single sentence I could put in a tweet.`,
  },
  {
    project: river.id,
    title: 'Onboarding email sequence',
    tags: ['copy', 'email'],
    body: `Draft a {{count}}-email onboarding sequence for someone who just signed up for
{{product}} but has not finished setup yet. One job per email. No "just checking in".`,
  },
  {
    project: stash.id,
    title: 'Release notes from a diff',
    tags: ['dev'],
    body: `Read the diff below and write release notes for people who use the app, not for
people who wrote it. Group by what changed for them. Skip refactors entirely.

----------

{{diff}}`,
  },
  {
    project: stash.id,
    title: 'Refactor with constraints',
    tags: ['dev', 'refactor'],
    body: `Refactor {{file}} so that {{goal}}. Keep the public API unchanged, keep the tests
passing, and do not reformat lines you did not otherwise touch. Explain any change
that is not obviously behaviour-preserving.`,
  },
  {
    project: stash.id,
    title: 'Bug report triage',
    tags: ['dev'],
    body: `Here is a bug report. Tell me: the smallest reproduction you can infer, which
component most likely owns it, and what single piece of information would most
reduce your uncertainty.

{{report}}`,
  },
  {
    project: scratch.id,
    title: 'Ideas worth a second look',
    tags: ['ideas'],
    body: `A running list. Nothing here is committed to.

- A prompt stash that is actually fast
- Offline-first everything
- The "explain this diff to me like I wrote it six months ago" tool`,
  },
  {
    project: null,
    title: 'Interview questions that are not riddles',
    tags: ['hiring'],
    body: `Give me {{n}} questions for a {{role}} interview that a good candidate can answer
from experience and a bad one cannot fake. No brainteasers, no trivia.`,
  },
  {
    project: null,
    title: 'Weekly review',
    tags: ['personal'],
    body: `What did I actually ship this week, what did I start and abandon, and what am I
avoiding? Be blunt about the third one.`,
  },
]

for (const s of SEED) {
  const p = store.create({ title: s.title, body: s.body, tags: s.tags, projectId: s.project })
  if (s.tags) store.setTags(p.id, s.tags)
}
// One pinned, one recently used, so those states are visible in the index.
const all = store.list()
const pinned = all.find((p) => p.title === 'Refactor with constraints')
if (pinned) store.setPinned(pinned.id, true)
const used = all.find((p) => p.title === 'Landing page copy')
if (used) {
  store.markUsed(used.id)
  store.settingsSet({ lastPromptId: used.id })
}
store.close()
console.log(`seeded ${SEED.length} prompts across 3 projects`)

// ----------------------------------------------------------------- capture

const SHOTS = {
  main: '',

  sections: `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const b = document.getElementById('body');
    b.focus();
    b.setSelectionRange(230, 230);
    b.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true, cancelable: true }));
    await wait(200);
    return 1;
  })()`,

  projects: `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    document.getElementById('project-scope').click();
    await wait(350);
    return 1;
  })()`,

  search: `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    const s = document.getElementById('search');
    s.focus();
    s.value = 'release';
    s.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(400);
    return 1;
  })()`,

  palette: `window.dispatchEvent(new KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));`,

  variables: `document.getElementById('copy-button').click();`,

  settings: `window.dispatchEvent(new KeyboardEvent('keydown',{key:',',ctrlKey:true,bubbles:true}));`,

  light: `(async () => {
    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    document.documentElement.dataset.theme = 'light';
    await wait(200);
    return 1;
  })()`,
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(SHOTS)

for (const name of wanted) {
  const js = SHOTS[name]
  if (js === undefined) {
    console.log(`skip unknown shot: ${name}`)
    continue
  }
  const env = {
    ...process.env,
    PROMPT_STASH_DEV: '1',
    PROMPT_STASH_SHOT: join(OUT, `${name}.png`),
    PROMPT_STASH_SHOT_JS: js,
    PROMPT_STASH_SHOT_QUIT: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  await new Promise((done) => {
    const child = spawn(
      join(ROOT, 'node_modules/electron/dist/electron.exe'),
      [join(ROOT, 'dist/main/main.js'), `--user-data-dir=${PROFILE}`],
      { stdio: 'inherit', env },
    )
    child.on('exit', done)
  })
}
console.log('shots written to', OUT)
