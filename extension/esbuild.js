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
// The VSIX goes to other people: their rules name the user, gender neutral. Kenneth's own copy has the same version, so his stays.
const genericRules = text => text.replace(/Kenneth('s)?/g, (_, s) => `the user${s ?? ''}`).replace(/\bhimself\b/g, 'themselves').replace(/\bhis own\b/g, 'their own').replace(/(^|[.!?] |^- |\/\/ |\/\*\* |['"`])the user/gm, '$1The user')
// Same marker as src/hub/rules.ts GENERIC: a generic bundle never replaces a kit copy without it.
const GENERIC = '<!-- switchboard generic copy -->'
const marked = text => `${genericRules(text).trimEnd()}\n\n${GENERIC}\n`

function bundleKit() {
  if (!fs.existsSync(path.join(KIT_SRC, 'rules.md'))) {
    console.warn(`kit: ${KIT_SRC} not found, keeping the bundled copy in kit/`)
    return
  }
  const read = p => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : undefined)
  const old = JSON.parse(read(path.join(KIT_OUT, 'bundle.json')) ?? '{"history":{}}')
  const files = [['rules.md', path.join(KIT_SRC, 'rules.md')], ...fs.readdirSync(path.join(KIT_SRC, 'agents')).filter(n => n.endsWith('.md')).map(n => [`agents/${n}`, path.join(KIT_SRC, 'agents', n)])]
  for (const [, src] of files) if (SECRET.test(fs.readFileSync(src, 'utf8'))) throw new Error(`kit: ${src} looks like it holds a secret; not bundled`)
  const rules = marked(fs.readFileSync(path.join(KIT_SRC, 'rules.md'), 'utf8'))
  // Same version as kit/setup.mjs writes: when rules.md last changed, kept while its text is unchanged.
  const rulesVersion = read(path.join(KIT_OUT, 'rules.md')) === rules && old.rulesVersion ? old.rulesVersion : `${fs.statSync(path.join(KIT_SRC, 'rules.md')).mtime.toISOString().slice(0, 19)}Z`
  const history = old.history ?? {}
  fs.mkdirSync(path.join(KIT_OUT, 'agents'), { recursive: true })
  // A role the kit dropped leaves the bundle too.
  for (const n of fs.readdirSync(path.join(KIT_OUT, 'agents'))) if (!files.some(([name]) => name === `agents/${n}`)) fs.rmSync(path.join(KIT_OUT, 'agents', n))
  for (const [name, src] of files) {
    const text = marked(fs.readFileSync(src, 'utf8')), prev = read(path.join(KIT_OUT, name))
    // An earlier bundled copy of a role: a user file matching it was never edited, so it may be updated.
    if (name.startsWith('agents/') && prev !== undefined && prev !== text) {
      const key = path.basename(name)
      history[key] = [...new Set([...(history[key] ?? []), sha(prev)])]
    }
    fs.writeFileSync(path.join(KIT_OUT, name), text)
  }
  fs.writeFileSync(path.join(KIT_OUT, 'bundle.json'), `${JSON.stringify({ rulesVersion, generic: true, history }, null, 2)}\n`)
  console.log(`kit: bundled rules.md (${rulesVersion}) and ${files.length - 1} role agents`)
}

// The three mods and their marketplace manifest ship too (kit/mods), for Set up on a machine without claude-mods.
const MODS = ['usage-meter', 'repo-rules', 'paid-guard']
const MODS_OUT = path.join(KIT_OUT, 'mods')

function bundleMods() {
  const root = path.dirname(KIT_SRC)
  if (!fs.existsSync(path.join(root, '.claude-plugin', 'marketplace.json'))) {
    console.warn(`mods: ${root} not found, keeping the bundled copy in kit/mods`)
    return
  }
  fs.rmSync(MODS_OUT, { recursive: true, force: true })
  for (const dir of ['.claude-plugin', ...MODS]) {
    fs.cpSync(path.join(root, dir), path.join(MODS_OUT, dir), { recursive: true, filter: src => !/[\\/](tests|node_modules)$|\.DS_Store$/.test(src) })
  }
  for (const f of fs.readdirSync(MODS_OUT, { recursive: true })) {
    const p = path.join(MODS_OUT, f)
    if (!fs.statSync(p).isFile()) continue
    const text = fs.readFileSync(p, 'utf8')
    if (SECRET.test(text)) throw new Error(`mods: ${p} looks like it holds a secret; not bundled`)
    // Hooks and descriptions name the user too; author and owner names are credit and stay.
    fs.writeFileSync(p, p.endsWith('.json') ? text.replace(/"description": "[^"]*"/g, genericRules) : genericRules(text))
  }
  console.log(`mods: bundled ${MODS.join(', ')}`)
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
  bundleMods()
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

module.exports = { genericRules, GENERIC }

if (require.main === module) main().catch((e) => {
  console.error(e)
  process.exit(1)
})
