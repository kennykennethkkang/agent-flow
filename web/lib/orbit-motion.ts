import type { ChatState } from './hub-types'

/** How long a tool call's pill lives on the orbit, in ms. */
export const PILL_MS = 2800

/**
 * Time constants for approach(), in ms: a value covers 95% of the way in 3x its tau.
 * move: bubbles gliding to a new slot; color: state changes; enter: a bubble popping in or out.
 */
export const TAU = { move: 140, color: 90, enter: 80, spin: 600 } as const

/** cur moved toward target over dt ms, frame rate independent; close enough lands on it. */
export function approach(cur: number, target: number, dt: number, tau: number): number {
  const v = target + (cur - target) * Math.exp(-dt / tau)
  return Math.abs(v - target) < 1e-3 ? target : v
}

type Run = { id: string; role: string; state: 'active' | 'done' }
export type RoleGroup = { role: string; state: 'active' | 'done'; running: string[] }

/** A chat's subagent runs folded into one row per role, first-seen order: active while any runs. */
export function groupRoles(runs: Run[]): RoleGroup[] {
  const by = new Map<string, RoleGroup>()
  for (const r of runs) {
    const g = by.get(r.role) ?? { role: r.role, state: 'done', running: [] }
    if (r.state === 'active') { g.state = 'active'; g.running.push(r.id) }
    by.set(r.role, g)
  }
  return [...by.values()]
}

/** Satellites per row around a role bubble; two rows at most, the count badge says the rest. */
export const SAT_ROW = 6
/** Where the i-th of n satellites sits: its row, and its place across the row in slots from the outward line. */
export function satSlot(i: number, n: number): { row: number; at: number } | undefined {
  const row = Math.floor(i / SAT_ROW)
  if (row > 1) return undefined
  const inRow = Math.min(SAT_ROW, n - row * SAT_ROW)
  return { row, at: (i % SAT_ROW) - (inRow - 1) / 2 }
}

/**
 * Whether the orbit picture moves, so its frame loop runs: a working chat (spin, sparks, pulse), a chat
 * waiting on you (its pulse), any active role (turning arc), a tool pill still fading, or a change still
 * settling (a bubble gliding, fading or changing color). Anything else is drawn once.
 */
export function orbitMoves(c: { state: ChatState; progress?: { roles?: { role: string; state: string }[] } }, pillAges: number[], showTools: boolean, settling = false): boolean {
  return settling || c.state === 'working' || c.state === 'needs-you' || (c.progress?.roles ?? []).some(r => r.state === 'active')
    || (showTools && pillAges.some(a => a < PILL_MS))
}
