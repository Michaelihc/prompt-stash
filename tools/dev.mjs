// Dev loop: esbuild --watch in-process, plus an Electron child that restarts on
// main/preload changes. Renderer changes only need a window reload (Ctrl+R).
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const electron = resolve(ROOT, 'node_modules/electron/dist/electron.exe')

let child = null
let restarting = false

function launch() {
  const env = { ...process.env, PROMPT_STASH_DEV: '1' }
  // The ambient shell may set this; it would make Electron boot as plain Node.
  delete env.ELECTRON_RUN_AS_NODE
  child = spawn(electron, [resolve(ROOT, 'dist/main/main.js')], { stdio: 'inherit', env })
  child.on('exit', (code) => {
    child = null
    if (!restarting) process.exit(code ?? 0)
  })
}

function restart() {
  if (restarting) return
  restarting = true
  const done = () => {
    restarting = false
    launch()
  }
  if (child) {
    child.once('exit', done)
    child.kill()
  } else done()
}

const build = spawn(process.execPath, [resolve(ROOT, 'tools/build.mjs'), '--watch'], {
  stdio: 'inherit',
})
build.on('exit', () => process.exit(1))

// Give the first build a moment to land before booting Electron.
setTimeout(() => {
  launch()
  let timer = null
  for (const dir of ['dist/main', 'dist/preload']) {
    watch(resolve(ROOT, dir), { recursive: true }, () => {
      clearTimeout(timer)
      timer = setTimeout(restart, 150)
    })
  }
}, 1200)

process.on('SIGINT', () => {
  restarting = true
  child?.kill()
  build.kill()
  process.exit(0)
})
