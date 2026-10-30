/**
 * Unit tests for v0.16.0: a chat's changes (git diff of its folder), History note
 * search, the browser link and the terminal keybinding pass-through. Pure parts only.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as http from 'http'
import * as os from 'os'
import * as path from 'path'
import { execFileSync } from 'child_process'
import { phoneCode } from '../src/hub/lan'
import { ensureWeb, insideCwd, parseChanges, phoneUrls, readChanges, safeFile, servesLive, webUrl } from '../src/hub/local'
import { noteSnippet, searchNotes } from '../src/hub/chains'
import { withSkipShell } from '../src/hub/controls'
import type { ArchivedChat } from '../src/hub/types'

const DIFF = [
  'diff --git a/auth/middleware.ts b/auth/middleware.ts',
  'index 1..2 100644',
  '--- a/auth/middleware.ts',
  '+++ b/auth/middleware.ts',
  '@@ -1,2 +1,2 @@',
  '-old',
  '+new',
  'diff --git a/lib/new.ts b/lib/new.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/lib/new.ts',
  '@@ -0,0 +1 @@',
  '+hello',
  'diff --git a/gone.ts b/gone.ts',
  'deleted file mode 100644',
  '--- a/gone.ts',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-bye',
  'diff --git a/logo.png b/logo.png',
  'Binary files a/logo.png and b/logo.png differ',
  '',
].join('\n')
const NUMSTAT = '1\t1\tauth/middleware.ts\n1\t0\tlib/new.ts\n0\t1\tgone.ts\n-\t-\tlogo.png\n'

describe('changes', () => {
  it('lists each changed file with counts, status and its diff from the first hunk', () => {
    const files = parseChanges(NUMSTAT, DIFF, [])
    assert.deepEqual(files.map(f => [f.path, f.added, f.removed, f.status]), [
      ['auth/middleware.ts', 1, 1, 'modified'], ['lib/new.ts', 1, 0, 'added'], ['gone.ts', 0, 1, 'deleted'], ['logo.png', 0, 0, 'modified'],
    ])
    assert.equal(files[0].diff, '@@ -1,2 +1,2 @@\n-old\n+new')
    assert.equal(files[3].diff, undefined)
    assert.match(files[3].note ?? '', /Binary/)
  })

  it('shows an untracked file as all added, and notes a binary or huge one instead of its text', () => {
    const files = parseChanges('', '', [{ path: 'notes.md', text: 'a\nb\n' }, { path: 'pic.jpg', binary: true }, { path: 'big.log', text: 'x\n'.repeat(5000) }])
    assert.deepEqual(files.map(f => [f.path, f.added, f.status]), [['notes.md', 2, 'untracked'], ['pic.jpg', 0, 'untracked'], ['big.log', 5000, 'untracked']])
    assert.equal(files[0].diff, '+a\n+b')
    assert.match(files[1].note ?? '', /Binary/)
    assert.equal(files[2].diff, undefined)
    assert.match(files[2].note ?? '', /too big/i)
  })

  it('keeps only paths inside the chat folder', () => {
    assert.equal(insideCwd('/u/app', 'src/a.ts'), true)
    for (const bad of ['../x', '/etc/passwd', 'src/../../x', '', '.']) assert.equal(insideCwd('/u/app', bad), false, bad)
    assert.deepEqual(parseChanges('1\t0\t../x\n', '', [{ path: '../y', text: 'a' }]).map(f => f.path), [])
  })
})

describe('changes: links and odd paths', () => {
  it('keys each diff by its numstat path, so a path holding " b/" keeps its own diff', () => {
    const diff = ['diff --git a/a b/c.txt b/a b/c.txt', '--- a/a b/c.txt', '+++ b/a b/c.txt', '@@ -1 +1 @@', '-x', '+y', ''].join('\n')
    const [f] = parseChanges('1\t1\ta b/c.txt\n', diff, [])
    assert.equal(f.path, 'a b/c.txt')
    assert.equal(f.diff, '@@ -1 +1 @@\n-x\n+y')
  })

  it('never reads or opens through a symlink, nor a file whose real path leaves the folder', async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-links-')))
    const repo = path.join(root, 'repo')
    fs.mkdirSync(path.join(repo, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(root, 'secret.txt'), 'SECRET-OUTSIDE')
    fs.writeFileSync(path.join(repo, 'ok.txt'), 'fine\n')
    fs.symlinkSync(path.join(root, 'secret.txt'), path.join(repo, 'leak.txt'))
    fs.symlinkSync(root, path.join(repo, 'sub', 'up'))
    assert.equal(await safeFile(repo, 'ok.txt'), path.join(repo, 'ok.txt'))
    assert.equal(await safeFile(repo, 'leak.txt'), undefined)
    assert.equal(await safeFile(repo, 'sub/up/secret.txt'), undefined)
    assert.equal(await safeFile(repo, '../secret.txt'), undefined)
    execFileSync('git', ['init', '-q', repo])
    const files = await readChanges(repo)
    assert.ok(!JSON.stringify(files).includes('SECRET-OUTSIDE'))
    const leak = files.find(f => f.path === 'leak.txt')
    assert.equal(leak?.diff, undefined)
    assert.match(leak?.note ?? '', /symlink/i)
    assert.equal(files.find(f => f.path === 'ok.txt')?.diff, '+fine')
  })
})

describe('History note search', () => {
  it('cuts a snippet around the first match, case-insensitive', () => {
    const text = `${'a'.repeat(200)} the Cookie check skipped SameSite ${'b'.repeat(200)}`
    const s = noteSnippet(text, 'cookie') ?? ''
    assert.match(s, /Cookie check/)
    assert.ok(s.startsWith('...') && s.endsWith('...'))
    assert.ok(s.length < 160)
    assert.equal(noteSnippet(text, 'nothere'), undefined)
    assert.equal(noteSnippet('Short cookie note', 'cookie'), 'Short cookie note')
  })

  it('reads only notes under the handoffs folder and finds words in them', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-notes-'))
    const handoffs = path.join(home, '.claude', 'handoffs')
    fs.mkdirSync(path.join(handoffs, 'p'), { recursive: true })
    fs.writeFileSync(path.join(handoffs, 'p', 'a.md'), 'Fixed the cookie banner')
    fs.writeFileSync(path.join(home, 'outside.md'), 'cookie outside')
    const row = (sessionId: string, note: string): ArchivedChat => ({ sessionId, ai: 'claude', name: 'n', origin: 'n', version: 1, cwd: '/u', project: 'u', note, archivedAt: 1 })
    const hits = searchNotes([row('a', path.join(handoffs, 'p', 'a.md')), row('b', path.join(home, 'outside.md')), row('c', path.join(handoffs, 'p', '..', '..', '..', 'outside.md'))], 'COOKIE', handoffs)
    assert.deepEqual(hits.map(h => h.sessionId), ['a'])
    assert.match(hits[0].snippet, /cookie banner/)
    assert.deepEqual(searchNotes([row('a', path.join(handoffs, 'p', 'a.md'))], ' ', handoffs), [])
  })
})

describe('browser link', () => {
  const appDir = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-web-'))
    fs.mkdirSync(path.join(root, 'app', 'dist'), { recursive: true })
    fs.writeFileSync(path.join(root, 'app', 'dist', 'app.js'), '')
    return root
  }
  const pidFile = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-pid-')), 'app.pid')
  it('opens a running app without starting another', async () => {
    let starts = 0
    assert.deepEqual(await ensureWeb(appDir(), false, { find: async () => 'http://127.0.0.1:3131', start: () => { starts++ }, pidFile: pidFile() }), { url: 'http://127.0.0.1:3131' })
    assert.equal(starts, 0)
  })
  it('says so when the app is not built', async () => {
    let starts = 0
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-web-'))
    const r = await ensureWeb(root, false, { find: async () => null, start: () => { starts++ }, pidFile: pidFile() })
    assert.match((r as { problem: string }).problem, /app\/dist\/app\.js/)
    assert.equal(starts, 0)
  })
  it('runs the bundled app first, the checkout only when the bundle is missing', async () => {
    const apps: string[] = []
    let up = false
    const find = async () => (up ? 'http://127.0.0.1:3131' : null)
    const start = (_r: string, _l: boolean, app: string) => { apps.push(app); up = true }
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-')), bundle = path.join(ext, 'dist', 'app', 'app.js')
    fs.mkdirSync(path.dirname(bundle), { recursive: true })
    fs.writeFileSync(bundle, '')
    const root = appDir()
    const stage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stage-')), 'app'), staged = path.join(stage, 'app.js')
    await ensureWeb(root, false, { find, start, bundle, stage, tries: 2, waitMs: 1, pidFile: pidFile() })
    up = false
    await ensureWeb(root, false, { find, start, bundle: path.join(ext, 'missing.js'), stage, tries: 2, waitMs: 1, pidFile: pidFile() })
    up = false
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-web-'))
    await ensureWeb(bare, false, { find, start, bundle, stage, tries: 2, waitMs: 1, pidFile: pidFile() })
    assert.deepEqual(apps, [staged, path.join(root, 'app', 'dist', 'app.js'), staged])
  })
  it('runs the bundled app from a stable copy that outlives the extension folder, refreshed when the bundle changes', async () => {
    const apps: string[] = []
    let up = false
    const find = async () => (up ? 'http://127.0.0.1:3131' : null)
    const start = (_r: string, _l: boolean, app: string) => { apps.push(app); up = true }
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-')), bundle = path.join(ext, 'dist', 'app', 'app.js')
    const stage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stage-')), 'app')
    fs.mkdirSync(path.join(path.dirname(bundle), 'webview'), { recursive: true })
    fs.writeFileSync(bundle, 'v1')
    fs.writeFileSync(path.join(path.dirname(bundle), 'webview', 'index.js'), 'ui1')
    const go = () => { up = false; return ensureWeb(appDir(), false, { find, start, bundle, stage, tries: 2, waitMs: 1, pidFile: pidFile() }) }
    await go()
    assert.deepEqual(apps, [path.join(stage, 'app.js')])
    fs.utimesSync(path.join(stage, 'app.js'), 1, 1)
    await go()
    assert.equal(fs.statSync(path.join(stage, 'app.js')).mtimeMs, 1000, 'same bundle: not copied again')
    fs.writeFileSync(path.join(path.dirname(bundle), 'webview', 'index.js'), 'ui2')
    await go()
    assert.equal(fs.readFileSync(path.join(stage, 'webview', 'index.js'), 'utf8'), 'ui2')
    // VS Code drops the old version folder after an update; the copy keeps serving.
    fs.rmSync(ext, { recursive: true })
    assert.equal(fs.readFileSync(path.join(stage, 'app.js'), 'utf8'), 'v1')
  })
  it('starts the app once, waits for it, and gives up after a while', async () => {
    let starts = 0
    let up = false
    const find = async () => (up ? 'http://127.0.0.1:3131' : null)
    const root = appDir(), file = pidFile()
    const both = await Promise.all([ensureWeb(root, false, { find, start: () => { starts++; setTimeout(() => { up = true }, 20) }, tries: 50, waitMs: 5, pidFile: file }), ensureWeb(root, false, { find, start: () => { starts++ }, tries: 50, waitMs: 5, pidFile: file })])
    assert.deepEqual(both, [{ url: 'http://127.0.0.1:3131' }, { url: 'http://127.0.0.1:3131' }])
    assert.equal(starts, 1)
    const never = await ensureWeb(root, false, { find: async () => null, start: () => {}, tries: 1, waitMs: 3, pidFile: file })
    assert.ok('problem' in never)
  })
  it('starts with --lan only for Phone, and keeps the pid of every start', async () => {
    const lans: boolean[] = []
    let up = false
    const find = async () => (up ? 'http://127.0.0.1:3131' : null)
    const start = (_r: string, lan: boolean) => { lans.push(lan); up = true; return 1234 }
    const file = pidFile()
    await ensureWeb(appDir(), false, { find, start, tries: 3, waitMs: 1, pidFile: file })
    assert.equal(fs.readFileSync(file, 'utf8'), '1234')
    up = false
    await ensureWeb(appDir(), true, { find, start, tries: 3, waitMs: 1, pidFile: file })
    assert.deepEqual(lans, [false, true])
    assert.equal(fs.readFileSync(file, 'utf8'), '1234')
  })
  it('restarts our app only for a newer version than its copy, keeping --lan; an older window, a hand-run app or a held lock leave it', async () => {
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-')), bundle = path.join(ext, 'dist', 'app', 'app.js')
    const stage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stage-')), 'app')
    fs.mkdirSync(path.dirname(bundle), { recursive: true })
    fs.writeFileSync(bundle, 'v2')
    fs.mkdirSync(stage, { recursive: true })
    fs.writeFileSync(path.join(stage, 'app.js'), 'v1')
    fs.writeFileSync(`${stage}.version`, '0.1.0')
    const file = pidFile()
    fs.writeFileSync(file, '42')
    let up = true, listening = 42
    const stopped: number[] = [], lans: boolean[] = []
    const deps = (version: string, refresh = true) => ({
      find: async () => (up ? 'http://127.0.0.1:3131' : null),
      start: (_r: string, l: boolean) => { lans.push(l); up = true; listening = 43; return 43 },
      stop: (pid: number) => { stopped.push(pid); up = false },
      lan: async () => 'http://100.1.2.3:3131/?k=x', listeners: async () => (up ? [listening] : []),
      bundle, stage, version, refresh, tries: 3, waitMs: 1, pidFile: file,
    })
    await ensureWeb(appDir(), false, deps('0.1.0'))
    assert.deepEqual(stopped, [], 'same version')
    // Another window holds the restart.
    fs.writeFileSync(`${stage}.lock`, '1')
    await ensureWeb(appDir(), false, deps('0.2.0'))
    assert.deepEqual(stopped, [], 'locked')
    fs.utimesSync(`${stage}.lock`, 1, 1)
    assert.deepEqual(await ensureWeb(appDir(), false, deps('0.2.0')), { url: 'http://127.0.0.1:3131' })
    assert.deepEqual({ stopped, lans }, { stopped: [42], lans: [true] }, 'a stale lock is taken over')
    assert.equal(fs.readFileSync(path.join(stage, 'app.js'), 'utf8'), 'v2')
    assert.equal(fs.readFileSync(`${stage}.version`, 'utf8'), '0.2.0')
    assert.equal(fs.readFileSync(file, 'utf8'), '43')
    assert.equal(fs.existsSync(`${stage}.lock`), false)
    // A window still on the old version: neither a refresh nor Open in browser downgrades it.
    await ensureWeb(appDir(), false, deps('0.1.0'))
    await ensureWeb(appDir(), false, deps('0.1.0', false))
    assert.deepEqual(stopped, [42])
    fs.writeFileSync(file, '7')
    await ensureWeb(appDir(), false, deps('0.3.0'))
    assert.deepEqual(stopped, [42], 'not ours: left alone')
  })
  it('a newer version with the same app files only records the version, and Phone waits on a held lock', async () => {
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-')), bundle = path.join(ext, 'dist', 'app', 'app.js')
    const stage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stage-')), 'app')
    fs.mkdirSync(path.dirname(bundle), { recursive: true })
    fs.writeFileSync(bundle, 'same')
    fs.cpSync(path.dirname(bundle), stage, { recursive: true })
    const file = pidFile()
    fs.writeFileSync(file, '42')
    let up = true
    const stopped: number[] = []
    const deps = (version: string, lanLink: string | null) => ({
      find: async () => (up ? 'http://127.0.0.1:3131' : null), start: () => { up = true; return 43 },
      stop: (pid: number) => { stopped.push(pid); up = false }, lan: async () => lanLink, listeners: async () => (up ? [42] : []),
      bundle, stage, version, tries: 3, waitMs: 1, pidFile: file,
    })
    for (let i = 0; i < 3; i++) await ensureWeb(appDir(), false, { ...deps('0.2.0', null), refresh: true })
    assert.deepEqual(stopped, [])
    assert.equal(fs.readFileSync(`${stage}.version`, 'utf8'), '0.2.0')
    fs.writeFileSync(`${stage}.lock`, '1')
    await ensureWeb(appDir(), true, deps('0.2.0', null))
    assert.deepEqual(stopped, [], 'another window is restarting')
    fs.rmSync(`${stage}.lock`)
  })
  it('knows our app by the copy it runs from when the pid file is missing; a hand-run app is still left alone', async () => {
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-ext-')), bundle = path.join(ext, 'dist', 'app', 'app.js')
    const stage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-stage-')), 'app')
    fs.mkdirSync(path.dirname(bundle), { recursive: true })
    fs.writeFileSync(bundle, 'new')
    fs.mkdirSync(stage, { recursive: true })
    fs.writeFileSync(path.join(stage, 'app.js'), 'old')
    let up = true
    const stopped: number[] = []
    const run = (cmd: string) => ensureWeb(appDir(), false, {
      find: async () => (up ? 'http://127.0.0.1:3131' : null), start: () => { up = true; return 43 },
      stop: (pid: number) => { stopped.push(pid); up = false }, lan: async () => null, listeners: async () => (up ? [60] : []),
      command: async () => cmd, bundle, stage, version: '0.2.0', refresh: true, tries: 3, waitMs: 1, pidFile: pidFile(),
    })
    await run('node /Users/k/agent-flow/app/dist/app.js -p 3131')
    assert.deepEqual(stopped, [])
    await run(`Code Helper (Plugin) ${path.join(stage, 'app.js')} -p 3131 --no-open --lan`)
    assert.deepEqual(stopped, [60])
  })
  it('a click during a refresh gets its own answer', async () => {
    let up = false, starts = 0
    const file = pidFile()
    const slow = async () => { await new Promise(r => setTimeout(r, 10)); return up ? 'http://127.0.0.1:3131' : null }
    const [refreshed, clicked] = await Promise.all([
      ensureWeb(appDir(), false, { find: slow, start: () => { starts++ }, refresh: true, pidFile: file }),
      ensureWeb(appDir(), false, { find: slow, start: () => { starts++; up = true }, tries: 3, waitMs: 1, pidFile: file }),
    ])
    assert.ok('problem' in refreshed)
    assert.deepEqual({ clicked, starts }, { clicked: { url: 'http://127.0.0.1:3131' }, starts: 1 })
  })
  it('a refresh never starts an app that is not running', async () => {
    let starts = 0
    const r = await ensureWeb(appDir(), false, { find: async () => null, start: () => { starts++ }, refresh: true, pidFile: pidFile() })
    assert.equal(starts, 0)
    assert.ok('problem' in r)
  })
  it('Phone restarts our app with --lan, even after a window reload, only while that pid is the one on the port', async () => {
    let up = true
    const lans: boolean[] = [], stopped: number[] = []
    const file = pidFile()
    const deps = (listening: number[]) => ({
      find: async () => (up ? 'http://127.0.0.1:3131' : null),
      start: (_r: string, l: boolean) => { lans.push(l); up = true; return 43 },
      stop: (pid: number) => { stopped.push(pid); up = false },
      lan: async () => null, listeners: async (port: string) => (port === '3131' && up ? listening : []),
      tries: 3, waitMs: 1, pidFile: file,
    })
    const root = appDir()
    // An earlier window started 42; only the file remembers it.
    fs.writeFileSync(file, '42')
    // pid gone or reused by something else: not ours, left alone
    assert.deepEqual(await ensureWeb(root, true, deps([99])), { url: 'http://127.0.0.1:3131' })
    assert.deepEqual(stopped, [])
    assert.deepEqual(await ensureWeb(root, true, deps([42])), { url: 'http://127.0.0.1:3131' })
    assert.deepEqual(stopped, [42])
    assert.deepEqual(lans, [true])
    assert.equal(fs.readFileSync(file, 'utf8'), '43')
  })
  it('Phone restart waits on our pid leaving the port, not on find, which falls back to another app on 3001', async () => {
    let ours: 'up' | 'down' | 'lan' = 'up'
    const stopped: number[] = [], started: boolean[] = []
    const file = pidFile()
    fs.writeFileSync(file, '42')
    const r = await ensureWeb(appDir(), true, {
      find: async () => (ours === 'down' ? 'http://127.0.0.1:3001' : 'http://127.0.0.1:3131'),
      start: (_r, lan) => { started.push(lan); setTimeout(() => { ours = 'lan' }, 5); return 43 },
      stop: p => { stopped.push(p); ours = 'down' },
      lan: async () => null,
      listeners: async p => (p === '3131' && ours === 'up' ? [42] : p === '3001' ? [777] : []),
      pidFile: file, tries: 20, waitMs: 2,
    })
    assert.deepEqual({ r, stopped, started }, { r: { url: 'http://127.0.0.1:3131' }, stopped: [42], started: [true] })
  })
  it('Phone leaves an app started by hand running', async () => {
    const stopped: number[] = []
    const r = await ensureWeb(appDir(), true, { find: async () => 'http://127.0.0.1:3131', start: () => 7, stop: p => { stopped.push(p) }, lan: async () => null, listeners: async () => [7], pidFile: pidFile() })
    assert.deepEqual(r, { url: 'http://127.0.0.1:3131' })
    assert.deepEqual(stopped, [])
  })
  it('gives a phone link per network, from the current addresses, only for the running --lan app', async () => {
    const lan = async () => 'http://0.0.0.0:3131', secret = async () => 'abc'
    const ips = () => ['100.101.2.3', '192.168.1.103'], none = () => ({})
    const code = phoneCode('abc')
    assert.match(code, /^\d{6}$/)
    assert.deepEqual(await phoneUrls('http://127.0.0.1:3131', lan, secret, ips, none), { wifi: 'http://192.168.1.103:3131/?k=abc', tailscale: 'http://100.101.2.3:3131/?k=abc', code })
    assert.deepEqual(await phoneUrls('http://127.0.0.1:3131', lan, secret, () => ['192.168.1.103'], none), { wifi: 'http://192.168.1.103:3131/?k=abc', code })
    assert.deepEqual(await phoneUrls('http://127.0.0.1:3131', lan, secret, () => [], none), {})
    assert.deepEqual(await phoneUrls('http://127.0.0.1:3131', lan, async () => undefined, ips, none), {})
    assert.equal(await phoneUrls('http://127.0.0.1:3001', lan, secret, ips), null)
    assert.equal(await phoneUrls(null, lan, secret, ips), null)
    assert.equal(await phoneUrls('http://127.0.0.1:3131', async () => undefined, secret, ips), null)
  })
  it('adds the Mac names next to the addresses, which stay put when the IP changes', async () => {
    const lan = async () => 'http://0.0.0.0:3131', secret = async () => 'abc', code = phoneCode('abc')
    const ips = () => ['100.101.2.3', '192.168.1.103']
    const names = () => ({ wifi: 'kennys-mbp.local', tailscale: 'kennys-mbp.tail1234.ts.net' })
    assert.deepEqual(await phoneUrls('http://127.0.0.1:3131', lan, secret, ips, names), {
      wifi: 'http://192.168.1.103:3131/?k=abc', tailscale: 'http://100.101.2.3:3131/?k=abc', code,
      wifiName: 'http://kennys-mbp.local:3131/?k=abc', tailscaleName: 'http://kennys-mbp.tail1234.ts.net:3131/?k=abc',
    })
    // A name without its network's address is offered anyway: tailscale may be up before an address shows.
    assert.deepEqual(await phoneUrls('http://127.0.0.1:3131', lan, secret, () => [], () => ({ wifi: 'kennys-mbp.local' })), { wifiName: 'http://kennys-mbp.local:3131/?k=abc', code })
    assert.equal(await phoneUrls('http://127.0.0.1:3001', lan, secret, ips, names), null)
  })
  it('answers the app the browser can use: the announced one, then 3001, never the dev web or 3000', async () => {
    const up = new Set(['http://127.0.0.1:3001'])
    assert.equal(await webUrl(async u => up.has(u), async () => undefined), 'http://127.0.0.1:3001')
    up.add('http://127.0.0.1:3131')
    assert.equal(await webUrl(async u => up.has(u), async () => 'http://127.0.0.1:3131'), 'http://127.0.0.1:3131')
    assert.equal(await webUrl(async () => false, async () => 'http://127.0.0.1:3131'), null)
    // web.url left by a copy that has since gone: the app on 3131 is still found.
    assert.equal(await webUrl(async u => u === 'http://127.0.0.1:3131', async () => 'http://127.0.0.1:3150'), 'http://127.0.0.1:3131')
    const asked: string[] = []
    await webUrl(async u => { asked.push(u); return false }, async () => 'http://127.0.0.1:3000')
    assert.ok(asked.every(u => !u.includes(':3000') && !u.includes(':3010')))
  })
  it('counts only a page with live data, not the sample-data dev web', async () => {
    const server = http.createServer((req, res) => {
      if (req.url === '/hub/state' && req.headers['x-switchboard'] === '1') res.writeHead(200, { 'content-type': 'application/json' }).end('{}')
      else res.writeHead(404).end()
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    try {
      assert.equal(await servesLive(url), true)
      assert.equal(await servesLive(url + '/nope'), false)
    } finally { server.close() }
  })
})

describe('terminal keybinding', () => {
  it('adds the open command to commandsToSkipShell once, keeping what is there', () => {
    assert.deepEqual(withSkipShell(undefined, 'agentVisualizer.open'), ['agentVisualizer.open'])
    assert.deepEqual(withSkipShell(['a.b'], 'agentVisualizer.open'), ['a.b', 'agentVisualizer.open'])
    assert.equal(withSkipShell(['agentVisualizer.open'], 'agentVisualizer.open'), undefined)
    // The user took it out on purpose.
    assert.equal(withSkipShell(['-agentVisualizer.open'], 'agentVisualizer.open'), undefined)
    assert.equal(withSkipShell('junk', 'agentVisualizer.open'), undefined)
  })
})
