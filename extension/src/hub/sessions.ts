/**
 * Running Claude Code chats, read from ~/.claude/sessions/<pid>.json, as the
 * Chats rows: connected to Remote Control or not, the link into the Claude app,
 * and why a chat may be missing there. Also the Remote Control server command.
 * Key files beside them are never opened. Called from hub-panel.ts.
 */
import * as fs from 'fs'
import { execFile, execFileSync } from 'child_process'
import * as os from 'os'
import * as path from 'path'
import type { ChatRow } from './types'

const DIR = path.join(os.homedir(), '.claude', 'sessions')
const QUIET_MS = 30 * 60 * 1000
const CHAT_LINK = (bridge?: string) => (bridge ? `https://claude.ai/code/${bridge}` : 'https://claude.ai/code')
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined)

export function newer(a: string, b: string): boolean {
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0)
  }
  return false
}

export function chatRows(files: Record<string, unknown>[], alive: (pid: number) => boolean, now = Date.now()): ChatRow[] {
  const rows = files.flatMap(f => {
    const pid = f.pid, sessionId = str(f.sessionId)
    if (typeof pid !== 'number' || !sessionId) return []
    const updatedAt = typeof f.updatedAt === 'number' ? f.updatedAt : undefined
    return [{ pid, sessionId, name: str(f.name), cwd: str(f.cwd) ?? '', status: str(f.status), version: str(f.version), kind: str(f.kind), updatedAt, bridgeId: str(f.bridgeSessionId), live: alive(pid) }]
  })
  const newest = rows.map(r => r.version).filter((v): v is string => !!v).reduce<string | undefined>((m, v) => (!m || newer(v, m) ? v : m), undefined)
  return rows.map(r => {
    const why: string[] = []
    if (!r.bridgeId) why.push('not connected')
    if (!r.live) why.push('process gone')
    if (r.updatedAt !== undefined && now - r.updatedAt > QUIET_MS) why.push(`quiet for ${Math.round((now - r.updatedAt) / 60_000)} min`)
    if (r.version && newest && newer(newest, r.version)) why.push(`older Claude Code (${r.version})`)
    if (r.kind && r.kind !== 'interactive') why.push('not an interactive chat')
    return { ...r, link: CHAT_LINK(r.bridgeId), why }
  })
}

/** Live chats Remote Control should connect; a connected chat is never sent rc, which would disconnect it. */
export const rcTargets = (rows: ChatRow[]) => rows.filter(r => r.live && !r.bridgeId).map(r => r.sessionId)

/** The machine's one Remote Control server, started in ~/Documents/GitHub by the kit's LaunchAgent or the gear switch. */
export const RC_NAME = 'Mac'

/** same-dir: phone chats start in the GitHub folder and can work in any repo under it. */
export const rcServerCommand = () => `claude remote-control --name '${RC_NAME}' --spawn same-dir --permission-mode bypassPermissions`

/** `pgrep -f` pattern for a Remote Control server named `name`, as the kit's LaunchAgent starts it. */
export const rcPattern = (name: string) => `remote-control --name ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( |$)`

/** Windows has no pgrep -f: every process as "pid command line", as the kit's rc-servers.mjs lists them. */
const PS_LIST = 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }'
/** Whether a PS_LIST listing holds the server; cmd.exe and claude both carry its command line. */
export const rcInList = (ps: string, name = RC_NAME) => new RegExp(rcPattern(name), 'm').test(ps.replace(/\r/g, ''))

const psList = () => new Promise<string>((resolve, reject) =>
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_LIST], { windowsHide: true, timeout: 15_000, maxBuffer: 8 << 20 }, (err, out) => (err ? reject(err) : resolve(String(out)))))

let rcSeen = false, listing = false
/** The Remote Control server running as a process, whoever started it. */
export function rcRunning(platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') {
    // Answers the last listing, since powershell takes a second and this runs on every refresh; rcRunningNow waits.
    if (!listing) {
      listing = true
      psList().then(out => { rcSeen = rcInList(out) }, () => {}).finally(() => { listing = false })
    }
    return rcSeen
  }
  try { execFileSync('pgrep', ['-f', rcPattern(RC_NAME)], { stdio: 'ignore', timeout: 2000 }); return true } catch { return false }
}

/** rcRunning from a fresh listing, for the on/off switch. */
export async function rcRunningNow(platform: NodeJS.Platform = process.platform, list = psList): Promise<boolean> {
  if (platform !== 'win32') return rcRunning(platform)
  try { rcSeen = rcInList(await list()) } catch { /* keep the last answer */ }
  return rcSeen
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM' } }

export async function readChats(): Promise<ChatRow[]> {
  const names = await fs.promises.readdir(DIR).catch(() => [] as string[])
  const files: Record<string, unknown>[] = []
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue
    try { files.push(JSON.parse(await fs.promises.readFile(path.join(DIR, n), 'utf8'))) } catch { /* mid-write */ }
  }
  return chatRows(files, alive)
}
