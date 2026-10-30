/**
 * The Dev button: each project's dev command, its port, its Tailscale link, and Keep awake.
 * Pure parts are tested; the readers run tailscale, ps or caffeinate and never throw.
 */
import { spawn } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { run } from './local'
import { tailscaleBin } from './lan'
import { projectName } from './projects'
import type { DevProject, Server } from './types'

const DIR = path.join(os.homedir(), '.claude', 'switchboard')
const SHIFT = 10000
// The browser app (local.ts spawnApp) runs from the agent-flow folder; it is never that project's dev server.
// ponytail: skipped by port, so a hand-run copy on another port shows as agent-flow's server; check the pid's args if that bites.
const APP_PORT = 3131

/** `<pm> run dev` when package.json has a dev script; the lockfile names the package manager. */
export function devCommand(pkg: unknown, files: string[]): string | undefined {
  const dev = (pkg as { scripts?: Record<string, unknown> } | undefined)?.scripts?.dev
  if (typeof dev !== 'string') return undefined
  const pm = files.includes('pnpm-lock.yaml') ? 'pnpm' : files.includes('yarn.lock') ? 'yarn' : files.some(f => f === 'bun.lockb' || f === 'bun.lock') ? 'bun' : 'npm'
  return `${pm} run dev`
}

const flag = (port: number, https: boolean) => `--${https ? 'https' : 'http'}=${port + SHIFT}`
// localhost, not 127.0.0.1: Vite and others listen on [::1] only, and tailscale tries both for a name.
export const serveArgs = (port: number, https: boolean) => ['serve', '--bg', flag(port, https), `http://localhost:${port}`]
export const offArgs = (port: number, https: boolean) => ['serve', flag(port, https), 'off']
export const devLink = (dns: string, port: number, https: boolean) => `${https ? 'https' : 'http'}://${dns.replace(/\.$/, '')}:${port + SHIFT}`

/** The ports `tailscale serve status --json` lists. */
export function servedPorts(json: string): Set<number> {
  try { return new Set(Object.keys(JSON.parse(json).TCP ?? {}).map(Number)) } catch { return new Set() }
}

export type Win = { pid: number; port: number; hubToken: string; workspace: string }
const inside = (dir: string, folder: string) => folder === dir || folder.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)

/** The window whose workspace is or holds the folder (the deepest one); undefined when that is this window or none holds it. */
export function devHome(wins: Win[], folder: string, self: number): Win | undefined {
  const home = wins.filter(w => inside(w.workspace, folder)).sort((a, b) => b.workspace.length - a.workspace.length)[0]
  return home && home.pid !== self ? home : undefined
}

export type Tailnet = { dns: string; https: boolean; served: Set<number> }

/** One row per folder with a dev command; running when a dev server's cwd is inside (never the app on 3131). */
export function devRows(folders: string[], read: (folder: string) => { command: string } | undefined, servers: Server[], ts: Tailnet | null): DevProject[] {
  const rows: DevProject[] = []
  for (const folder of new Set(folders)) {
    const command = read(folder)?.command
    if (!command) continue
    const port = servers.find(s => s.port !== APP_PORT && s.cwd && inside(folder, s.cwd))?.port
    const link = port && ts?.served.has(port + SHIFT) ? devLink(ts.dns, port, ts.https) : undefined
    rows.push({ folder, project: path.basename(folder), repo: projectName(folder), command, ...(port ? { port } : {}), ...(link ? { link } : {}) })
  }
  return rows
}

/** The listed row for exactly this folder; a free path from a request never matches. */
export const knownDev = (rows: DevProject[] | undefined, folder: string) => rows?.find(r => r.folder === folder)

export function readDev(folder: string): { command: string } | undefined {
  try {
    const command = devCommand(JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')), fs.readdirSync(folder))
    return command ? { command } : undefined
  } catch { return undefined }
}

/** Every live window's discovery file. */
export function readWindows(): Win[] {
  const out: Win[] = []
  for (const n of fs.existsSync(DIR) ? fs.readdirSync(DIR) : []) {
    if (!n.endsWith('.json') || n === 'workspaces.json') continue
    try {
      const w = JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8'))
      if (typeof w.port !== 'number' || typeof w.pid !== 'number' || typeof w.hubToken !== 'string' || typeof w.workspace !== 'string') continue
      process.kill(w.pid, 0)
      out.push(w)
    } catch { /* mid-write or a closed window */ }
  }
  return out
}

/** Posts to another window's hub; false when it did not take it. */
export async function postWindow(w: Win, body: Record<string, unknown>): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${w.port}/hub`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: w.hubToken, ...body }), signal: AbortSignal.timeout(2000) })
    return r.ok
  } catch { return false }
}


/** This Mac's tailnet name, whether it can serve https, and what it serves; null without tailscale or when it is down. */
export async function tailnet(): Promise<Tailnet | null> {
  const bin = tailscaleBin()
  if (!bin) return null
  try {
    const s = JSON.parse(await run(bin, ['status', '--json']))
    if (s.BackendState !== 'Running' || !s.Self?.DNSName) return null
    return { dns: s.Self.DNSName, https: (s.CertDomains ?? []).length > 0, served: servedPorts(await run(bin, ['serve', 'status', '--json'])) }
  } catch { return null }
}

export async function serve(port: number, https: boolean, on: boolean): Promise<void> {
  const bin = tailscaleBin()
  if (bin) await run(bin, on ? serveArgs(port, https) : offArgs(port, https), 15000)
}

// Keep awake: one caffeinate for every window, found through its pid file. -w ends it with the extension host that started it.
const AWAKE_FILE = path.join(DIR, 'awake.pid')

export async function awakePid(): Promise<number | undefined> {
  const pid = Number(await fs.promises.readFile(AWAKE_FILE, 'utf8').catch(() => ''))
  return pid > 0 && (await run('ps', ['-p', String(pid), '-o', 'comm='])).trim().endsWith('caffeinate') ? pid : undefined
}

// One toggle at a time in this window, so a double click cannot start two caffeinates.
let awakeQueue: Promise<unknown> = Promise.resolve()

/** Starts or ends the caffeinate; a string is why it could not. */
export function setAwake(on: boolean): Promise<string | undefined> {
  const next = awakeQueue.then(() => toggleAwake(on))
  awakeQueue = next.catch(() => undefined)
  return next
}

async function toggleAwake(on: boolean): Promise<string | undefined> {
  if (process.platform !== 'darwin') return 'Keep awake needs macOS'
  const pid = await awakePid()
  if (!on) {
    if (pid) try { process.kill(pid) } catch { /* already gone */ }
    fs.rmSync(AWAKE_FILE, { force: true })
    return undefined
  }
  if (pid) return undefined
  const child = spawn('caffeinate', ['-dis', '-w', String(process.pid)], { stdio: 'ignore' })
  // Without a listener a spawn error would crash the extension host.
  child.on('error', () => fs.rmSync(AWAKE_FILE, { force: true }))
  if (!child.pid) return 'caffeinate did not start'
  fs.mkdirSync(DIR, { recursive: true })
  fs.writeFileSync(AWAKE_FILE, String(child.pid))
  return undefined
}
