/**
 * Handoff chains: each chat that handed off, by session id, under its chain's
 * base name, in ~/.claude/switchboard/chains.json. A fresh chat carries the
 * chain in its name (`Origin vN`); the old chat's name may not, so it is
 * recorded here. Written by actions.ts, read by ais.ts and starred.ts. Also
 * which Codex chats are full enough for hub-panel.ts to hand off, and the
 * archive of closed chats (archive.json) that History shows.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { writeJsonAtomic } from '../hook-entries'
import { chainBase, inWorkspace } from './projects'
import { isAi } from './ais'
import type { ArchivedChat, ChatRow } from './types'

const FILE = path.join(os.homedir(), '.claude', 'switchboard', 'chains.json')
const ARCHIVE = path.join(os.homedir(), '.claude', 'switchboard', 'archive.json')
// ponytail: the newest 500 closed chats; page or prune by age if History ever needs more.
const ARCHIVE_MAX = 500

export function readChains(file = FILE): Record<string, string> {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'))
    return m && typeof m === 'object' && !Array.isArray(m) ? m : {}
  } catch { return {} }
}

export function recordChain(sessionId: string, base: string, file = FILE): void {
  writeJsonAtomic(file, { ...readChains(file), [sessionId]: base })
}

/** Each row with the chain its name says, else the one it was recorded under. */
export const withChains = <T extends { sessionId: string; name?: string }>(rows: T[], chains: Record<string, string>) =>
  rows.map(r => ({ ...r, chain: chainBase(r.name) ?? chains[r.sessionId] }))

const RECENT_MS = 10 * 60 * 1000
const FULL = 0.9

const WAIT_CAP_MS = 30 * 60 * 1000

/** Full Codex chats (90% or more) in this window, active in the last ten minutes and not handed off yet. */
export const fullCodex = (chats: ChatRow[], done: Set<string>, workspace: string | undefined, now = Date.now()) =>
  chats.filter(c => c.ai === 'codex' && (c.fill ?? 0) >= FULL && now - (c.updatedAt ?? 0) < RECENT_MS && !done.has(c.sessionId) && inWorkspace(c.cwd, workspace))

/**
 * The full Codex chats to hand off now: those with no open turn, or that waited 30 minutes on one.
 * busySince keeps when each was first seen busy; the caller holds it across refreshes.
 */
export function dueForHandoff(chats: ChatRow[], done: Set<string>, workspace: string | undefined, now = Date.now(), busySince = new Map<string, number>()): ChatRow[] {
  return fullCodex(chats, done, workspace, now).filter(c => {
    if (c.status !== 'busy') return true
    if (!busySince.has(c.sessionId)) busySince.set(c.sessionId, now)
    return now - busySince.get(c.sessionId)! >= WAIT_CAP_MS
  })
}

// A floor on top of the turn's end mark: real rollouts go quiet for up to five minutes mid-turn, so silence alone proves nothing.
const IDLE_MS = 2 * 60 * 1000

/** Handed-off Codex chats whose last turn ended (ais.ts status 'idle') and that wrote nothing for two minutes; unsure means open. */
export const idleHandedOff = (chats: ChatRow[], closing: Set<string>, now = Date.now()) =>
  chats.filter(c => closing.has(c.sessionId) && c.status === 'idle' && c.updatedAt !== undefined && now - c.updatedAt >= IDLE_MS)

/** A Codex terminal Switchboard started, before its session id is known. key: the terminal's own id in actions.ts. */
export type CodexStart = { key: string; cwd: string; name?: string; at: number }

/**
 * Which started terminals are now known by session id: a Codex row in the same folder, under the same name,
 * written after the terminal opened and not tied yet. Only a single fit on both sides ties; anything else waits.
 */
export function matchCodexStarts(starts: CodexStart[], chats: ChatRow[], bound: Set<string>): Map<string, string> {
  const out = new Map<string, string>()
  const fits = (s: CodexStart, c: ChatRow) => c.ai === 'codex' && !bound.has(c.sessionId) && c.cwd === s.cwd && !!s.name && c.name === s.name && (c.updatedAt ?? 0) >= s.at
  for (const s of starts) {
    const rows = chats.filter(c => fits(s, c))
    if (rows.length === 1 && starts.filter(o => fits(o, rows[0])).length === 1) out.set(s.key, rows[0].sessionId)
  }
  return out
}

const isArchived = (r: unknown): r is ArchivedChat => {
  const a = r as ArchivedChat
  return !!a && typeof a.sessionId === 'string' && typeof a.name === 'string' && typeof a.origin === 'string'
    && typeof a.version === 'number' && typeof a.cwd === 'string' && typeof a.archivedAt === 'number' && isAi(a.ai)
}

/** Closed chats, oldest first; bad: the file is there but is not a JSON list. */
function loadArchive(file: string): { rows: ArchivedChat[]; bad: boolean } {
  let raw: string
  try { raw = fs.readFileSync(file, 'utf8') } catch { return { rows: [], bad: false } }
  try {
    const list = JSON.parse(raw)
    return Array.isArray(list) ? { rows: list.filter(isArchived), bad: false } : { rows: [], bad: true }
  } catch { return { rows: [], bad: true } }
}

export const readArchive = (file = ARCHIVE): ArchivedChat[] => loadArchive(file).rows

/** Writes the archive; an unreadable file is kept beside it first, so a write never wipes History. */
function writeArchive(file: string, edit: (rows: ArchivedChat[]) => ArchivedChat[]): void {
  const { rows, bad } = loadArchive(file)
  if (bad) fs.copyFileSync(file, `${file}.bad-${Date.now()}`)
  writeJsonAtomic(file, edit(rows).slice(-ARCHIVE_MAX))
}

/** Adds a closed chat, replacing an earlier row for the same session. */
export function recordArchive(row: ArchivedChat, file = ARCHIVE): void {
  writeArchive(file, rows => [...rows.filter(r => r.sessionId !== row.sessionId), row])
}

/** A resumed chat leaves History; false when it was not there. */
export function removeArchive(sessionId: string, file = ARCHIVE): boolean {
  if (!readArchive(file).some(r => r.sessionId === sessionId)) return false
  writeArchive(file, rows => rows.filter(r => r.sessionId !== sessionId))
  return true
}

// ─── History search ──────────────────────────────────────────────────────────

const HANDOFFS = path.join(os.homedir(), '.claude', 'handoffs')
const NOTE_MAX = 64 * 1024
const SNIPPET = 60
// Note text by path and mtime; ponytail: grows with the archive (at most ARCHIVE_MAX notes of 64 KB).
const noteCache = new Map<string, { mtime: number; text: string }>()

function readNote(full: string): string | undefined {
  try {
    const { mtimeMs } = fs.statSync(full)
    const hit = noteCache.get(full)
    if (hit?.mtime === mtimeMs) return hit.text
    const text = fs.readFileSync(full, 'utf8').slice(0, NOTE_MAX)
    noteCache.set(full, { mtime: mtimeMs, text })
    return text
  } catch { return undefined }
}

/** The words around the first match of q, on one line, with ... where it was cut. */
export function noteSnippet(text: string, q: string): string | undefined {
  const flat = text.replace(/\s+/g, ' ')
  const at = flat.toLowerCase().indexOf(q.toLowerCase())
  if (at < 0) return undefined
  const from = Math.max(0, at - SNIPPET), to = Math.min(flat.length, at + q.length + SNIPPET)
  return `${from > 0 ? '...' : ''}${flat.slice(from, to).trim()}${to < flat.length ? '...' : ''}`
}

/** Closed chats whose handoff note holds q; only notes under ~/.claude/handoffs are read. */
export function searchNotes(archive: ArchivedChat[], q: string, handoffs = HANDOFFS): { sessionId: string; snippet: string }[] {
  const query = q.trim().slice(0, 100)
  if (!query) return []
  const hits: { sessionId: string; snippet: string }[] = []
  for (const a of archive) {
    const full = a.note ? path.resolve(a.note) : ''
    if (!full.startsWith(handoffs + path.sep)) continue
    const snippet = noteSnippet(readNote(full) ?? '', query)
    if (snippet) hits.push({ sessionId: a.sessionId, snippet })
  }
  return hits
}
