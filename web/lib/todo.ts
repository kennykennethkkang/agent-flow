// The to-do panel's pure parts.
import type { ChatRow, TodoItem, TodoList } from './hub-types'

// Windows paths (a drive letter first): either slash, either case.
const fold = (p: string) => (/^[a-z]:[\\/]/i.test(p) ? p.replace(/\\/g, '/').toLowerCase() : p)

/** Whether cwd is the folder or under it. */
export const inside = (folder: string, cwd: string) => { const c = fold(cwd), f = fold(folder); return c === f || c.startsWith(`${f}/`) }

/** The listed project holding the folder (the longest), else the window's, else the first. */
export function todoFolder(folders: string[], cwd?: string, here?: string): string | undefined {
  const holding = (f?: string) => (f ? folders.filter(p => inside(p, f)).sort((a, b) => b.length - a.length)[0] : undefined)
  return holding(cwd) ?? holding(here) ?? folders[0]
}

/** Rows to show: each prerequisite directly above the item it precedes, one step further in. */
export function ordered(todo: TodoItem[]): Array<{ t: TodoItem; depth: number }> {
  const out: Array<{ t: TodoItem; depth: number }> = [], seen = new Set<string>()
  const visit = (t: TodoItem, depth: number) => {
    if (seen.has(t.id)) return
    seen.add(t.id)
    // Deepest first, so the first thing to do sits on top.
    const pre = todo.filter(x => x.before === t.id)
    for (const p of pre) visit(p, depth + 1)
    out.push({ t, depth })
  }
  const ids = new Set(todo.map(t => t.id))
  for (const t of todo) if (!t.before || !ids.has(t.before)) visit(t, 0)
  // A loop of prerequisites has no top; it still shows.
  for (const t of todo) visit(t, 0)
  return out
}

/** Open items in every project but this one. */
export const openElsewhere = (todos: Record<string, TodoList> | undefined, folder: string) =>
  Object.entries(todos ?? {}).reduce((n, [f, l]) => n + (f === folder ? 0 : l.todo.length), 0)

/** Running chats in the project that the panel can send a message to. */
export const runTargets = (chats: ChatRow[], folder: string) => chats.filter(c => c.live && c.takes && inside(folder, c.cwd))

/** What a run starts on: the picked ones still listed and their open prerequisites (todo.ts runOrder). */
export function runIds(todo: TodoItem[], ids: string[]): Set<string> {
  const s = new Set(ids.filter(id => todo.some(t => t.id === id)))
  for (let grew = true; grew;) {
    grew = false
    for (const t of todo) if (t.before && s.has(t.before) && !s.has(t.id)) { s.add(t.id); grew = true }
  }
  return s
}
export const runCount = (todo: TodoItem[], ids: string[]) => runIds(todo, ids).size

/** Whether a run shows in the list: each picked item gone or in the chat it went to (to), else in a chat other than the one it had (was). */
export const runLanded = (todo: TodoItem[], ids: string[], was: Map<string, string | undefined>, to?: string) =>
  ids.every(id => { const t = todo.find(x => x.id === id); return !t || (to ? t.chat === to : !!t.chat && t.chat !== was.get(id)) })
