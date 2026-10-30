import type { ChatProgress, ChatState, WindowColor, WindowInfo } from '@/lib/hub-types'
import { windowOf } from '../../lib/windows'

type Key = 'blue' | 'green' | 'red' | 'yellow' | 'teal'
/** key: the --hub-* color the orbit canvas reads for this state. */
export const STATE: Record<ChatState, { label: string; color: string; soft: string; key: Key }> = {
  working: { label: 'Working', color: 'var(--hub-blue)', soft: 'var(--hub-blue-soft)', key: 'blue' },
  done: { label: 'Finished', color: 'var(--hub-green)', soft: 'var(--hub-green-soft)', key: 'green' },
  'needs-you': { label: 'Needs you', color: 'var(--hub-red)', soft: 'var(--hub-red-soft)', key: 'red' },
  idle: { label: 'Idle', color: 'var(--hub-yellow)', soft: 'var(--hub-yellow-soft)', key: 'yellow' },
}
/** Jev's verdict on Kenneth's request i: covered, missed (MISSED in progress.ts), or unknown. */
export const coverage = (p: ChatProgress, i: number) => { const s = p.covered?.[i]; return s == null ? undefined : s <= 0.2 ? 'missed' : s >= 0.8 ? 'covered' : undefined }
// Scores for another set of asks (a prompt came after the check) count for nothing.
export const missedCount = (p?: ChatProgress) => p?.covered?.length !== p?.asked?.length ? 0 : (p?.asked ?? []).filter((_, i) => coverage(p!, i) === 'missed').length
/** Done, but a request went uncovered: teal, not the full green. Left items are future work in the to-do. */
export const almostDone = (p?: ChatProgress) => p?.state === 'done' && missedCount(p) > 0
export const ALMOST = { label: 'Almost done', color: 'var(--hub-teal)', soft: 'var(--hub-teal-soft)', key: 'teal' as Key }
/** The roles in plan order; the ring follows it. */
export const ORDER = ['researcher', 'engineer', 'qa', 'designer', 'ops', 'growth']
export const repoOf = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd
export const ago = (at: number, now = Date.now()) => {
  const m = Math.round((now - at) / 60e3)
  return m < 1 ? 'now' : m < 60 ? `${m} min` : m < 36 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`
}
// Section heads read their look from tokens, so a layout can restyle them without touching each component.
export const panel = { border: '1px solid var(--hub-hair)', borderRadius: 'var(--hub-r-panel, 10px)', background: 'var(--hub-elev)', padding: 'var(--hub-pad-panel, 14px)', display: 'grid', gap: 10, alignContent: 'start', minWidth: 0 } as const
export const caps = { font: 'var(--hub-caps-font, 500 12px/1 var(--hub-mono))', color: 'var(--hub-caps-color, var(--hub-ash))', textTransform: 'var(--hub-caps-case, uppercase)' as 'uppercase', letterSpacing: 'var(--hub-caps-track, 0.4px)', display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '4px 12px', margin: 0 } as const
/** A small field label (Today's rows, the receipt). */
export const label = { font: 'var(--hub-label-font, 500 12px/1.4 var(--hub-mono))', color: 'var(--hub-ash)', textTransform: 'var(--hub-label-case, uppercase)' as 'uppercase', letterSpacing: 'var(--hub-label-track, 0.4px)', margin: 0 } as const

// Spelled out: Tailwind drops a custom property whose name never appears in the sources.
export const WINDOW_VAR: Record<WindowColor, string> = {
  violet: 'var(--hub-w-violet)', amber: 'var(--hub-w-amber)', teal: 'var(--hub-w-teal)', rose: 'var(--hub-w-rose)', lime: 'var(--hub-w-lime)', cobalt: 'var(--hub-w-cobalt)',
}
/** The VS Code window holding a folder, with its color; keyed by workspace, never by name. */
export const placeOf = (cwd: string | undefined, windows: WindowInfo[] = []) => {
  const w = cwd ? windowOf(cwd, windows) : undefined
  return w ? { name: w.name, workspace: w.workspace, color: WINDOW_VAR[w.color] } : undefined
}
