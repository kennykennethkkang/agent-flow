/**
 * The quick switcher (Cmd+K): every live chat and every History version, matched by name.
 * A substring wins over letters found in order; switcher.tsx draws the result.
 */
import type { ArchivedChat, ChatProgress, ChatRow, ChatState } from './hub-types'
import { archiveChains, splitVersion } from './archive'

export type SwitchItem =
  | { kind: 'live'; id: string; name: string; version: number; state: ChatState }
  | { kind: 'history'; id: string; chain: string; name: string; version: number }

/** The indices of q's letters in name: a substring if there is one, else letters in order; null when none fit. */
/** Indices count letters (code points), the unit switcher.tsx marks by, so an emoji is one letter. */
export function matchName(name: string, q: string): number[] | null {
  const n = [...name.toLowerCase()], query = [...q.trim().toLowerCase()]
  if (!query.length) return []
  for (let at = 0; at + query.length <= n.length; at++) {
    if (query.every((ch, i) => n[at + i] === ch)) return query.map((_, i) => at + i)
  }
  const out: number[] = []
  for (let i = 0, j = 0; i < n.length && j < query.length; i++) if (n[i] === query[j]) { out.push(i); j++ }
  return out.length === query.length ? out : null
}

export function switcherItems(cards: { chat: ChatRow; progress?: ChatProgress }[], archive: ArchivedChat[]): SwitchItem[] {
  const live: SwitchItem[] = cards.map(({ chat, progress }) => {
    const { origin, version } = splitVersion(chat.name)
    return { kind: 'live', id: chat.sessionId, name: origin || chat.cwd.split(/[\\/]/).pop() || chat.sessionId.slice(0, 8), version, state: progress?.state ?? 'idle' }
  })
  const history: SwitchItem[] = archiveChains(archive).flatMap(c => c.versions.map(v => ({ kind: 'history' as const, id: v.sessionId, chain: `${c.latest.cwd}\n${c.origin}`, name: c.origin, version: v.version })))
  return [...live, ...history]
}

/** Matching items, best first: a substring at the start, then anywhere, then loose; live before History on a tie. */
export function rankItems(items: SwitchItem[], q: string): { item: SwitchItem; hits: number[] }[] {
  const score = (hits: number[]) => {
    if (!hits.length) return 0
    const tight = hits[hits.length - 1] - hits[0] === hits.length - 1
    return (tight ? (hits[0] === 0 ? 0 : 1) : 2) * 1000 + hits[0]
  }
  return items
    .map((item, i) => ({ item, i, hits: matchName(item.name, q) }))
    .filter((r): r is { item: SwitchItem; i: number; hits: number[] } => r.hits !== null)
    .sort((a, b) => score(a.hits) - score(b.hits) || a.i - b.i)
    .map(({ item, hits }) => ({ item, hits }))
}
