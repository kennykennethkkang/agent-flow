/** The rail's chats grouped by the VS Code window whose folder holds them; the same containment rule as the hook forwarder. */
import type { WindowInfo } from './hub-types'

const inside = (cwd: string, ws: string) => cwd === ws || cwd.startsWith(ws.endsWith('/') || ws.endsWith('\\') ? ws : ws + (ws.includes('\\') ? '\\' : '/'))

/** The window holding a folder, the deepest one when windows nest. */
export const windowOf = (cwd: string, windows: WindowInfo[]) =>
  windows.filter(w => inside(cwd, w.workspace)).sort((a, b) => b.workspace.length - a.workspace.length)[0] as WindowInfo | undefined

export type WindowGroup<T> = { window?: WindowInfo; here: boolean; cards: T[] }

/** here (the panel's own window) first, the rest by name, chats no window holds last. With no windows known, one plain group. */
export function byWindow<T extends { chat: { cwd: string } }>(cards: T[], windows: WindowInfo[], here?: string): WindowGroup<T>[] {
  const groups = new Map<string, WindowGroup<T>>()
  for (const c of cards) {
    const w = windowOf(c.chat.cwd, windows)
    const key = w?.workspace ?? ''
    if (!groups.has(key)) groups.set(key, { window: w, here: !!w && w.workspace === here, cards: [] })
    groups.get(key)!.cards.push(c)
  }
  const rank = (g: WindowGroup<T>) => (g.here ? 0 : g.window ? 1 : 2)
  return [...groups.values()].sort((a, b) => rank(a) - rank(b) || (a.window?.name ?? '').localeCompare(b.window?.name ?? '') || (a.window?.workspace ?? '').localeCompare(b.window?.workspace ?? ''))
}
