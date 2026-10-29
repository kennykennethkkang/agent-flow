/**
 * The AIs the hub connects: each one detects its CLI, lists its chats, and
 * gives the commands that start and resume a chat. Claude wraps sessions.ts and
 * projects.ts; Codex reads its rollout files. Adding an AI is one entry in AIS
 * and one member of AiId. Called from hub-panel.ts, actions.ts and starred.ts.
 */
import { execFile } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { recentSessionDirs } from '../codex-session-watcher'
import { readChains, withChains } from './chains'
import { newChatCommand, noteTo } from './projects'
import { readChats } from './sessions'
import { resumeSettingsArg } from './tools'
import type { AiId, AiStatus, ChatRow } from './types'

type Shell = 'posix' | 'powershell'

/** A message typed into a Codex terminal as one paste, so its newlines do not submit; undefined when it holds a control character other than LF or TAB. */
// eslint-disable-next-line no-control-regex
export const codexPaste = (text: string) => (/[\x00-\x08\x0b-\x1f\x7f]/.test(text) ? undefined : `\x1b[200~${text}\x1b[201~`)

/** A `ps` command line that is Codex itself: the binary, or node running its npm launcher. Never a shell, whatever its arguments say. */
export const isCodexCommand = (cmd: string) => {
  const [first = '', second = ''] = cmd.trim().split(/\s+/).map(w => w.split('/').pop() ?? '')
  return /^codex(\.js)?$/.test(first) || (first === 'node' && /^codex(\.js)?$/.test(second))
}

// Text typed before Codex's screen is up can be lost.
const CODEX_BOOT_MS = 3_000
type CodexTerm = { processId: Thenable<number | undefined>; exitStatus: unknown }
const psCommand = (pid: number) => new Promise<string>(done => execFile('ps', ['-o', 'command=', '-p', String(pid)], (err, out) => done(err ? '' : String(out))))

/** Why a message must not be typed into this Codex terminal now; undefined when the terminal's own process is a running Codex. */
export async function codexReady(o: { terminal: CodexTerm | undefined; live: boolean; startedAt: number; now: number }, readCommand: (pid: number) => Promise<string> = psCommand): Promise<string | undefined> {
  const t = o.terminal
  if (!o.live) return 'that chat is not running'
  if (!t || t.exitStatus !== undefined) return 'that Codex chat was not started or resumed from Switchboard in this window, or has quit, so it cannot take messages; type in its terminal'
  if (o.now - o.startedAt < CODEX_BOOT_MS) return 'Codex is still starting; send again in a moment'
  const pid = await t.processId
  if (!pid || !isCodexCommand(await readCommand(pid))) return 'that terminal is not running Codex, so the message was not typed into it'
  return undefined
}

const psParent = (pid: number) => new Promise<number>(done => execFile('ps', ['-o', 'ppid=', '-p', String(pid)], (err, out) => done(err ? 0 : Number(String(out).trim()) || 0)))
const pidAlive = (pid: number) => { try { process.kill(pid, 0); return true } catch { return false } }
type ClosableTerm = { processId: Thenable<number | undefined>; dispose(): void }

/** The terminal whose shell started a chat, found by the chat process's parent; undefined for a chat started some other way. */
export async function chatTerminal<T extends { processId: Thenable<number | undefined> }>(pid: number, terminals: readonly T[], parent = psParent): Promise<T | undefined> {
  const ppid = await parent(pid)
  if (!ppid) return undefined
  const ids = await Promise.all(terminals.map(t => t.processId))
  return terminals[ids.indexOf(ppid)]
}

/** Disposes the terminal whose shell started a closing chat, once the chat has exited; false when none did or it is still running after waitMs. */
export async function closeChatTerminal(pid: number, terminals: readonly ClosableTerm[], o = { parent: psParent, alive: pidAlive, waitMs: 60_000, stepMs: 1_000 }): Promise<boolean> {
  const t = await chatTerminal(pid, terminals, o.parent)
  if (!t) return false
  for (let waited = 0; o.alive(pid); waited += o.stepMs) {
    if (waited >= o.waitMs) return false
    await new Promise(r => setTimeout(r, o.stepMs))
  }
  t.dispose()
  return true
}

/** Where a CLI lives on PATH, for a terminal that runs it with no shell around it. */
export const cliPath = (cli: string) => new Promise<string | undefined>(done => execFile('which', [cli], (err, out) => done(err ? undefined : String(out).trim() || undefined)))

export type Ai = {
  name: string
  detect: () => Promise<{ installed: boolean; detail?: string }>
  chats: () => Promise<ChatRow[]>
  startCommand: (o: { text?: string; name?: string }, shell: Shell) => string
  resumeCommand: (sessionId: string) => string
}

const LIVE_MS = 10 * 60 * 1000
const HEAD_BYTES = 512 * 1024
const TAIL_BYTES = 256 * 1024
const CODEX_FILES = 20
const quote = (s: string, shell: Shell) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return shell === 'posix' ? `'${one.replace(/'/g, `'\\''`)}'` : `'${one.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`
}
const onPath = async (cli: string) => !!(await cliPath(cli))

type Line = { type?: string; payload?: { id?: string; cwd?: string; type?: string; message?: string; info?: { last_token_usage?: { input_tokens?: number }; model_context_window?: number } } }
const parse = (line: string): Line | undefined => { try { return JSON.parse(line) } catch { return undefined } }
const HANDOFFS = path.join(os.homedir(), '.claude', 'handoffs')
const CONTINUE = /Continue from (.+?\.md): read it first/
const TURN_END = new Set(['task_complete', 'turn_complete', 'turn_aborted'])
// Switchboard puts its brief (brain.ts, one block with no blank line) in front of a Codex chat's first message;
// every Codex chat in a project would share a name made from it, so the name comes from what follows.
const withoutBrief = (m: string) => {
  if (!m.startsWith('Switchboard brief for ')) return m
  const at = m.indexOf('\n\n')
  return at < 0 ? '' : m.slice(at + 2)
}

/** A handoff note's text; only notes under ~/.claude/handoffs are read. */
function readHandoff(p: string): string | undefined {
  const full = path.resolve(p)
  if (!full.startsWith(HANDOFFS + path.sep)) return undefined
  try { return fs.readFileSync(full, 'utf8').slice(0, 2000) } catch { return undefined }
}

/**
 * One Codex rollout as a chat row: session_meta gives the id and folder, the first user
 * message the name (a handoff's note names it by its To: line), the last token count the fill.
 */
export function codexRow(lines: string[], mtime: number, now = Date.now(), read = readHandoff): ChatRow | undefined {
  let id: string | undefined, cwd = '', first: string | undefined, fill: number | undefined, status: string | undefined
  for (const line of lines) {
    const r = parse(line)
    if (r?.type === 'session_meta' && typeof r.payload?.id === 'string') { id = r.payload.id; cwd = r.payload.cwd ?? '' }
    if (first === undefined && r?.type === 'event_msg' && r.payload?.type === 'user_message' && r.payload.message) first = withoutBrief(r.payload.message)
    // The turn's own end marks: only these say a chat is idle; a quiet rollout may be mid-turn.
    if (r?.type === 'event_msg' && TURN_END.has(r.payload?.type ?? '')) status = 'idle'
    if (r?.type === 'event_msg' && r.payload?.type === 'task_started') status = 'busy'
    const info = r?.type === 'event_msg' && r.payload?.type === 'token_count' ? r.payload.info : undefined
    const used = info?.last_token_usage?.input_tokens, max = info?.model_context_window
    if (typeof used === 'number' && typeof max === 'number' && max > 0) fill = Math.min(1, used / max)
  }
  if (!id) return undefined
  const note = first && CONTINUE.exec(first)?.[1]
  const name = (note && noteTo(read(note) ?? '')) || first?.replace(/\s+/g, ' ').trim().slice(0, 60) || undefined
  const live = now - mtime < LIVE_MS
  return { pid: 0, sessionId: id, name, cwd, updatedAt: mtime, link: '', live, why: [], ai: 'codex', ...(fill === undefined ? {} : { fill }), ...(status ? { status } : {}) }
}

/** The last thing typed in a Codex chat. */
export function lastCodexPrompt(lines: string[]): string | undefined {
  let last: string | undefined
  for (const line of lines) {
    const r = parse(line)
    if (r?.type === 'event_msg' && r.payload?.type === 'user_message' && r.payload.message) last = r.payload.message
  }
  return last
}

// Each rollout's last read lines by its mtime, so an idle chat's unchanged file is not read again every refresh.
const readLines = new Map<string, { mtime: number; lines: string[] }>()

/** A rollout's head (session_meta, first message) and tail (last token count, last prompt) as lines. With mtime, an unchanged file's last read is reused. */
export async function rolloutLines(file: string, mtime?: number): Promise<string[]> {
  const hit = readLines.get(file)
  if (mtime !== undefined && hit?.mtime === mtime) return hit.lines
  const lines = await readRollout(file)
  if (mtime !== undefined) readLines.set(file, { mtime, lines })
  return lines
}

async function readRollout(file: string): Promise<string[]> {
  const fd = await fs.promises.open(file, 'r').catch(() => undefined)
  if (!fd) return []
  try {
    const { size } = await fd.stat()
    const head = await fd.read(Buffer.alloc(HEAD_BYTES), 0, HEAD_BYTES, 0)
    const lines = head.buffer.subarray(0, head.bytesRead).toString('utf8').split('\n')
    if (size <= HEAD_BYTES) return lines
    const start = Math.max(HEAD_BYTES, size - TAIL_BYTES)
    const tail = await fd.read(Buffer.alloc(size - start), 0, size - start, start)
    return [...lines, ...tail.buffer.subarray(0, tail.bytesRead).toString('utf8').split('\n')]
  } finally { await fd.close() }
}

/** Each Codex chat's rollout file by session id, for the auto handoff in hub-panel.ts. */
export const codexFiles = new Map<string, string>()

async function codexChats(): Promise<ChatRow[]> {
  const files: { file: string; mtime: number }[] = []
  for (const dir of recentSessionDirs(new Date())) {
    for (const n of await fs.promises.readdir(dir).catch(() => [] as string[])) {
      if (!n.endsWith('.jsonl')) continue
      const file = path.join(dir, n)
      const st = await fs.promises.stat(file).catch(() => undefined)
      if (st) files.push({ file, mtime: st.mtimeMs })
    }
  }
  files.sort((a, b) => b.mtime - a.mtime)
  const rows: ChatRow[] = []
  const recent = files.slice(0, CODEX_FILES)
  for (const f of readLines.keys()) if (!recent.some(r => r.file === f)) readLines.delete(f)
  for (const { file, mtime } of recent) {
    const row = codexRow(await rolloutLines(file, mtime), mtime)
    if (!row) continue
    codexFiles.set(row.sessionId, file)
    rows.push(row)
  }
  return rows
}

export const AIS: Record<AiId, Ai> = {
  claude: {
    name: 'Claude Code',
    detect: async () => ({ installed: await onPath('claude') }),
    chats: async () => (await readChats()).map(c => ({ ...c, ai: 'claude' as const })),
    startCommand: (o, shell) => newChatCommand(o, shell),
    // A chat with a tool profile resumes with it: --settings applies on resume too.
    resumeCommand: id => `claude --resume ${id}${resumeSettingsArg(id)}`,
  },
  codex: {
    name: 'Codex',
    detect: async () => {
      if (await onPath('codex')) return { installed: true }
      const home = fs.existsSync(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'))
      return { installed: false, detail: home ? 'CLI not installed: npm i -g @openai/codex' : 'Not set up' }
    },
    chats: codexChats,
    startCommand: (o, shell) => (o.text?.trim() ? `codex ${quote(o.text, shell)}` : 'codex'),
    resumeCommand: id => `codex resume ${id}`,
  },
}

export const isAi = (v: unknown): v is AiId => typeof v === 'string' && Object.hasOwn(AIS, v)

/** Every AI's chats, each in its handoff chain, and a status row per AI. */
export async function readAis(): Promise<{ chats: ChatRow[]; ais: AiStatus[] }> {
  const ids = Object.keys(AIS) as AiId[]
  const found = await Promise.all(ids.map(async id => ({ id, d: await AIS[id].detect(), chats: await AIS[id].chats().catch(() => []) })))
  return {
    chats: withChains(found.flatMap(f => f.chats), readChains()),
    ais: found.map(f => ({ id: f.id, name: AIS[f.id].name, installed: f.d.installed, detail: f.d.detail, chats: f.chats.filter(c => c.live).length })),
  }
}
