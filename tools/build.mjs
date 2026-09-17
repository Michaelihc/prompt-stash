// Builds all three targets with esbuild. No bundler framework, no dev server.
//   src/main     -> dist/main/main.js         (CommonJS, node platform, electron external)
//   src/preload  -> dist/preload/preload.js   (CommonJS, sandbox-safe)
//   src/renderer -> dist/renderer/*           (ESM + CSS + index.html)
import * as esbuild from 'esbuild'
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const watch = process.argv.includes('--watch')
const dev = watch || process.argv.includes('--dev')

const common = {
  bundle: true,
  target: 'chrome146',
  sourcemap: dev ? 'inline' : false,
  minify: !dev,
  legalComments: 'none',
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': JSON.stringify(dev ? 'development' : 'production') },
}

const configs = [
  {
    ...common,
    entryPoints: [resolve(ROOT, 'src/main/main.ts')],
    outfile: resolve(ROOT, 'dist/main/main.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron', 'node:sqlite'],
  },
  {
    ...common,
    entryPoints: [resolve(ROOT, 'src/preload/preload.ts')],
    outfile: resolve(ROOT, 'dist/preload/preload.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
  },
  {
    ...common,
    entryPoints: [resolve(ROOT, 'src/renderer/main.ts'), resolve(ROOT, 'src/renderer/styles.css')],
    outdir: resolve(ROOT, 'dist/renderer'),
    platform: 'browser',
    format: 'esm',
    splitting: false,
  },
]

async function copyStatic() {
  await mkdir(resolve(ROOT, 'dist/renderer'), { recursive: true })
  await cp(resolve(ROOT, 'src/renderer/index.html'), resolve(ROOT, 'dist/renderer/index.html'))
}

async function run() {
  if (!existsSync(resolve(ROOT, 'build/icon.ico'))) {
    console.log('[build] icon missing, generating...')
    await import('./make-icon.mjs')
  }
  await rm(resolve(ROOT, 'dist'), { recursive: true, force: true })
  await copyStatic()

  if (watch) {
    const ctxs = await Promise.all(configs.map((c) => esbuild.context(c)))
    await Promise.all(ctxs.map((c) => c.watch()))
    console.log('[build] watching...')
    // index.html is static; re-copy on every rebuild cycle is cheap enough to skip.
    return
  }

  const t0 = performance.now()
  await Promise.all(configs.map((c) => esbuild.build(c)))
  const ms = Math.round(performance.now() - t0)

  // Report bundle sizes so regressions in renderer weight are visible.
  const sizes = []
  for (const f of ['main/main.js', 'preload/preload.js', 'renderer/main.js', 'renderer/styles.css']) {
    const p = resolve(ROOT, 'dist', f)
    if (existsSync(p)) sizes.push(`${f} ${(Buffer.byteLength(await readFile(p)) / 1024).toFixed(1)}kb`)
  }
  console.log(`[build] done in ${ms}ms — ${sizes.join('  ')}`)
}

run().catch((err) => {
  console.error(err)
  process.exit(1)
})
