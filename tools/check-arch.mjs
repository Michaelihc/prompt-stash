// Reads the PE header of each built executable and reports its real machine type.
// The ARM64 build cannot be run on this machine, so this is how it gets verified.
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const MACHINE = {
  0x014c: 'x86 (32-bit)',
  0x8664: 'x64',
  0xaa64: 'ARM64',
  0x01c4: 'ARMv7',
}

/** PE: 'MZ' at 0, e_lfanew at 0x3C points at 'PE\0\0', machine is the next 2 bytes. */
function machineOf(file) {
  const buf = readFileSync(file)
  if (buf.readUInt16LE(0) !== 0x5a4d) return 'not a PE file'
  const peOffset = buf.readUInt32LE(0x3c)
  if (buf.readUInt32LE(peOffset) !== 0x00004550) return 'bad PE signature'
  const machine = buf.readUInt16LE(peOffset + 4)
  return MACHINE[machine] ?? `unknown (0x${machine.toString(16)})`
}

const targets = [
  ['app exe   x64  ', 'release/win-unpacked/Prompt Stash.exe'],
  ['app exe   arm64', 'release/win-arm64-unpacked/Prompt Stash.exe'],
  ['installer x64  ', 'release/PromptStash-Setup-1.0.0-x64.exe'],
  ['installer arm64', 'release/PromptStash-Setup-1.0.0-arm64.exe'],
  ['installer both ', 'release/PromptStash-Setup-1.0.0.exe'],
]

let bad = 0
for (const [label, rel] of targets) {
  const file = join(ROOT, rel)
  if (!existsSync(file)) {
    console.log(`${label}  MISSING`)
    bad++
    continue
  }
  const m = machineOf(file)
  const size = (readFileSync(file).length / 1048576).toFixed(0)
  console.log(`${label}  ${m.padEnd(12)} ${size} MB`)
  if (label.includes('app exe   x64') && m !== 'x64') bad++
  if (label.includes('app exe   arm64') && m !== 'ARM64') bad++
}

// The ARM64 app must also ship ARM64 native libraries, not x64 ones.
const dll = join(ROOT, 'release/win-arm64-unpacked/ffmpeg.dll')
if (existsSync(dll)) console.log(`arm64 ffmpeg.dll  ${machineOf(dll)}`)

process.exit(bad ? 1 : 0)
