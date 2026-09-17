// Drives the real renderer and asserts what the user would see. Covers the flows that
// a screenshot cannot: keyboard bindings, search filtering, the copy path, trash+undo.
import { spawn, execSync } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ELECTRON = join(ROOT, 'node_modules/electron/dist/electron.exe')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** Runs one script inside a fresh app instance and returns whatever it resolved to. */
async function run(script) {
  const dir = mkdtempSync(join(tmpdir(), 'stash-ui-'))
  const signal = join(dir, 'ready.png')
  const resultFile = join(dir, 'result.json')
  const env = {
    ...process.env,
    PROMPT_STASH_DEV: '1',
    PROMPT_STASH_SHOT: signal,
    PROMPT_STASH_SHOT_JS: script,
    PROMPT_STASH_SHOT_RESULT: resultFile,
    PROMPT_STASH_SHOT_QUIT: '1',
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(ELECTRON, [join(ROOT, 'dist/main/main.js'), `--user-data-dir=${dir}`], {
    stdio: 'ignore',
    env,
  })
  try {
    for (let i = 0; i < 600; i++) {
      if (existsSync(resultFile)) break
      if (child.exitCode !== null && !existsSync(resultFile)) throw new Error('app exited early')
      await sleep(100)
    }
    if (!existsSync(resultFile)) throw new Error('script never produced a result')
    return JSON.parse(readFileSync(resultFile, 'utf8'))
  } finally {
    try {
      execSync(`taskkill /F /T /PID ${child.pid}`, { stdio: 'ignore' })
    } catch {
      /* already gone */
    }
    await sleep(300)
    try {
      if (existsSync(signal)) unlinkSync(signal)
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* the OS may still hold a handle briefly */
    }
  }
}

// Helpers injected into every script.
const PRELUDE = `
  const $ = (id) => document.getElementById(id);
  const rows = () => [...document.querySelectorAll('.row')].map(r => r.querySelector('.row-title').textContent);
  const key = (k, opts = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...opts }));
  const keyOn = (elm, k, opts = {}) => elm.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...opts }));
  const type = (elm, v) => { elm.value = v; elm.dispatchEvent(new Event('input', { bubbles: true })); };
  const wait = (ms) => new Promise(r => setTimeout(r, ms));
  const settle = () => wait(420);
`

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

// ------------------------------------------------------------- first run
{
  console.log('\nfirst run:')
  const r = await run(`(async () => { ${PRELUDE}
    await settle();
    return {
      rowCount: rows().length,
      firstRow: rows()[0],
      editorVisible: !$('editor-pane').hidden,
      blankHidden: $('editor-blank').hidden,
      title: $('title').value,
      variablesInFooter: $('metrics').textContent.includes('2 variables'),
      highlightPills: document.querySelectorAll('mark.var').length,
    };
  })()`)
  check('a welcome prompt is created', r.rowCount === 1, JSON.stringify(r))
  check('it opens automatically', r.editorVisible && r.blankHidden)
  check('the title is shown', r.title === 'How this works', r.title)
  check('placeholders are counted in the footer', r.variablesInFooter)
  check('placeholders are highlighted in the body', r.highlightPills === 2, String(r.highlightPills))
}

// --------------------------------------------------------- create and type
{
  console.log('\nCtrl+N then typing:')
  const r = await run(`(async () => { ${PRELUDE}
    await settle();
    key('n', { ctrlKey: true });
    await wait(600);
    type($('title'), 'Scaffold a CLI');
    type($('body'), 'Build a {{language}} CLI that does {{thing}}.');
    await wait(900);
    const saved = $('save-state').dataset.state;
    const list = rows();
    return {
      rowCount: list.length,
      titles: list,
      saveState: saved,
      pills: document.querySelectorAll('mark.var').length,
      metrics: $('metrics').textContent,
    };
  })()`)
  check('a second prompt appears in the list', r.rowCount === 2, JSON.stringify(r.titles))
  check('the new title shows in the list', r.titles.includes('Scaffold a CLI'), JSON.stringify(r.titles))
  check('it autosaves without being asked', r.saveState === 'saved', r.saveState)
  check('both placeholders are highlighted', r.pills === 2, String(r.pills))
  check('the footer counts them', r.metrics.includes('2 variables'), r.metrics)
}

// ------------------------------------------------------------- search
{
  console.log('\nsearch:')
  const r = await run(`(async () => { ${PRELUDE}
    await settle();
    key('n', { ctrlKey: true });
    await wait(500);
    type($('title'), 'Kubernetes rollout');
    type($('body'), 'blue green deployment strategy');
    await wait(700);
    type($('search'), 'kuber');
    await wait(500);
    const byTitle = rows();
    type($('search'), 'green deployment');
    await wait(500);
    const byBody = rows();
    type($('search'), 'zzzznothing');
    await wait(400);
    const none = rows();
    const emptyShown = !$('list-empty').hidden;
    type($('search'), '');
    await wait(300);
    return { byTitle, byBody, none: none.length, emptyShown, restored: rows().length };
  })()`)
  check('a title match filters the list', r.byTitle.length === 1 && r.byTitle[0] === 'Kubernetes rollout', JSON.stringify(r.byTitle))
  check('body text is searchable too', r.byBody.includes('Kubernetes rollout'), JSON.stringify(r.byBody))
  check('no matches empties the list', r.none === 0)
  check('and shows the empty state', r.emptyShown)
  check('clearing the search restores everything', r.restored === 2, String(r.restored))
}

// --------------------------------------------------------- copy with values
{
  console.log('\ncopy with placeholder fill-in:')
  const r = await run(`(async () => { ${PRELUDE}
    await settle();
    key('n', { ctrlKey: true });
    await wait(500);
    type($('title'), 'Template');
    type($('body'), 'Refactor {{file}} so that {{goal}}.');
    await wait(700);
    key('C', { ctrlKey: true, shiftKey: true });
    await wait(500);
    const sheetOpen = !$('overlay').hidden;
    const labels = [...document.querySelectorAll('.field-label')].map(l => l.textContent);
    const inputs = [...document.querySelectorAll('.field-input')];
    inputs[0].value = 'src/main.ts';
    inputs[1].value = 'it stops leaking';
    [...document.querySelectorAll('.sheet-foot button')].find(b => b.textContent === 'Copy').click();
    await wait(600);
    const toastText = $('toast').textContent;
    return { sheetOpen, labels, toastText, closed: $('overlay').hidden };
  })()`)
  check('the fill-in sheet opens', r.sheetOpen)
  check('it lists each placeholder by name', JSON.stringify(r.labels) === JSON.stringify(['file', 'goal']), JSON.stringify(r.labels))
  check('copying closes the sheet', r.closed)
  check('and confirms', r.toastText.includes('Copied'), r.toastText)
}

// ------------------------------------------------------------ trash + undo
{
  console.log('\ntrash and undo:')
  const r = await run(`(async () => { ${PRELUDE}
    await settle();
    key('n', { ctrlKey: true });
    await wait(500);
    type($('title'), 'Disposable');
    await wait(700);
    const before = rows().length;
    key('Delete', { ctrlKey: true, shiftKey: true });
    await wait(700);
    const afterTrash = rows();
    const undoButton = $('toast').querySelector('.toast-action');
    const toastText = $('toast').textContent;
    undoButton.click();
    await wait(800);
    return { before, afterTrash, restored: rows(), toastText };
  })()`)
  check('the prompt leaves the list', !r.afterTrash.includes('Disposable'), JSON.stringify(r.afterTrash))
  check('the toast offers Undo', r.toastText.includes('Undo'), r.toastText)
  check('Undo brings it back', r.restored.includes('Disposable'), JSON.stringify(r.restored))
}

// ------------------------------------------------------------- pin and tags
{
  console.log('\npinning and tags:')
  const r = await run(`(async () => { ${PRELUDE}
    await settle();
    key('n', { ctrlKey: true });
    await wait(500);
    type($('title'), 'Pinned one');
    await wait(600);
    key('p', { ctrlKey: true });
    await wait(500);
    const firstRow = rows()[0];
    document.querySelector('[data-action="add"]').click();
    await wait(200);
    const input = document.querySelector('.tag-input');
    input.value = 'Ideas';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(600);
    const tags = [...document.querySelectorAll('.editor-tags .tag')].map(t => t.textContent);
    const chips = [...document.querySelectorAll('.chip')].map(c => c.textContent);
    return { firstRow, tags, chips };
  })()`)
  check('a pinned prompt sorts to the top', r.firstRow === 'Pinned one', r.firstRow)
  check('a tag is added and lower-cased', r.tags.includes('ideas'), JSON.stringify(r.tags))
  check('it appears as a filter chip', r.chips.some((c) => c.startsWith('ideas')), JSON.stringify(r.chips))
}

// ----------------------------------------------------------- command palette
{
  console.log('\ncommand palette:')
  const r = await run(`(async () => { ${PRELUDE}
    await settle();
    key('k', { ctrlKey: true });
    await wait(400);
    const open = !$('overlay').hidden;
    const input = document.querySelector('.sheet-input');
    input.value = 'dupl';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(300);
    const top = document.querySelector('.sheet-item .sheet-item-label').textContent;
    key('Escape');
    await wait(300);
    return { open, top, closedAfterEscape: $('overlay').hidden };
  })()`)
  check('Ctrl+K opens the palette', r.open)
  check('typing filters to the right command', r.top === 'Duplicate this prompt', r.top)
  check('Escape closes it', r.closedAfterEscape)
}

// ------------------------------------------------- Ctrl+Enter section dividers
{
  console.log('\nCtrl+Enter dividers:')
  const r = await run(`(async () => { ${PRELUDE}
    await settle();
    key('n', { ctrlKey: true });
    await wait(500);
    const body = $('body');
    type(body, 'first variant of the prompt');
    body.focus();
    body.setSelectionRange(body.value.length, body.value.length);
    keyOn(body, 'Enter', { ctrlKey: true });
    await wait(200);
    const afterFirst = body.value;
    type(body, body.value + 'second variant of the prompt');
    await wait(900);

    const rules = document.querySelectorAll('mark.rule').length;
    const metrics = $('metrics').textContent;

    // Caret inside the second section.
    body.focus();
    body.setSelectionRange(body.value.length - 3, body.value.length - 3);
    keyOn(body, 'a', { ctrlKey: true });
    await wait(150);
    const firstSelect = body.value.slice(body.selectionStart, body.selectionEnd);

    // Pressing it again widens to everything.
    keyOn(body, 'a', { ctrlKey: true });
    await wait(150);
    const secondSelect = body.value.slice(body.selectionStart, body.selectionEnd);

    // Caret in the first section.
    body.setSelectionRange(2, 2);
    keyOn(body, 'a', { ctrlKey: true });
    await wait(150);
    const topSelect = body.value.slice(body.selectionStart, body.selectionEnd);

    return { afterFirst, value: body.value, rules, metrics, firstSelect, secondSelect, topSelect };
  })()`)
  check('Ctrl+Enter inserts a divider line', r.afterFirst.includes('----------'), JSON.stringify(r.afterFirst))
  check('it leaves the caret on a new line below', r.afterFirst.endsWith('----------\n'), JSON.stringify(r.afterFirst))
  check('the divider is painted as a rule', r.rules === 1, String(r.rules))
  check('the footer counts sections', r.metrics.includes('2 sections'), r.metrics)
  check(
    'Ctrl+A selects only the section the caret is in',
    r.firstSelect === 'second variant of the prompt',
    JSON.stringify(r.firstSelect),
  )
  check(
    'it does not reach past the divider',
    !r.firstSelect.includes('----------') && !r.firstSelect.includes('first variant'),
    JSON.stringify(r.firstSelect),
  )
  check(
    'pressing Ctrl+A again widens to the whole prompt',
    r.secondSelect === r.value,
    JSON.stringify(r.secondSelect.slice(0, 50)),
  )
  check(
    'from the first section it selects that one',
    r.topSelect === 'first variant of the prompt',
    JSON.stringify(r.topSelect),
  )
}

// ------------------------------------------------------------------ projects
{
  console.log('\nprojects:')
  const r = await run(`(async () => { ${PRELUDE}
    await settle();
    // Create a project through the scope picker by typing a name that does not exist.
    $('project-scope').click();
    await wait(300);
    const input = document.querySelector('.sheet-input');
    input.value = 'Star River';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(250);
    const createRow = document.querySelector('.sheet-item .sheet-item-label').textContent;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(900);

    const scopeLabel = $('scope-name').textContent;
    const emptyInScope = $('list-empty').hidden === false;

    // A prompt made while scoped should land in that project.
    key('n', { ctrlKey: true });
    await wait(600);
    type($('title'), 'Landing page copy');
    await wait(800);
    const chip = document.querySelector('.project-chip').textContent;
    const rowMeta = document.querySelector('.row-meta').textContent;
    const dotShown = !document.querySelector('.row-project').hidden;

    // Back to all projects: the welcome prompt reappears.
    $('project-scope').click();
    await wait(300);
    const allRow = [...document.querySelectorAll('.sheet-item-label')].find(n => n.textContent === 'All projects');
    allRow.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await wait(700);
    const allCount = rows().length;
    const scopedBack = $('scope-name').textContent;

    return { createRow, scopeLabel, emptyInScope, chip, rowMeta, dotShown, allCount, scopedBack };
  })()`)
  check('typing a new name offers to create it', r.createRow.startsWith('Create'), r.createRow)
  check('creating a project scopes the list to it', r.scopeLabel === 'Star River', r.scopeLabel)
  check('a brand new project starts empty', r.emptyInScope)
  check('a prompt made while scoped is filed there', r.chip.includes('Star River'), r.chip)
  check('the list row shows the project', r.rowMeta.includes('Star River'), r.rowMeta)
  check('and its colour dot', r.dotShown)
  check('clearing the scope shows everything again', r.allCount === 2, String(r.allCount))
  check('the scope button returns to All projects', r.scopedBack === 'All projects', r.scopedBack)
}

// ------------------------------------------------- moving between projects
{
  console.log('\nmoving a prompt between projects:')
  const r = await run(`(async () => { ${PRELUDE}
    await settle();
    // Two projects, created from the assign picker on the open prompt.
    document.querySelector('.project-chip').click();
    await wait(300);
    let input = document.querySelector('.sheet-input');
    input.value = 'Alpha';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(200);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(900);
    const first = document.querySelector('.project-chip').textContent;

    document.querySelector('.project-chip').click();
    await wait(300);
    input = document.querySelector('.sheet-input');
    input.value = 'Beta';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await wait(200);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(900);
    const second = document.querySelector('.project-chip').textContent;

    // Now move it back to no project.
    document.querySelector('.project-chip').click();
    await wait(300);
    const none = [...document.querySelectorAll('.sheet-item-label')].find(n => n.textContent === 'No project');
    none.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    await wait(800);
    const cleared = document.querySelector('.project-chip').textContent;
    return { first, second, cleared };
  })()`)
  check('assigning a project updates the chip', r.first.includes('Alpha'), r.first)
  check('moving to another project replaces it', r.second.includes('Beta') && !r.second.includes('Alpha'), r.second)
  check('it can be removed from the project entirely', r.cleared === 'No project', r.cleared)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
