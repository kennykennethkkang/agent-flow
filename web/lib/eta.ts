/** How far a chat is through its task list, and roughly how long the rest takes at its own pace so far. */
import type { ChatProgress, TaskRow } from './hub-types'

export type Eta = { done: number; total: number; current?: TaskRow; elapsedMs: number; perTaskMs?: number; leftMs?: number }

export function eta(p: ChatProgress, now: number): Eta {
  const tasks = p.tasks, finished = tasks.filter(t => t.status === 'completed')
  const current = tasks.find(t => t.status === 'in_progress')
  const timed = finished.filter(t => t.startedAt !== undefined && t.doneAt !== undefined).map(t => t.doneAt! - t.startedAt!)
  // Per task: the tasks' own times when known, else the chat's time so far spread over what finished.
  const last = Math.max(0, ...finished.map(t => t.doneAt ?? 0))
  const perTaskMs = timed.length ? timed.reduce((a, b) => a + b, 0) / timed.length
    : finished.length && last ? (last - p.startedAt) / finished.length : undefined
  const open = tasks.length - finished.length
  // The task under way counts as partly done, but never below a fifth of a task.
  const into = current?.startedAt !== undefined ? now - current.startedAt : 0
  const leftMs = perTaskMs !== undefined && open ? Math.max(perTaskMs * open - into, perTaskMs * 0.2) : undefined
  return { done: finished.length, total: tasks.length, current, elapsedMs: now - p.startedAt, perTaskMs, leftMs }
}

/** "under a minute", "about 4 min", "about 1 h 20 min". */
export function say(ms: number): string {
  const m = Math.round(ms / 60e3)
  if (m < 1) return 'under a minute'
  if (m < 60) return `about ${m} min`
  const five = Math.round(m / 5) * 5, h = Math.floor(five / 60), r = five % 60
  return `about ${h} h${r ? ` ${r} min` : ''}`
}
