// Pure-function tests for the section/divider logic that Ctrl+Enter and Ctrl+A rely on.
import * as esbuild from 'esbuild'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'stash-sec-'))
const bundle = join(work, 'util.cjs')

await esbuild.build({
  entryPoints: [join(ROOT, 'src/renderer/util.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node24',
  logLevel: 'warning',
})
const { sectionBounds, isDividerLine, findVariables, fillVariables } =
  createRequire(import.meta.url)(bundle)

let passed = 0
let failed = 0
function check(name, fn) {
  try {
    fn()
    passed++
  } catch (err) {
    failed++
    console.error(`  FAIL ${name}\n        ${err.message}`)
  }
}
function eq(a, b, what = '') {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${what} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)
  }
}
/** Marks the selected span with » « so failures are readable. */
function sel(text, caret) {
  const { start, end } = sectionBounds(text, caret)
  return text.slice(0, start) + '»' + text.slice(start, end) + '«' + text.slice(end)
}

check('a divider line is recognised in its usual forms', () => {
  for (const line of ['---', '----------', '-------------------', '  ----  ', '\t---']) {
    if (!isDividerLine(line)) throw new Error(`should be a divider: ${JSON.stringify(line)}`)
  }
})

check('ordinary text is not mistaken for a divider', () => {
  for (const line of ['--', 'a---', '---a', '- - -', '—', '', 'Refactor --force']) {
    if (isDividerLine(line)) throw new Error(`should not be a divider: ${JSON.stringify(line)}`)
  }
})

check('with no dividers the whole body is one section', () => {
  const t = 'line one\nline two\nline three'
  eq(sel(t, 0), '»line one\nline two\nline three«')
  eq(sel(t, t.length), '»line one\nline two\nline three«')
  eq(sel(t, 12), '»line one\nline two\nline three«')
})

check('the caret before a divider selects only the part above it', () => {
  const t = 'first part\n----------\nsecond part'
  eq(sel(t, 0), '»first part«\n----------\nsecond part')
  eq(sel(t, 10), '»first part«\n----------\nsecond part')
})

check('the caret after a divider selects only the part below it', () => {
  const t = 'first part\n----------\nsecond part'
  eq(sel(t, t.length), 'first part\n----------\n»second part«')
  eq(sel(t, 23), 'first part\n----------\n»second part«')
})

check('the middle section of three is bounded on both sides', () => {
  const t = 'a\n---\nb\n---\nc'
  eq(sel(t, 6), 'a\n---\n»b«\n---\nc')
})

check('the caret on the divider itself selects just that line', () => {
  const t = 'a\n---\nb'
  eq(sel(t, 3), 'a\n»---«\nb')
})

check('blank lines around a section are trimmed off the selection', () => {
  const t = 'top\n\n----------\n\n\nbody text\n\n----------\nend'
  eq(sel(t, 20), 'top\n\n----------\n\n\n»body text«\n\n----------\nend')
})

check('an empty section between two dividers selects nothing', () => {
  const t = 'a\n---\n\n---\nb'
  const { start, end } = sectionBounds(t, 6)
  eq(start <= end, true, 'start <= end')
  eq(t.slice(start, end), '', 'empty selection')
})

check('a body that is only a divider is handled', () => {
  const t = '---'
  eq(sel(t, 0), '»---«')
})

check('an empty body is handled', () => {
  eq(sel('', 0), '»«')
})

check('a caret past the end does not escape the bounds', () => {
  const t = 'a\n---\nb'
  const { start, end } = sectionBounds(t, 9999)
  eq(end <= t.length, true, 'end within bounds')
  eq(t.slice(start, end), 'b')
})

check('sections coexist with placeholders', () => {
  const t = 'Use {{a}} here\n----------\nThen {{b}} there'
  eq(findVariables(t), ['a', 'b'])
  const { start, end } = sectionBounds(t, 0)
  eq(findVariables(t.slice(start, end)), ['a'], 'first section has only its own variable')
  eq(fillVariables(t.slice(start, end), { a: 'X' }), 'Use X here')
})

check('a Windows-style body with carriage returns still splits', () => {
  // The textarea normalises to \n, but imported text may not have been.
  const t = 'a\r\n---\r\nb'
  const { start, end } = sectionBounds(t, 0)
  eq(t.slice(start, end).replace(/\r/g, ''), 'a', 'first section')
})

rmSync(work, { recursive: true, force: true })
console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
