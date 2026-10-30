/**
 * Set up: the steps a new machine runs, each skipped when that piece is already there, and the node runner that runs them.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { claudeCall, setupState, setupSteps, type SetupKit } from '../src/hub/setup'
// @ts-expect-error plain .mjs, no types
import { commandFor, expand, installSkills, keyFor, mcpConfig, readKey, storeKey } from '../kit/setup-run.mjs'

const KIT: SetupKit = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'kit', 'setup.json'), 'utf8'))
const fresh = { plugins: [], marketplaces: [], mcps: [], plain: [] as string[], skills: [] as string[], key21st: false, modsDir: '/ext/kit/mods' }
const steps = (o = {}) => setupSteps(KIT, { ...fresh, ...o })
const runs = (o = {}) => steps(o).flatMap(s => (s.run ? [s.run.join(' ')] : []))
const text = (o = {}) => JSON.stringify(steps(o))
const MODS = '~/.claude/switchboard/mods'
const ASK = '~/.claude/switchboard/ask/ask-server.mjs'

describe('setup steps', () => {
  it('adds every marketplace, plugin, mod and mcp on a fresh machine', () => {
    const r = runs({ key21st: true })
    for (const [name, repo] of Object.entries(KIT.marketplaces)) assert.ok(r.includes(`claude plugin marketplace add ${repo}`), name)
    for (const id of KIT.plugins) assert.ok(r.includes(`claude plugin install ${id}`), id)
    for (const m of KIT.mods) assert.ok(r.includes(`claude plugin install ${m}@kenneth-mods`), m)
    for (const m of KIT.mcps.filter(x => !x.keyHeader)) assert.ok(r.some(l => l.startsWith(`claude mcp add --scope user --transport http ${m.name} ${m.url}`)), m.name)
    assert.ok(steps({ key21st: true }).some(x => x.key?.name === '21st'))
    const mods = steps().find(s => s.copy)
    assert.deepEqual(mods?.copy, { from: '/ext/kit/mods', to: MODS })
    assert.deepEqual(mods?.run, ['claude', 'plugin', 'marketplace', 'add', MODS])
    assert.equal(mods?.ifExists, undefined)
    const ask = steps().find(s => s.run?.includes('switchboard'))
    assert.deepEqual(ask, { label: 'Ask tool', ifExists: ASK, run: ['claude', 'mcp', 'add', '--scope', 'user', 'switchboard', '--', 'node', ASK] })
  })

  it('skips what is already there', () => {
    const r = runs({
      plugins: [...KIT.plugins, ...KIT.mods.map(m => `${m}@kenneth-mods`)],
      marketplaces: [...Object.keys(KIT.marketplaces), 'kenneth-mods'],
      mcps: [...KIT.mcps.map(m => m.name), 'switchboard'],
      key21st: true,
    }).join('\n')
    assert.doesNotMatch(r, /claude plugin (install|marketplace add)|claude mcp add/)
    assert.match(text(), /\/mcp/)
  })

  it('refreshes only its own copy of the mods', () => {
    const s = steps({ marketplaces: [...Object.keys(KIT.marketplaces), 'kenneth-mods'] }).find(x => x.copy)
    assert.deepEqual(s, { label: 'Refresh mods', ifExists: MODS, copy: { from: '/ext/kit/mods', to: MODS }, run: ['claude', 'plugin', 'marketplace', 'update', 'kenneth-mods'] })
  })

  it('adds each mcp once', () => {
    const r = runs({ key21st: true })
    for (const m of ['slack', 'switchboard']) assert.equal(r.filter(l => l.startsWith('claude mcp add') && l.split(' ').includes(m)).length, 1, m)
    assert.equal(steps({ key21st: true }).filter(x => x.key).length, 1)
  })

  it('leaves the 21st key to the runner, never in a command, and skips 21st without one', () => {
    const s = steps({ key21st: true }).find(x => x.key)
    assert.deepEqual(s, { label: '21st', key: { name: '21st', url: 'https://21st.dev/api/mcp', header: 'x-api-key' } })
    assert.ok(!runs({ key21st: true }).some(l => l.includes('21st')))
    assert.ok(!steps().some(x => x.key))
    assert.match(text(), /21st: no key/)
  })

  it('stores a new key even when 21st is there, and moves a plain-text key without asking', () => {
    const k = (o = {}) => steps({ mcps: ['21st'], ...o }).filter(x => x.key).length
    assert.equal(k({ key21st: true }), 1)
    assert.equal(k(), 0)
    assert.doesNotMatch(text({ mcps: ['21st'] }), /21st: no key/)
    assert.equal(k({ mcps: [], plain: ['21st'] }), 1)
    // Linux has no store, so moving it would only lose the key.
    assert.equal(k({ mcps: [], plain: ['21st'], platform: 'linux' }), 0)
    assert.equal(k({ key21st: true, platform: 'linux' }), 1)
  })

  it('fetches each skill repo with only the skills not already there', () => {
    const sk = KIT.skills ?? []
    assert.deepEqual(steps().filter(s => s.skills).map(s => s.skills), sk)
    const [first, ...rest] = sk
    const some = steps({ skills: [first.names[0]] }).filter(s => s.skills)
    assert.deepEqual(some[0], { label: first.repo, skills: { repo: first.repo, names: first.names.slice(1) } })
    assert.deepEqual(steps({ skills: sk.flatMap(k => k.names) }).filter(s => s.skills), [])
    assert.ok(rest.length > 0)
  })

  it('carries no absolute path from this machine', () => {
    assert.doesNotMatch(text(), /\/Users\//)
    assert.doesNotMatch(JSON.stringify(KIT), /\/Users\/|kennykennethkkang/)
  })
})

describe('setup runner', () => {
  it('expands ~/ against home', () => {
    assert.equal(expand('~/.claude/x', '/h'), path.join('/h', '.claude/x'))
    assert.equal(expand('obra/superpowers', '/h'), 'obra/superpowers')
  })

  it('keeps the key in the OS store, fed by stdin or env, never in args', () => {
    const mac = storeKey('k1', 'darwin', '/h')
    assert.deepEqual(mac.args.slice(0, 5), ['add-generic-password', '-U', '-s', 'switchboard-21st', '-a'])
    assert.equal(mac.args.at(-1), '-w')
    assert.equal(mac.input, 'k1\nk1\n')
    // In a terminal, security reads the tty and ignores stdin unless it has none.
    assert.equal(mac.detached, true)
    const win = storeKey('k1', 'win32', 'C:\\Users\\A B')
    assert.equal(win.cmd, 'powershell')
    assert.match(win.args.at(-1), /ConvertFrom-SecureString/)
    assert.deepEqual(win.env, { API_KEY_21ST: 'k1', SB_KEY_FILE: path.join('C:\\Users\\A B', '.claude', 'switchboard', '21st.key') })
    for (const c of [mac, win]) assert.ok(!c.args.some((a: string) => a.includes('k1')))
    assert.equal(storeKey('k1', 'linux', '/h'), undefined)
  })

  it('takes the key from the env, else from a plain-text header in ~/.claude.json', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-key-'))
    const k = { name: '21st', url: 'u', header: 'x-api-key' }
    assert.equal(keyFor(k, { API_KEY_21ST: ' k1 ' }, home), 'k1')
    assert.equal(keyFor(k, {}, home), '')
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { '21st': { headers: { 'x-api-key': 'old1' } } } }))
    assert.equal(keyFor(k, {}, home), 'old1')
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { '21st': { headers: { 'x-api-key': '${API_KEY_21ST}' } } } }))
    assert.equal(keyFor(k, {}, home), '')
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('reads the key back from the same store', () => {
    assert.deepEqual(readKey('darwin', '/h'), { cmd: 'security', args: ['find-generic-password', '-s', 'switchboard-21st', '-w'] })
    const win = readKey('win32', '/h')
    assert.match(win.args.at(-1), /ConvertTo-SecureString/)
    assert.equal(win.env.SB_KEY_FILE, path.join('/h', '.claude', 'switchboard', '21st.key'))
    assert.equal(readKey('linux', '/h'), undefined)
  })

  it('registers a headers helper where there is a store, else an env reference', () => {
    const url = 'https://21st.dev/api/mcp'
    assert.deepEqual(mcpConfig(url, 'x-api-key', 'darwin', '/h'), { type: 'http', url, headersHelper: `node "${path.join('/h', '.claude', 'switchboard', 'setup-run.mjs')}" --headers x-api-key` })
    assert.equal(mcpConfig(url, 'x-api-key', 'win32', 'C:\\Users\\A B').headersHelper, 'node "C:/Users/A B/.claude/switchboard/setup-run.mjs" --headers x-api-key')
    assert.deepEqual(mcpConfig(url, 'x-api-key', 'linux', '/h'), { type: 'http', url, headers: { 'x-api-key': '${API_KEY_21ST}' } })
  })

  it('runs claude directly on macOS and through cmd with quoted args on Windows', () => {
    assert.deepEqual(commandFor('claude', ['mcp', 'add', 'x-api-key: k'], 'darwin'), { cmd: 'claude', args: ['mcp', 'add', 'x-api-key: k'], shell: false })
    assert.deepEqual(commandFor('claude', ['plugin', 'add', 'C:\\Users\\A B\\mods', 'a"b'], 'win32'), { cmd: 'claude', args: ['plugin', 'add', '"C:\\Users\\A B\\mods"', '"a\\"b"'], shell: true })
    // Backslashes before a quote double, so JSON with escaped quotes survives.
    assert.deepEqual(commandFor('claude', ['{"h":"node \\"C:/x y\\""}', 'C:\\A B\\'], 'win32').args, ['"{\\"h\\":\\"node \\\\\\"C:/x y\\\\\\"\\"}"', '"C:\\A B\\\\"'])
  })

  it('copies named skills from a clone, found by their SKILL.md name, and never overwrites one', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-skills-'))
    const fake = (repo: string, dir: string) => {
      assert.equal(repo, 'a/b')
      for (const [folder, name] of [['one', 'one'], ['renamed', 'two'], ['three', 'three']]) {
        fs.mkdirSync(path.join(dir, 'skills', folder, 'refs'), { recursive: true })
        fs.writeFileSync(path.join(dir, 'skills', folder, 'SKILL.md'), `---\nname: ${name}\n---\nbody ${folder}\n`)
        fs.writeFileSync(path.join(dir, 'skills', folder, 'refs', 'x.md'), 'x')
      }
      return ''
    }
    const mine = path.join(home, '.claude', 'skills', 'three')
    fs.mkdirSync(mine, { recursive: true })
    fs.writeFileSync(path.join(mine, 'SKILL.md'), 'my own')
    const r = installSkills({ repo: 'a/b', names: ['one', 'two', 'three', 'gone'] }, { home, clone: fake, log: () => {} })
    assert.deepEqual(r, { added: ['one', 'two'], kept: ['three'], missing: ['gone'] })
    assert.match(fs.readFileSync(path.join(home, '.claude', 'skills', 'two', 'SKILL.md'), 'utf8'), /body renamed/)
    assert.ok(fs.existsSync(path.join(home, '.claude', 'skills', 'one', 'refs', 'x.md')))
    assert.equal(fs.readFileSync(path.join(mine, 'SKILL.md'), 'utf8'), 'my own')
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('fails soft when a skill repo cannot be cloned, saying why', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-skills-'))
    const lines: string[] = []
    const r = installSkills({ repo: 'a/b', names: ['one'] }, { home, clone: () => 'repository not found', log: (l: string) => lines.push(l) })
    assert.equal(r.error, 'repository not found')
    assert.match(lines.join('\n'), /a\/b: .*repository not found/)
    assert.ok(!fs.existsSync(path.join(home, '.claude', 'skills', 'one')))
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('prints the steps in dry-run, without the key and without running them', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-run-'))
    const plan = path.join(dir, 'plan.json')
    fs.writeFileSync(plan, JSON.stringify(setupSteps(KIT, { ...fresh, key21st: true, modsDir: path.join(dir, 'mods') })))
    const out = execFileSync(process.execPath, [path.join(__dirname, '..', 'kit', 'setup-run.mjs'), plan, '--dry-run'], { encoding: 'utf8', env: { ...process.env, API_KEY_21ST: 'secret-key-1' } })
    assert.match(out, /claude plugin install superpowers@superpowers-dev/)
    assert.match(out, /copy .*mods/)
    assert.match(out, /Set up done/)
    assert.match(out, /git clone --depth 1 https:\/\/github.com\/emilkowalski\/skills.git/)
    assert.match(out, /claude mcp remove --scope user 21st/)
    assert.match(out, /claude mcp add-json --scope user 21st .*"type":"http"/)
    assert.doesNotMatch(out, /secret-key-1/)
    assert.ok(!fs.existsSync(path.join(dir, 'mods')))
    // A plain-text key is moved with no key given, and never printed.
    fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ mcpServers: { '21st': { headers: { 'x-api-key': 'plain-key-2' } } } }))
    fs.writeFileSync(plan, JSON.stringify(setupSteps(KIT, { ...fresh, ...setupState(dir), modsDir: path.join(dir, 'mods') })))
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, USERPROFILE: dir }
    delete env.API_KEY_21ST
    const moved = execFileSync(process.execPath, [path.join(__dirname, '..', 'kit', 'setup-run.mjs'), plan, '--dry-run'], { encoding: 'utf8', env })
    assert.match(moved, /claude mcp add-json --scope user 21st/)
    assert.doesNotMatch(moved, /plain-key-2/)
    fs.rmSync(dir, { recursive: true, force: true })
  })
})

describe('claude call', () => {
  it('registers the ask tool directly on macOS and through a shell with quoted paths on Windows', () => {
    const args = ['mcp', 'add', '--scope', 'user', 'switchboard', '--', 'node', 'C:\\Users\\A B\\.claude\\switchboard\\ask\\ask-server.mjs']
    assert.deepEqual(claudeCall(args, 'darwin'), { cmd: 'claude', args, shell: false })
    const w = claudeCall(args, 'win32')
    assert.equal(w.shell, true)
    assert.deepEqual(w.args.slice(0, 7), args.slice(0, 7))
    assert.equal(w.args[7], '"C:\\Users\\A B\\.claude\\switchboard\\ask\\ask-server.mjs"')
  })
})

describe('setup state', () => {
  it('reads installed plugins, marketplaces and user mcps, empty when missing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-setup-'))
    assert.deepEqual(setupState(home), { plugins: [], marketplaces: [], mcps: [], plain: [], skills: [] })
    fs.mkdirSync(path.join(home, '.claude', 'plugins'), { recursive: true })
    fs.writeFileSync(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'a@b': [] } }))
    fs.writeFileSync(path.join(home, '.claude', 'plugins', 'known_marketplaces.json'), JSON.stringify({ b: { source: {} } }))
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { slack: {} } }))
    fs.mkdirSync(path.join(home, '.claude', 'skills', 'animate'), { recursive: true })
    assert.deepEqual(setupState(home), { plugins: ['a@b'], marketplaces: ['b'], mcps: ['slack'], plain: [], skills: ['animate'] })
    // A key written into the config in plain text counts as missing, so the next run replaces it.
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { a: { headers: { 'x-api-key': 'k1' } }, b: { headers: { 'x-api-key': '${API_KEY_21ST}' } }, c: { headersHelper: 'node x' } } }))
    assert.deepEqual(setupState(home).mcps, ['b', 'c'])
    assert.deepEqual(setupState(home).plain, ['a'])
    fs.rmSync(home, { recursive: true, force: true })
  })
})
