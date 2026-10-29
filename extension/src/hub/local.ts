/**
 * What the Hub reads off this machine: the newest plan, dev servers, git,
 * installed plugins and skills, and connections. The parsers are pure
 * (tested); the readers run a command or read a file and never throw.
 */
import { execFile, spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ChangedFile, Connection, GitState, Installed, PlanView, Server } from './types'
import { DEFAULT_RELAY_PORT } from '../constants'
import { modelOf } from './roles'
import { newerVersion } from './self-update'

const HOME = os.homedir()
const CLAUDE = path.join(HOME, '.claude')
// Runtimes that serve dev work; Discord, OneDrive, the editor and the like are left out.
const DEV = /^(node|python[\d.]*|bun|deno|ruby|php|uvicorn|gunicorn)$/i

export function run(file: string, args: string[], timeoutMs = 5000): Promise<string> {
  return new Promise(resolve => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 << 20, windowsHide: true }, (err, stdout) => resolve(err && !stdout ? '' : String(stdout)))
  })
}

async function readJson(file: string): Promise<Record<string, unknown> | undefined> {
  try { return JSON.parse(await fs.promises.readFile(file, 'utf8')) } catch { return undefined }
}

// ─── Plan ────────────────────────────────────────────────────────────────────

const plain = (s: string) => s.replace(/\*\*|__|`/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\s+/g, ' ').trim().slice(0, 120)

export function parsePlan(name: string, text: string): PlanView {
  const tasks: PlanView['tasks'] = []
  const decisions: string[] = []
  let inDecisions = false
  for (const row of text.split('\n')) {
    // ponytail: a decision is a list item or table row under a "## Decisions" heading; other layouts are missed.
    if (/^##\s/.test(row)) { inDecisions = /^##\s+Decisions/i.test(row); continue }
    if (/^###\s+Task\s/.test(row)) inDecisions = false
    if (inDecisions) {
      const cells = row.startsWith('|') ? row.split('|').slice(1, -1).map(c => c.trim()) : []
      if (cells.length >= 2 && !/^-+$/.test(cells[0]) && cells[0] !== 'Question') decisions.push(plain(`${cells[0]}: ${cells[1]}`))
      const item = /^\s*(?:[-*]|\d+[.)])\s+(.+)$/.exec(row)
      if (item && !/^\[( |x|X)\]/.test(item[1])) decisions.push(plain(item[1]))
      continue
    }
    const head = /^###\s+Task\s+(\d+):\s*(.+)$/.exec(row)
    if (head) { tasks.push({ title: `${head[1]} ${head[2].trim()}`, done: 0, total: 0 }); continue }
    const box = /^\s*- \[( |x|X)\]/.exec(row)
    const task = tasks[tasks.length - 1]
    if (box && task) { task.total += 1; if (box[1] !== ' ') task.done += 1 }
  }
  return decisions.length ? { name, tasks, decisions: decisions.slice(-5) } : { name, tasks }
}

/** The plan most recently changed under docs/superpowers/plans in the window's folder. */
/** The newest plan in <folder>/docs/superpowers/plans by mtime, as an absolute path. */
export async function newestPlanFile(folder: string): Promise<string | undefined> {
  const dir = path.join(folder, 'docs', 'superpowers', 'plans')
  let names: string[] = []
  try { names = (await fs.promises.readdir(dir)).filter(n => n.endsWith('.md')) } catch { return undefined }
  let newest: { file: string; mtime: number } | undefined
  for (const name of names) {
    const file = path.join(dir, name)
    const st = await fs.promises.stat(file).catch(() => undefined)
    if (st && (!newest || st.mtimeMs > newest.mtime)) newest = { file, mtime: st.mtimeMs }
  }
  return newest?.file
}

export async function newestPlan(workspace: string | undefined): Promise<PlanView | null> {
  const file = workspace ? await newestPlanFile(workspace) : undefined
  return file ? parsePlan(path.basename(file), await fs.promises.readFile(file, 'utf8')) : null
}

// ─── Dev servers ─────────────────────────────────────────────────────────────

export function parseLsof(out: string): Omit<Server, 'folder'>[] {
  const found: Omit<Server, 'folder'>[] = []
  let pid = 0
  let command = ''
  for (const row of out.split('\n')) {
    if (row.startsWith('p')) pid = Number(row.slice(1))
    else if (row.startsWith('c')) command = row.slice(1)
    else if (row.startsWith('n')) {
      const port = Number(/:(\d+)$/.exec(row)?.[1])
      if (port && DEV.test(command) && !found.some(s => s.port === port)) found.push({ pid, command, port })
    }
  }
  return found.sort((a, b) => a.port - b.port)
}

export function parseNetstat(netstat: string, tasklistCsv: string): Omit<Server, 'folder'>[] {
  const names = new Map<number, string>()
  for (const row of tasklistCsv.split(/\r?\n/).slice(1)) {
    const cells = row.split('","').map(c => c.replace(/^"|"$/g, ''))
    if (cells.length > 1) names.set(Number(cells[1]), cells[0].replace(/\.exe$/i, ''))
  }
  const found: Omit<Server, 'folder'>[] = []
  for (const row of netstat.split(/\r?\n/)) {
    const m = /^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(row)
    if (!m) continue
    const port = Number(m[1]), pid = Number(m[2]), command = names.get(pid) ?? ''
    if (DEV.test(command) && !found.some(s => s.port === port)) found.push({ pid, command, port })
  }
  return found.sort((a, b) => a.port - b.port)
}

const lastTwo = (p: string) => p.split(/[\\/]/).filter(Boolean).slice(-2).join('/')

export async function listServers(): Promise<Server[]> {
  if (process.platform === 'win32') {
    const list = parseNetstat(await run('netstat', ['-ano', '-p', 'tcp']), await run('tasklist', ['/fo', 'csv']))
    return list.map(s => ({ ...s, folder: '' }))
  }
  const list = parseLsof(await run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-F', 'pcn']))
  for (const pid of serverFolders.keys()) if (!list.some(s => s.pid === pid)) serverFolders.delete(pid)
  return Promise.all(list.map(async s => {
    let cwd = serverFolders.get(s.pid)
    if (cwd === undefined) {
      const out = await run('lsof', ['-a', '-p', String(s.pid), '-d', 'cwd', '-Fn'])
      cwd = out.split('\n').find(l => l.startsWith('n'))?.slice(1) ?? ''
      serverFolders.set(s.pid, cwd)
    }
    return { ...s, folder: lastTwo(cwd), ...(cwd ? { cwd } : {}) }
  }))
}
// A server's cwd by pid: asked once per process, not on every refresh.
const serverFolders = new Map<number, string>()

// ─── Git ─────────────────────────────────────────────────────────────────────

export function parseGitStatus(out: string): GitState {
  const state: GitState = { changed: 0, staged: 0, untracked: 0 }
  for (const row of out.split('\n')) {
    if (row.startsWith('# branch.head ')) state.branch = row.slice(14).trim()
    else if (row.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(row)
      if (m) { state.ahead = Number(m[1]); state.behind = Number(m[2]) }
    } else if (row.startsWith('1 ') || row.startsWith('2 ') || row.startsWith('u ')) {
      state.changed += 1
      if (row[2] !== '.') state.staged += 1
    } else if (row.startsWith('? ')) state.untracked += 1
  }
  return state
}

export async function gitState(workspace: string | undefined): Promise<GitState | null> {
  if (!workspace) return null
  const out = await run('git', ['-C', workspace, 'status', '--porcelain=v2', '--branch'])
  return out ? parseGitStatus(out) : null
}

// ─── A chat's changes ────────────────────────────────────────────────────────

const DIFF_LINES = 300
const DIFF_BYTES = 24 * 1024
const FILES_MAX = 60
const UNTRACKED_BYTES = 256 * 1024

/** A relative path that stays inside the chat's folder. */
export function insideCwd(cwd: string, file: string): boolean {
  if (!file || path.isAbsolute(file)) return false
  const full = path.resolve(cwd, file)
  return full.startsWith(path.resolve(cwd) + path.sep)
}

const capped = (lines: string[]): Pick<ChangedFile, 'diff' | 'note'> => {
  const text = lines.join('\n')
  return lines.length > DIFF_LINES || text.length > DIFF_BYTES
    ? { note: `This diff is too big to show here (${lines.length} lines). Open it in VS Code.` }
    : { diff: text }
}

/**
 * Each changed file from `git diff HEAD --numstat` and `git diff HEAD` (run with --relative in the
 * chat's folder), then the untracked files; diffs start at the first hunk and are capped.
 */
export function parseChanges(numstat: string, diff: string, untracked: { path: string; text?: string; binary?: boolean; link?: boolean }[]): ChangedFile[] {
  // Keyed by the whole header: with --no-renames it is `a/<path> b/<path>`, looked up by numstat's path, so " b/" in a name cannot split it.
  const parts = new Map<string, { head: string[]; body: string[] }>()
  let cur: { head: string[]; body: string[] } | undefined
  for (const row of diff.split('\n')) {
    if (row.startsWith('diff --git ')) { cur = { head: [], body: [] }; parts.set(row.slice(11), cur); continue }
    if (!cur) continue
    if (cur.body.length || row.startsWith('@@')) cur.body.push(row)
    else cur.head.push(row)
  }
  const files: ChangedFile[] = []
  for (const row of numstat.split('\n')) {
    const m = /^(-|\d+)\t(-|\d+)\t(.+)$/.exec(row)
    if (!m) continue
    const file = m[3], part = parts.get(`a/${file} b/${file}`), head = part?.head ?? []
    const status = head.some(h => h.startsWith('new file')) ? 'added' : head.some(h => h.startsWith('deleted file')) ? 'deleted' : 'modified'
    const binary = m[1] === '-' || head.some(h => h.startsWith('Binary files'))
    const body = part?.body ?? []
    while (body.length && body[body.length - 1] === '') body.pop()
    files.push({ path: file, added: Number(m[1]) || 0, removed: Number(m[2]) || 0, status, ...(binary ? { note: 'Binary file: no text diff.' } : capped(body)) })
  }
  for (const u of untracked) {
    if (u.link) { files.push({ path: u.path, added: 0, removed: 0, status: 'untracked', note: 'Symlink, or a path that leads outside this folder: not shown.' }); continue }
    if (u.binary || u.text === undefined) { files.push({ path: u.path, added: 0, removed: 0, status: 'untracked', note: u.binary ? 'Binary file: no text diff.' : 'This file is too big to show here. Open it in VS Code.' }); continue }
    const lines = u.text.replace(/\n$/, '').split('\n')
    files.push({ path: u.path, added: lines.length, removed: 0, status: 'untracked', ...capped(lines.map(l => `+${l}`)) })
  }
  return files.filter(f => insideCwd('/c', f.path)).slice(0, FILES_MAX)
}

/**
 * The file's real path when it is a plain file (no symlink at the end) whose real path stays inside the folder's
 * real path, so a link in the path never leads out; undefined otherwise. Check this before reading or opening one.
 */
export async function safeFile(cwd: string, file: string): Promise<string | undefined> {
  if (!insideCwd(cwd, file)) return undefined
  try {
    const full = path.join(cwd, file)
    if ((await fs.promises.lstat(full)).isSymbolicLink()) return undefined
    const [real, root] = await Promise.all([fs.promises.realpath(full), fs.promises.realpath(cwd)])
    return real.startsWith(root + path.sep) ? real : undefined
  } catch { return undefined }
}

/** The uncommitted changes in a chat's folder, tracked and untracked, only below that folder. */
export async function readChanges(cwd: string): Promise<ChangedFile[]> {
  const git = (...args: string[]) => run('git', ['-C', cwd, '-c', 'core.quotePath=false', ...args], 10000)
  const [numstat, diff, others] = await Promise.all([
    git('diff', 'HEAD', '--relative', '--no-renames', '--numstat'),
    git('diff', 'HEAD', '--relative', '--no-renames', '--no-color', '--no-ext-diff'),
    git('ls-files', '--others', '--exclude-standard'),
  ])
  const untracked = await Promise.all(others.split('\n').filter(f => f && insideCwd(cwd, f)).slice(0, FILES_MAX).map(async f => {
    try {
      const full = await safeFile(cwd, f)
      if (!full) return { path: f, link: true }
      if ((await fs.promises.stat(full)).size > UNTRACKED_BYTES) return { path: f }
      const buf = await fs.promises.readFile(full)
      return buf.includes(0) ? { path: f, binary: true } : { path: f, text: buf.toString('utf8') }
    } catch { return { path: f } }
  }))
  return parseChanges(numstat, diff, untracked)
}

// ─── The browser version ─────────────────────────────────────────────────────

// The standalone app (app/) is the only browser page with live data; it writes its address to web.url.
// The dev web (next dev) only ever shows sample data, and port 3000 belongs to another project.
const WEB_FILE = path.join(os.homedir(), '.claude', 'switchboard', 'web.url')
const announced = async () => (await fs.promises.readFile(WEB_FILE, 'utf8').catch(() => '')).trim() || undefined

/** True when the address answers /hub/state the way the app's own page asks for it. */
export async function servesLive(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${url}/hub/state`, { headers: { 'x-switchboard': '1' }, signal: AbortSignal.timeout(800) })
    return r.ok && (r.headers.get('content-type') ?? '').includes('json')
  } catch { return false }
}

/** The first address with Switchboard's live page, or null when the app is not running. */
export async function webUrl(probe = servesLive, read = announced): Promise<string | null> {
  const urls = [await read(), `http://127.0.0.1:${DEFAULT_RELAY_PORT}`].filter((u): u is string => !!u && !/:(3000|3010)$/.test(u))
  for (const url of new Set(urls)) if (await probe(url)) return url
  return null
}

const LAN_FILE = path.join(os.homedir(), '.claude', 'switchboard', 'web.lan')
const port = (u: string) => { try { return new URL(u).port } catch { return '' } }

/** The app's phone link with its secret (app --lan writes it), only when it belongs to the running app. */
export async function phoneUrl(web: string | null, read = async () => (await fs.promises.readFile(LAN_FILE, 'utf8').catch(() => '')).trim() || undefined): Promise<string | null> {
  const lan = web ? await read() : undefined
  return lan && port(lan) === port(web!) ? lan : null
}

// VS Code's own binary runs as plain node (ELECTRON_RUN_AS_NODE), so no node on PATH is needed.
// Detached so the app outlives VS Code.
// ponytail: the app reads its Wi-Fi and Tailscale addresses once at start; after a Wi-Fi change or joining Tailscale, restart the app and press Phone.
// The app's folder is its workspace; a computer with only the vsix has no checkout, so home then.
function spawnApp(root: string, lan: boolean, app: string): number | undefined {
  const child = spawn(process.execPath, [app, '-p', '3131', '--no-open', ...(lan ? ['--lan'] : [])], {
    cwd: fs.existsSync(root) ? root : HOME, detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  child.unref()
  return child.pid
}

const STAGE = path.join(os.homedir(), '.claude', 'switchboard', 'app')
const files = (dir: string) => (fs.readdirSync(dir, { recursive: true }) as string[]).filter(f => fs.statSync(path.join(dir, f)).isFile()).sort()
const sameTree = (a: string, b: string) => {
  try {
    const fa = files(a)
    return fa.join('\n') === files(b).join('\n') && fa.every(f => fs.readFileSync(path.join(a, f)).equals(fs.readFileSync(path.join(b, f))))
  } catch { return false }
}

/** The bundled app copied out of the versioned extension folder, which VS Code deletes after an update while the
 * detached app still serves its webview files from disk. Copied again only when the bundle differs.
 * ponytail: a running app keeps its old server code until it is restarted; only a fresh start picks up the copy. */
function stageApp(bundle: string, stage: string, version?: string): string {
  const src = path.dirname(bundle)
  // A window still on an older version never copies over a newer one.
  if (!(version && newerVersion(stagedVersion(stage) ?? '0', version)) && !sameTree(src, stage)) {
    fs.rmSync(stage, { recursive: true, force: true })
    fs.cpSync(src, stage, { recursive: true })
    if (version) fs.writeFileSync(`${stage}.version`, version)
  }
  return path.join(stage, path.basename(bundle))
}
// Beside the copy, not in it, so sameTree still compares only the bundle's files.
const stagedVersion = (stage: string) => { try { return fs.readFileSync(`${stage}.version`, 'utf8').trim() || undefined } catch { return undefined } }

/** One restart across windows: they all activate at once after an update. A lock older than a minute is left over. */
function lockRestart(stage: string): (() => void) | undefined {
  const lock = `${stage}.lock`
  try { fs.mkdirSync(path.dirname(lock), { recursive: true }); fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }) } catch {
    try { if (Date.now() - fs.statSync(lock).mtimeMs < 60_000) return undefined; fs.writeFileSync(lock, String(process.pid)) } catch { return undefined }
  }
  return () => fs.rmSync(lock, { force: true })
}

let starting: { p: Promise<{ url: string } | { problem: string }>; refresh: boolean } | undefined
// The app this extension started, so Phone or an update may restart it. A file, so it survives reloads and every
// window sees it. An app started by hand is never in it and is left alone.
const PID_FILE = path.join(os.homedir(), '.claude', 'switchboard', 'app.pid')
// Listening pids on a port. A pid that is gone or was reused by something else is not here.
const portListeners = async (p: string) => (await run('lsof', ['-nP', `-iTCP:${p}`, '-sTCP:LISTEN', '-t'])).split('\n').filter(Boolean).map(Number)

type WebDeps = {
  find?: () => Promise<string | null>
  start?: (root: string, lan: boolean, app: string) => number | undefined | void
  /** The app.js shipped in the vsix (dist/app); the checkout's build is the fallback. */
  bundle?: string
  /** Where the bundled app is copied to and run from. */
  stage?: string
  stop?: (pid: number) => void
  lan?: (web: string) => Promise<string | null>
  listeners?: (port: string) => Promise<number[]>
  pidFile?: string
  tries?: number
  waitMs?: number
  /** Only restart our running app when this version is newer than its copy's; never start one. */
  refresh?: boolean
  /** This extension's version; the copy records the one it came from. */
  version?: string
  command?: (pid: number) => Promise<string>
}

/** The app's address, started in the background from root first when it is not running. One start at a time.
 * phone starts it with --lan, restarting an app this extension started without it. Our app running an older
 * copy than the bundle is restarted, keeping --lan, so an update reaches the browser and the phone. */
export function ensureWeb(root: string, phone = false, deps: WebDeps = {}): Promise<{ url: string } | { problem: string }> {
  const { find = () => webUrl(), start = spawnApp, stop = (pid: number) => process.kill(pid), lan = (w: string) => phoneUrl(w),
    listeners = portListeners, pidFile = PID_FILE, tries = 25, waitMs = 200, bundle, stage = STAGE, refresh = false, version, command = (pid: number) => run('ps', ['-o', 'command=', '-p', String(pid)]) } = deps
  const wait = async (done: () => Promise<boolean>) => {
    for (let i = 0; i < tries; i++) {
      await new Promise(r => setTimeout(r, waitMs))
      if (await done()) return true
    }
    return false
  }
  // Ours: the pid file's pid, else a listener running our copy (an app started before the pid file covered --lan).
  const ours = async (url: string) => {
    const pid = Number(await fs.promises.readFile(pidFile, 'utf8').catch(() => ''))
    const on = await listeners(port(url))
    if (pid > 0 && on.includes(pid)) return pid
    const app = ` ${path.join(stage, 'app.js')} `
    for (const p of on) if (` ${await command(p)} `.includes(app)) return p
    return undefined
  }
  const remember = (pid: number | undefined) => {
    try {
      if (pid) { fs.mkdirSync(path.dirname(pidFile), { recursive: true }); fs.writeFileSync(pidFile, String(pid)) } else fs.rmSync(pidFile, { force: true })
    } catch { /* Phone then shows the stop message */ }
  }
  // A click never takes a refresh's answer: it waits for it, then asks again.
  if (starting?.refresh && !refresh) return starting.p.then(() => ensureWeb(root, phone, deps))
  if (starting) return starting.p
  let unlock: (() => void) | undefined
  const p = (async () => {
    let running = await find()
    if (!running && refresh) return { problem: 'the browser app is not running' }
    let restart: string | undefined
    const hasLan = !!running && !!(await lan(running))
    let stale = false
    if (running && version && bundle && fs.existsSync(bundle) && newerVersion(version, stagedVersion(stage))) {
      stale = !sameTree(path.dirname(bundle), stage)
      // Same app files: only the label moves on, no restart.
      if (!stale) try { fs.writeFileSync(`${stage}.version`, version) } catch { /* checked again next time */ }
    }
    let pid = running && ((phone && !hasLan) || stale) ? await ours(running) : undefined
    if (pid && !(unlock = lockRestart(stage))) pid = undefined
    if (refresh && !pid) return { url: running! }
    const lanNow = phone || hasLan
    if (pid) {
      try { stop(pid) } catch { /* already gone */ }
      remember(undefined)
      // Not find(): it falls back to whatever answers on 3001.
      const p = port(running!)
      if (!(await wait(async () => !(await listeners(p)).includes(pid)))) return { problem: 'the browser app did not stop for the phone restart' }
      restart = p
      running = null
    }
    if (running) return { url: running }
    const built = path.join(root, 'app', 'dist', 'app.js')
    let app = built
    // A failed copy falls back to the checkout's build.
    if (bundle && fs.existsSync(bundle)) try { app = stageApp(bundle, stage, version) } catch { /* checkout */ }
    if (!fs.existsSync(app)) return { problem: `the browser app is not built: ${built} is missing. Run pnpm build:app in ${root}` }
    const started = start(root, lanNow, app)
    remember(started || undefined)
    let url: string | null = null
    // After a restart, only our port counts.
    if (await wait(async () => !!(url = await find()) && (!restart || port(url) === restart))) return { url: url! }
    return { problem: 'the browser app did not start on port 3131' }
  })().finally(() => { starting = undefined; unlock?.() })
  starting = { p, refresh }
  return p
}

// ─── Installed and connections ───────────────────────────────────────────────

async function skillName(dir: string): Promise<string> {
  const text = await fs.promises.readFile(path.join(dir, 'SKILL.md'), 'utf8').catch(() => '')
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
  return /^name:\s*["']?([^"'#\r\n]+?)["']?\s*(?:#.*)?$/m.exec(front)?.[1] ?? path.basename(dir)
}

const DESC_MAX = 160
const cut = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().replace(/\s+/g, ' ').slice(0, DESC_MAX) : undefined)
/** A SKILL.md's frontmatter description, one line. */
async function skillDescription(dir: string): Promise<string | undefined> {
  const text = await fs.promises.readFile(path.join(dir, 'SKILL.md'), 'utf8').catch(() => '')
  const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? ''
  return cut(/^description:\s*["']?(.+?)["']?\s*$/m.exec(front)?.[1])
}

const paths = (v: unknown) => [v].flat().filter((d): d is string => typeof d === 'string')
const mdNames = async (dir: string) => (await fs.promises.readdir(dir).catch(() => [] as string[])).filter(n => n.endsWith('.md')).map(n => n.slice(0, -3))

/** The plugin:name entries Claude Code lists: skills in <root>/skills plus plugin.json's skills paths, and commands. */
async function pluginNames(root: string, manifest: Record<string, unknown> | undefined): Promise<string[]> {
  const out: string[] = []
  for (const dir of new Set([path.join(root, 'skills'), ...paths(manifest?.skills).map(d => path.resolve(root, d))])) {
    // A declared path can be one skill folder or a folder of them. existsSync follows symlinked skill folders.
    const folders = fs.existsSync(path.join(dir, 'SKILL.md')) ? [dir]
      : (await fs.promises.readdir(dir).catch(() => [] as string[])).filter(n => !n.startsWith('.')).map(n => path.join(dir, n))
    for (const f of folders) if (fs.existsSync(path.join(f, 'SKILL.md'))) out.push(await skillName(f))
  }
  // plugin.json commands replaces commands/: a path, a list of paths, or a map keyed by name.
  const cmds = manifest?.commands
  if (cmds && typeof cmds === 'object' && !Array.isArray(cmds)) out.push(...Object.keys(cmds))
  else for (const p of cmds ? paths(cmds).map(c => path.resolve(root, c)) : [path.join(root, 'commands')]) out.push(...(p.endsWith('.md') ? [path.basename(p, '.md')] : await mdNames(p)))
  return [...new Set(out)]
}

/** Every plugin in enabledPlugins or installed_plugins.json, with its user (else first) install folder. */
async function plugins(claude: string): Promise<{ id: string; on: boolean; dir?: string; manifest?: Record<string, unknown> }[]> {
  const enabled = ((await readJson(path.join(claude, 'settings.json')))?.enabledPlugins ?? {}) as Record<string, boolean>
  const installs = ((await readJson(path.join(claude, 'plugins', 'installed_plugins.json')))?.plugins ?? {}) as Record<string, { scope?: string; installPath?: string }[]>
  // Installed but never named in enabledPlugins counts as off.
  return Promise.all([...new Set([...Object.keys(enabled), ...Object.keys(installs)])].map(async id => {
    const entries = installs[id] ?? []
    const dir = (entries.find(e => e.scope === 'user') ?? entries[0])?.installPath
    return { id, on: enabled[id] === true, dir, manifest: dir ? await readJson(path.join(dir, '.claude-plugin', 'plugin.json')) : undefined }
  }))
}

/** MCP servers that enabled plugins bring: <root>/.mcp.json and plugin.json mcpServers (a map or a path to one). */
export async function pluginMcp(claude = CLAUDE): Promise<Connection[]> {
  const out: Connection[] = []
  const names = (v: unknown) => { const o = (v ?? {}) as Record<string, unknown>; return Object.keys((o.mcpServers ?? o) as object) }
  for (const p of await plugins(claude)) {
    if (!p.on || !p.dir) continue
    const declared = p.manifest?.mcpServers
    const files = [path.join(p.dir, '.mcp.json'), ...paths(declared).map(f => path.resolve(p.dir!, f))]
    // Inline maps, alone or mixed into an array with file paths.
    const found = (Array.isArray(declared) ? declared : [declared]).flatMap(d => d && typeof d === 'object' ? Object.keys(d) : [])
    for (const f of files) found.push(...names(await readJson(f)))
    for (const name of new Set(found)) out.push({ kind: 'mcp', name, status: 'on', detail: p.id.split('@')[0] })
  }
  return out
}

export async function installed(claude = CLAUDE): Promise<Installed[]> {
  const out: Installed[] = []
  for (const p of await plugins(claude)) {
    const skills = p.dir ? await pluginNames(p.dir, p.manifest) : []
    const description = cut(p.manifest?.description)
    out.push({ kind: p.id.endsWith('@kenneth-mods') ? 'mod' : 'plugin', name: p.id, enabled: p.on, source: p.id.split('@')[1], ...(skills.length ? { skills } : {}), ...(description ? { description } : {}) })
  }
  const list = (dir: string) => fs.promises.readdir(path.join(claude, dir)).catch(() => [] as string[])
  for (const [dir, enabled] of [['skills', true], ['skills-archive', false]] as const) {
    for (const name of await list(dir)) {
      if (name.startsWith('.') || !fs.existsSync(path.join(claude, dir, name, 'SKILL.md'))) continue
      const description = enabled ? await skillDescription(path.join(claude, dir, name)) : undefined
      out.push({ kind: 'skill', name, enabled, ...(description ? { description } : {}) })
    }
  }
  for (const f of await list('agents')) {
    if (!f.endsWith('.md')) continue
    const model = modelOf(await fs.promises.readFile(path.join(claude, 'agents', f), 'utf8').catch(() => ''))
    out.push({ kind: 'role', name: f.slice(0, -3), enabled: true, ...(model ? { model } : {}) })
  }
  for (const f of await list('jev-presets')) if (f.endsWith('.json')) out.push({ kind: 'preset', name: f.slice(0, -5), enabled: true })
  return out
}

/** -Users-k-Documents-GitHub-Armasu -> Armasu (the folder name Claude Code made from the path). */
export function decodeProjectDir(dir: string): string {
  const parts = dir.split('-').filter(Boolean)
  return parts[parts.length - 1] ?? dir
}

/** Folders to open: git repos under the roots, and every folder Claude Code has run in that still exists. */
export async function projectFolders(repoRoots: string[]): Promise<{ repos: string[]; claude: string[] }> {
  const repos: string[] = []
  for (const root of repoRoots) {
    const names = await fs.promises.readdir(root).catch(() => [] as string[])
    for (const n of names.sort((a, b) => a.localeCompare(b))) if (fs.existsSync(path.join(root, n, '.git'))) repos.push(path.join(root, n))
  }
  const global = await readJson(path.join(HOME, '.claude.json'))
  // Scratch and temp folders are where chats ran, not projects to come back to.
  const claude = Object.keys((global?.projects ?? {}) as object)
    .filter(p => p !== HOME && !/[\\/](tmp|private[\\/]tmp|var[\\/]folders)[\\/]/.test(p) && fs.existsSync(p))
  return { repos, claude }
}

export async function connections(repoRoots: string[]): Promise<Connection[]> {
  const out: Connection[] = []
  const global = await readJson(path.join(HOME, '.claude.json'))
  for (const name of Object.keys((global?.mcpServers ?? {}) as object)) out.push({ kind: 'mcp', name, status: 'on', detail: 'user' })
  for (const c of await pluginMcp()) if (!out.some(o => o.name === c.name)) out.push(c)
  for (const [proj, v] of Object.entries((global?.projects ?? {}) as Record<string, { mcpServers?: object }>)) {
    for (const name of Object.keys(v.mcpServers ?? {})) out.push({ kind: 'mcp', name, status: 'on', detail: path.basename(proj) })
  }
  let projects: string[] = []
  try { projects = await fs.promises.readdir(path.join(CLAUDE, 'projects')) } catch { /* none */ }
  for (const p of projects) if (!p.startsWith('.')) out.push({ kind: 'project', name: decodeProjectDir(p), status: 'on', detail: 'Claude Code history' })
  let windows: string[] = []
  try { windows = (await fs.promises.readdir(path.join(CLAUDE, 'switchboard'))).filter(n => n.endsWith('.json') && n !== 'workspaces.json') } catch { /* none */ }
  for (const w of windows) {
    const f = await readJson(path.join(CLAUDE, 'switchboard', w))
    if (typeof f?.workspace === 'string') out.push({ kind: 'window', name: path.basename(f.workspace), status: 'on', detail: 'Switchboard window' })
  }
  for (const root of repoRoots) {
    let names: string[] = []
    try { names = await fs.promises.readdir(root) } catch { continue }
    for (const n of names) {
      if (fs.existsSync(path.join(root, n, '.git'))) out.push({ kind: 'repo', name: n, status: 'on', detail: path.basename(root) })
    }
  }
  return out
}
