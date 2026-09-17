// Launches the built app. Exists because the ambient shell may export
// ELECTRON_RUN_AS_NODE=1, which silently boots Electron as plain Node.
import { spawn } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(
  resolve(ROOT, 'node_modules/electron/dist/electron.exe'),
  [resolve(ROOT, 'dist/main/main.js'), ...process.argv.slice(2)],
  { stdio: 'inherit', env },
)
child.on('exit', (code) => process.exit(code ?? 0))
