import type { ChatProgress, ChatState } from '@/lib/hub-types'

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
export const missedCount = (p?: ChatProgress) => (p?.asked ?? []).filter((_, i) => coverage(p!, i) === 'missed').length
/** Done, but the standup still lists Left items or a request went uncovered: teal, not the full green. */
export const almostDone = (p?: ChatProgress) => p?.state === 'done' && (!!p.report?.left.length || missedCount(p) > 0)
export const ALMOST = { label: 'Almost done', color: 'var(--hub-teal)', soft: 'var(--hub-teal-soft)', key: 'teal' as Key }
/** The roles in plan order; the ring follows it. */
export const ORDER = ['researcher', 'engineer', 'qa', 'designer', 'ops', 'growth']
export const repoOf = (cwd: string) => cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd
export const ago = (at: number, now = Date.now()) => {
  const m = Math.round((now - at) / 60e3)
  return m < 1 ? 'now' : m < 60 ? `${m} min` : m < 36 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`
}
export const panel = { border: '1px solid var(--hub-hair)', borderRadius: 10, background: 'var(--hub-elev)', padding: 14, display: 'grid', gap: 10, alignContent: 'start', minWidth: 0 } as const
export const caps = { font: '500 12px/1 var(--hub-mono)', color: 'var(--hub-ash)', textTransform: 'uppercase', letterSpacing: 0.4, display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: '4px 12px', margin: 0 } as const
