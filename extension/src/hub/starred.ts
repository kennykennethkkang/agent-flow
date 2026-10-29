/**
 * Starred chats: the list in ~/.claude/switchboard/starred.json and each star's
 * digest (last prompt, newest handoff note, how to resume), read from disk and
 * hub state with no model call. Called from hub-panel.ts and brain.ts.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AIS, isAi } from './ais'
import { chainBase } from './projects'
import type { AiId, HubState, StarredChat } from './types'

export type Star = { sessionId: string; ai: AiId; name: string; cwd: string; starredAt: number }

const FILE = path.join(os.homedir(), '.claude', 'switchboard', 'starred.json')
const HANDOFFS = path.join(os.homedir(), '.claude', 'handoffs')
const NOTE_MAX = 300

export function readStarred(): Star[] {
  try {
    const list = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    return Array.isArray(list) ? list.filter(s => typeof s?.sessionId === 'string' && isAi(s.ai)) : []
  } catch { return [] }
}

export function writeStarred(list: Star[]): void {
  fs.mkdirSync(path.dirname(FILE), { recursive: true })
  fs.writeFileSync(FILE, JSON.stringify(list, null, 2))
}

export function toggleStar(list: Star[], s: Omit<Star, 'starredAt'>, on: boolean, now = Date.now()): Star[] {
  const rest = list.filter(x => x.sessionId !== s.sessionId)
  return on ? [...rest, { ...s, starredAt: list.find(x => x.sessionId === s.sessionId)?.starredAt ?? now }] : rest
}

/** The newest handoff note per session id, named <stamp>-<first 8 of the id>.md. */
export async function newestNotes(ids: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  const projects = await fs.promises.readdir(HANDOFFS).catch(() => [] as string[])
  for (const id of ids) {
    let best: { file: string; mtime: number } | undefined
    for (const p of projects) {
      for (const n of await fs.promises.readdir(path.join(HANDOFFS, p)).catch(() => [] as string[])) {
        if (!n.endsWith(`-${id.slice(0, 8)}.md`)) continue
        const file = path.join(HANDOFFS, p, n)
        const st = await fs.promises.stat(file).catch(() => undefined)
        if (st && (!best || st.mtimeMs > best.mtime)) best = { file, mtime: st.mtimeMs }
      }
    }
    if (best) out[id] = await fs.promises.readFile(best.file, 'utf8').catch(() => '')
  }
  return out
}

/** chains: chains.json, for a star whose chat is no longer listed. */
export function starredRows(list: Star[], state: HubState, notes: Record<string, string>, chains: Record<string, string> = {}): StarredChat[] {
  return list.map(s => {
    const chat = state.chats.find(c => c.sessionId === s.sessionId)
    const live = state.live.find(l => l.sessionId === s.sessionId)
    const note = notes[s.sessionId]?.slice(0, NOTE_MAX) || undefined
    return {
      sessionId: s.sessionId, ai: s.ai, name: chat?.name ?? s.name, cwd: chat?.cwd || s.cwd, starredAt: s.starredAt,
      live: chat?.live ?? false, chain: chat?.chain ?? chainBase(chat?.name ?? s.name) ?? chains[s.sessionId],
      digest: { lastPrompt: live?.prompt, note, resume: AIS[s.ai].resumeCommand(s.sessionId), updatedAt: chat?.updatedAt },
    }
  })
}
