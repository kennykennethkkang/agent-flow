const esbuild = require('esbuild')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const watch = process.argv.includes('--watch')

/** @type {import('esbuild').BuildOptions} */
const config = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  minify: !watch,
}

// claude-mods/kit's rules and role agents ship in the VSIX (kit/), so a machine without the kit gets them too.
const KIT_SRC = process.env.CLAUDE_MODS_KIT || path.join(__dirname, '..', '..', 'claude-mods', 'kit')
const KIT_OUT = path.join(__dirname, 'kit')
// Refuse to bundle anything that looks like a key.
const SECRET = /sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{10,}/
const sha = text => crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)

function bundleKit() {
  if (!fs.existsSync(path.join(KIT_SRC, 'rules.md'))) {
    console.warn(`kit: ${KIT_SRC} not found, keeping the bundled copy in kit/`)
    return
  }
  const read = p => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined)
  const old = JSON.parse(read(path.join(KIT_OUT, 'bundle.json')) ?? '{"history":{}}')
  const files = [['rules.md', path.join(KIT_SRC, 'rules.md')], ...fs.readdirSync(path.join(KIT_SRC, 'agents')).filter(n => n.endsWith('.md')).map(n => [`agents/${n}`, path.join(KIT_SRC, 'agents', n)])]
  for (const [, src] of files) if (SECRET.test(fs.readFileSync(src, 'utf8'))) throw new Error(`kit: ${src} looks like it holds a secret; not bundled`)
  const rules = fs.readFileSync(path.join(KIT_SRC, 'rules.md'), 'utf8')
  // Same version as kit/setup.mjs writes: when rules.md last changed, kept while its text is unchanged.
  const rulesVersion = read(path.join(KIT_OUT, 'rules.md')) === rules && old.rulesVersion ? old.rulesVersion : `${fs.statSync(path.join(KIT_SRC, 'rules.md')).mtime.toISOString().slice(0, 19)}Z`
  const history = old.history ?? {}
  fs.mkdirSync(path.join(KIT_OUT, 'agents'), { recursive: true })
  // A role the kit dropped leaves the bundle too.
  for (const n of fs.readdirSync(path.join(KIT_OUT, 'agents'))) if (!files.some(([name]) => name === `agents/${n}`)) fs.rmSync(path.join(KIT_OUT, 'agents', n))
  for (const [name, src] of files) {
    const text = fs.readFileSync(src, 'utf8'), prev = read(path.join(KIT_OUT, name))
    // An earlier bundled copy of a role: a user file matching it was never edited, so it may be updated.
    if (name.startsWith('agents/') && prev !== undefined && prev !== text) {
      const key = path.basename(name)
      history[key] = [...new Set([...(history[key] ?? []), sha(prev)])]
    }
    fs.writeFileSync(path.join(KIT_OUT, name), text)
  }
  fs.writeFileSync(path.join(KIT_OUT, 'bundle.json'), `${JSON.stringify({ rulesVersion, history }, null, 2)}\n`)
  console.log(`kit: bundled rules.md (${rulesVersion}) and ${files.length - 1} role agents`)
}

// The browser app (app/dist: app.js and webview/) ships in dist/app, so Open in browser and Phone work from the vsix alone.
const APP_SRC = path.join(__dirname, '..', 'app', 'dist')
const APP_OUT = path.join(__dirname, 'dist', 'app')

function bundleApp() {
  if (!fs.existsSync(path.join(APP_SRC, 'app.js')) || !fs.existsSync(path.join(APP_SRC, 'webview', 'index.js'))) {
    console.warn(`app: ${APP_SRC} not built (node app/build.js), keeping the bundled copy in dist/app`)
    return
  }
  fs.rmSync(APP_OUT, { recursive: true, force: true })
  fs.cpSync(APP_SRC, APP_OUT, { recursive: true })
  console.log('app: bundled app/dist into dist/app')
}

async function main() {
  bundleKit()
  bundleApp()
  if (watch) {
    const ctx = await esbuild.context(config)
    await ctx.watch()
    console.log('Watching for changes...')
  } else {
    await esbuild.build(config)
    console.log('Build complete')
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
