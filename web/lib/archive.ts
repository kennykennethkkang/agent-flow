/**
 * History: chats closed by a handoff, grouped by the origin chat they continue.
 * The extension's archive is in hub.archive; extension/src/hub/projects.ts names the chats.
 */
import type { ArchivedChat } from './hub-types'

// `Origin vN`, or the older `Origin · N`; the same rule as chainBase in projects.ts.
const CHAIN = /^(.+?)(?: v| · )(\d+)$/

/** A chat name's origin and version; a name with no version is its own origin, v1. */
export function splitVersion(name: string | undefined): { origin: string; version: number } {
  const m = name ? CHAIN.exec(name.trim()) : null
  return m ? { origin: m[1], version: Number(m[2]) } : { origin: name?.trim() ?? '', version: 1 }
}

/** The chats still open: an archived chat leaves the live list even while its process winds down. */
export function liveChats<T extends { sessionId: string }>(chats: T[], archive: ArchivedChat[]): T[] {
  const gone = new Set(archive.map(a => a.sessionId))
  return chats.filter(c => !gone.has(c.sessionId))
}

type IdleCard = { chat: { sessionId: string; status?: string; updatedAt?: number }; progress?: { state: string; at: number } }

/** The rail's chats: a stopped chat (idle or done) quiet for longer than `minutes` is hidden; null hides none. Find still lists it. */
export function hideIdle<T extends IdleCard>(cards: T[], minutes: number | null, picked: string | undefined, now = Date.now()): T[] {
  if (minutes === null) return cards
  return cards.filter(c => {
    const state = c.progress?.state ?? (c.chat.status === 'idle' ? 'idle' : undefined)
    const at = c.progress?.at ?? c.chat.updatedAt
    return c.chat.sessionId === picked || (state !== 'idle' && state !== 'done') || at === undefined || now - at <= minutes * 60e3
  })
}

// ponytail: a project is the chat folder's last name, so two repos with one name share a chip; key by full path if that happens.
const projectOf = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd

/** The projects chats run in, most chats first; a picked one with no chat left stays listed so it can be unpicked. */
export function chatProjects(cwds: string[], picked: string[]): { name: string; count: number }[] {
  const counts = new Map(picked.map(p => [p, 0]))
  for (const cwd of cwds) counts.set(projectOf(cwd), (counts.get(projectOf(cwd)) ?? 0) + 1)
  return [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
}

/** Whether a chat folder is in the picked projects; none picked lets every chat through. */
export const inProjects = (cwd: string, picked: string[]) => !picked.length || picked.includes(projectOf(cwd))

export type ArchiveChain = { origin: string; latest: ArchivedChat; versions: ArchivedChat[] }

/** One chain per origin and folder, the most recently closed first; versions newest first. */
export function archiveChains(archive: ArchivedChat[]): ArchiveChain[] {
  const by = new Map<string, ArchivedChat[]>()
  for (const a of archive) {
    const key = `${a.cwd}\n${a.origin}`
    by.set(key, [...(by.get(key) ?? []), a])
  }
  return [...by.values()]
    .map(list => {
      const versions = [...list].sort((a, b) => b.version - a.version || b.archivedAt - a.archivedAt)
      return { origin: versions[0].origin, latest: versions[0], versions }
    })
    .sort((a, b) => Math.max(...b.versions.map(v => v.archivedAt)) - Math.max(...a.versions.map(v => v.archivedAt)))
}

/** Chains whose origin holds q, or whose versions' handoff notes do (hits: session ids from the extension's search). */
export function filterChains(chains: ArchiveChain[], q: string, hits: Set<string>): ArchiveChain[] {
  const query = q.trim().toLowerCase()
  if (!query) return chains
  return chains.filter(c => c.origin.toLowerCase().includes(query) || c.versions.some(v => hits.has(v.sessionId)))
}

/** The version of the live chat that carries a chain on, in the same folder; undefined when none is open. */
export function liveVersion(chain: ArchiveChain, chats: { name?: string; cwd: string }[]): number | undefined {
  const v = chats.filter(c => c.cwd === chain.latest.cwd && splitVersion(c.name).origin === chain.origin).map(c => splitVersion(c.name).version)
  return v.length ? Math.max(...v) : undefined
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
export const historyCount = (chains: ArchiveChain[]) => `${plural(chains.length, 'chain')}, ${plural(chains.reduce((n, c) => n + c.versions.length, 0), 'chat')}`
