/**
 * Usage history for the Hub: tokens per day and per session from Claude Code's
 * transcripts (~/.claude/projects/<project>/<session>.jsonl and their subagents).
 *
 * Reads each file once and then only what was appended (a per-file byte offset),
 * yielding between chunks so the extension host never stalls on 1 GB of logs.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { SYSTEM_CONTENT_PREFIXES } from '../constants'
import { projectName } from './projects'
import type { DayUsage, SessionRow } from './types'

const DAY_MS = 86_400_000
const CHUNK = 1 << 20
const LABEL_MAX = 80
const SESSIONS_MAX = 30

type Day = { reread: number; written: number; io: number; calls: number; sessions: Set<string> }
type Tally = {
  offset: number
  mtimeMs: number
  sessionKey: string
  isMain: boolean
  days: Map<string, Day>
  label?: string
  title?: string
  project?: string
  reread: number
  calls: number
  startedAt?: number
  lastAt?: number
}

/** Local calendar day, YYYY-MM-DD. */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const yieldToHost = () => new Promise<void>(resolve => setImmediate(resolve))

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const block = content.find(b => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
    return typeof block?.text === 'string' ? block.text : ''
  }
  return ''
}

export class HistoryScanner {
  private readonly tallies = new Map<string, Tally>()

  constructor(
    private readonly root = path.join(os.homedir(), '.claude', 'projects'),
    private readonly days = 14,
  ) {}

  async scan(now = Date.now()): Promise<{ history: DayUsage[]; sessions: SessionRow[] }> {
    const since = now - this.days * DAY_MS
    for (const file of await this.files()) {
      let stat: fs.Stats
      try { stat = await fs.promises.stat(file.path) } catch { continue }
      if (stat.mtimeMs < since) continue
      let tally = this.tallies.get(file.path)
      if (!tally || stat.size < tally.offset) {
        tally = { offset: 0, mtimeMs: 0, sessionKey: file.sessionKey, isMain: file.isMain, days: new Map(), reread: 0, calls: 0 }
        this.tallies.set(file.path, tally)
      }
      if (stat.size === tally.offset && stat.mtimeMs === tally.mtimeMs) continue
      await this.read(file.path, tally, stat.size)
      tally.mtimeMs = stat.mtimeMs
    }
    return { history: this.history(now), sessions: this.sessions(since) }
  }

  private async files(): Promise<Array<{ path: string; sessionKey: string; isMain: boolean }>> {
    const out: Array<{ path: string; sessionKey: string; isMain: boolean }> = []
    let projects: fs.Dirent[] = []
    try { projects = await fs.promises.readdir(this.root, { withFileTypes: true }) } catch { return out }
    for (const p of projects) {
      if (!p.isDirectory()) continue
      const dir = path.join(this.root, p.name)
      let entries: fs.Dirent[] = []
      try { entries = await fs.promises.readdir(dir, { withFileTypes: true }) } catch { continue }
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith('.jsonl')) {
          out.push({ path: path.join(dir, e.name), sessionKey: e.name.slice(0, -6), isMain: true })
        } else if (e.isDirectory()) {
          const sub = path.join(dir, e.name, 'subagents')
          let subs: string[] = []
          try { subs = await fs.promises.readdir(sub) } catch { continue }
          for (const s of subs) if (s.endsWith('.jsonl')) out.push({ path: path.join(sub, s), sessionKey: e.name, isMain: false })
        }
      }
    }
    return out
  }

  private async read(file: string, tally: Tally, size: number): Promise<void> {
    const handle = await fs.promises.open(file, 'r')
    try {
      let carry = ''
      let position = tally.offset
      const buffer = Buffer.alloc(CHUNK)
      while (position < size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK, size - position), position)
        if (bytesRead === 0) break
        position += bytesRead
        const text = carry + buffer.toString('utf8', 0, bytesRead)
        const lastNewline = text.lastIndexOf('\n')
        if (lastNewline < 0) { carry = text; continue }
        for (const line of text.slice(0, lastNewline).split('\n')) this.line(line, tally)
        carry = text.slice(lastNewline + 1)
        // Count only up to the last complete line; a partial one is read again next time.
        tally.offset = position - Buffer.byteLength(carry, 'utf8')
        await yieldToHost()
      }
    } finally {
      await handle.close()
    }
  }

  private line(line: string, tally: Tally): void {
    const hasUsage = line.includes('"usage"')
    const wantsLabel = tally.isMain && !tally.label && line.includes('"type":"user"')
    const isTitle = tally.isMain && line.includes('"custom-title"')
    if (!hasUsage && !wantsLabel && !isTitle && tally.project) return
    let entry: Record<string, unknown>
    try { entry = JSON.parse(line) } catch { return }
    if (isTitle && entry.type === 'custom-title' && typeof entry.customTitle === 'string') {
      tally.title = entry.customTitle.slice(0, LABEL_MAX)
      return
    }
    const cwd = typeof entry.cwd === 'string' ? entry.cwd : undefined
    if (cwd && !tally.project) tally.project = projectName(cwd)
    const ts = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN
    const message = entry.message as { role?: string; content?: unknown; usage?: Record<string, number> } | undefined
    if (wantsLabel && entry.type === 'user' && message?.role === 'user') {
      const text = textOf(message.content).trim()
      // A chat opened with a slash command is named by what was typed after it.
      const args = /^<command-(?:message|name)>/.test(text) ? /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() : undefined
      // A chat that opened with a paste is named by the paste's first line.
      const pasted = /^<pasted_content[^>]*>\s*([^\n<]*)/.exec(text)?.[1]?.trim()
      if (args) {
        tally.label = args.split('\n')[0].slice(0, LABEL_MAX)
      } else if (text.startsWith('<pasted_content')) {
        tally.label = `Pasted: ${pasted || 'text'}`.slice(0, LABEL_MAX)
      } else if (text && !text.startsWith('<command-message>') && !SYSTEM_CONTENT_PREFIXES.some(prefix => text.startsWith(prefix))) {
        tally.label = text.split('\n')[0].slice(0, LABEL_MAX)
      }
    }
    const u = message?.usage
    if (!hasUsage || entry.type !== 'assistant' || !u || Number.isNaN(ts)) return
    const reread = u.cache_read_input_tokens ?? 0
    const day = dayKey(ts)
    const d = tally.days.get(day) ?? { reread: 0, written: 0, io: 0, calls: 0, sessions: new Set<string>() }
    d.reread += reread
    d.written += u.cache_creation_input_tokens ?? 0
    d.io += (u.input_tokens ?? 0) + (u.output_tokens ?? 0)
    d.calls += 1
    d.sessions.add(tally.sessionKey)
    tally.days.set(day, d)
    tally.reread += reread
    tally.calls += 1
    tally.startedAt = Math.min(tally.startedAt ?? ts, ts)
    tally.lastAt = Math.max(tally.lastAt ?? ts, ts)
  }

  private history(now: number): DayUsage[] {
    const out: DayUsage[] = []
    for (let i = this.days - 1; i >= 0; i--) {
      const day = dayKey(now - i * DAY_MS)
      const sum = { day, reread: 0, written: 0, io: 0, calls: 0, sessions: 0 }
      const sessions = new Set<string>()
      for (const t of this.tallies.values()) {
        const d = t.days.get(day)
        if (!d) continue
        sum.reread += d.reread; sum.written += d.written; sum.io += d.io; sum.calls += d.calls
        for (const s of d.sessions) sessions.add(s)
      }
      sum.sessions = sessions.size
      out.push(sum)
    }
    return out
  }

  private sessions(since: number): SessionRow[] {
    const rows = new Map<string, SessionRow>()
    for (const t of this.tallies.values()) {
      if (t.lastAt === undefined) continue
      const row = rows.get(t.sessionKey) ?? { sessionId: t.sessionKey, label: '', project: '', reread: 0, calls: 0, startedAt: t.startedAt ?? t.lastAt, lastAt: t.lastAt }
      row.reread += t.reread
      row.calls += t.calls
      row.startedAt = Math.min(row.startedAt, t.startedAt ?? row.startedAt)
      row.lastAt = Math.max(row.lastAt, t.lastAt)
      if (t.isMain) { row.label = t.title ?? t.label ?? row.label; row.project = t.project ?? row.project }
      rows.set(t.sessionKey, row)
    }
    return [...rows.values()]
      .filter(r => r.lastAt >= since)
      .map(r => ({ ...r, label: r.label || r.sessionId.slice(0, 8) }))
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, SESSIONS_MAX)
  }
}
