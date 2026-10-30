/** Pure parts of the center picture's other styles: Relay, Lanes, Constellation and Deck. */
import type { ChatProgress, RoleStep, ToolCall } from './hub-types'
import { groupRoles } from './orbit-motion'
import { ORDER } from '../components/switchboard/look'

export const VIEWS = ['orbit', 'relay', 'lanes', 'constellation', 'deck'] as const
export type View = (typeof VIEWS)[number]
export const VIEW_KEY = 'switchboard.orbitView'
export const parseView = (v: string | null | undefined): View => (VIEWS as readonly string[]).includes(v ?? '') ? v as View : 'orbit'

export type RoleState = 'active' | 'done' | 'waiting' | 'unused'
/** running: subagents of this role still at work. task: its task now, next, or last done. */
export type TeamRole = { role: string; state: RoleState; runs: RoleStep[]; running: number; task?: string; tools: ToolCall[] }

const rank = (r: string) => { const i = ORDER.indexOf(r); return i < 0 ? 100 : i }

/** The chat's roles in plan order, extras after; researcher, engineer and qa always, so a picture never looks empty. */
export function teamOf(p?: ChatProgress): TeamRole[] {
  const runs = p?.roles ?? [], tasks = p?.tasks ?? [], tools = p?.tools ?? []
  const groups = new Map(groupRoles(runs).map(g => [g.role, g]))
  const names = [...new Set([...groups.keys(), ...tasks.flatMap(t => t.role ? [t.role] : []), 'researcher', 'engineer', 'qa'])]
  return names.sort((a, b) => rank(a) - rank(b)).map(role => {
    const g = groups.get(role), mine = tasks.filter(t => t.role === role)
    const task = (mine.find(t => t.status === 'in_progress') ?? mine.find(t => t.status === 'pending') ?? mine.filter(t => t.status === 'completed').at(-1))?.subject
    return {
      role, state: g?.state ?? (mine.some(t => t.status !== 'completed') ? 'waiting' : 'unused'),
      runs: runs.filter(r => r.role === role), running: g?.running.length ?? 0, task, tools: tools.filter(t => t.role === role),
    }
  })
}

/** Each time a plan role ran again after a later role had started (qa sending work back), with when. */
export function loopBacks(p?: ChatProgress): Array<{ role: string; at: number }> {
  const seen = new Set<string>(), out: Array<{ role: string; at: number }> = []
  let top = -1
  for (const r of [...(p?.roles ?? [])].sort((a, b) => a.startedAt - b.startedAt)) {
    const k = rank(r.role)
    if (k === 100) continue
    if (seen.has(r.role) && k < top) out.push({ role: r.role, at: r.startedAt })
    seen.add(r.role); top = Math.max(top, k)
  }
  return out
}
export const loopsOf = (p?: ChatProgress) => loopBacks(p).length

export type Span = { id: string; from: number; to: number; state: 'active' | 'done'; track: number }
export type LeadSpan = { from: number; to: number; kind: 'working' | 'needs' | 'done' | 'idle' }
export type Timeline = { t0: number; t1: number; lead: LeadSpan[]; rows: Array<{ role: string; runs: Span[]; tracks: number; tools: ToolCall[] }>; leadTools: ToolCall[]; asked?: number; done?: number }

/**
 * Who worked when. Progress keeps each run's start only, so a finished run ends at its role's last tool call
 * after it started, else its role's last task done, else the next run's start, else the chat's end.
 * Starts before the chat (Jev's 0) clamp to its start.
 */
export function timeline(p: ChatProgress, now: number): Timeline {
  const t0 = p.startedAt
  let t1 = p.state === 'working' || p.state === 'needs-you' ? now : p.state === 'done' ? p.finishedAt ?? p.at : p.at
  t1 = Math.max(t1, t0 + 60e3)
  const starts = p.roles.map(r => Math.max(t0, r.startedAt)).sort((a, b) => a - b)
  const rows = teamOf(p).map(m => {
    const ends: number[] = []
    const runs = [...m.runs].sort((a, b) => a.startedAt - b.startedAt).map(r => {
      const from = Math.max(t0, r.startedAt)
      let to = t1
      if (r.state === 'done') {
        const seen = [...m.tools.map(t => t.at), ...p.tasks.filter(t => t.role === m.role && t.doneAt !== undefined).map(t => t.doneAt!)].filter(at => at >= from && at <= t1)
        to = seen.length ? Math.max(...seen) : starts.find(s => s > from) ?? t1
      }
      // A run takes the first track free when it starts.
      let track = ends.findIndex(e => e <= from)
      if (track < 0) { track = ends.length; ends.push(0) }
      ends[track] = to
      return { id: r.id, from, to: Math.max(to, from), state: r.state, track }
    })
    return { role: m.role, runs, tracks: Math.max(1, ends.length), tools: m.tools.filter(t => t.at >= t0 && t.at <= t1) }
  })
  const asked = p.state === 'needs-you' && p.at > t0 ? p.at : undefined
  const kind = p.state === 'done' ? 'done' : p.state === 'idle' ? 'idle' : 'working'
  const lead: LeadSpan[] = asked ? [{ from: t0, to: asked, kind: 'working' }, { from: asked, to: t1, kind: 'needs' }] : [{ from: t0, to: t1, kind }]
  return { t0, t1, lead, rows, leadTools: (p.tools ?? []).filter(t => t.role === 'lead' && t.at >= t0 && t.at <= t1), asked, done: p.state === 'done' ? t1 : undefined }
}

export type LaneBar = { from: number; to: number; count: number; state: 'active' | 'done'; ids: string[] }
/**
 * A role's runs as few, readable bars: runs that overlap or nearly touch merge into one bar that counts them,
 * and every bar is at least min of the chart wide (kept inside it), so none is a sliver.
 */
export function laneBars(runs: Span[], t0: number, t1: number, min = 0.03): LaneBar[] {
  const out: LaneBar[] = [], w = min * (t1 - t0)
  for (const r of [...runs].sort((a, b) => a.from - b.from)) {
    const last = out.at(-1)
    if (last && r.from < last.to + w / 2) {
      last.to = Math.max(last.to, r.to); last.count++; last.ids.push(r.id)
      if (r.state === 'active') last.state = 'active'
    } else out.push({ from: r.from, to: r.to, count: 1, state: r.state, ids: [r.id] })
  }
  for (const b of out) if (b.to - b.from < w) {
    b.to = Math.min(t1, b.from + w); b.from = Math.max(t0, b.to - w)
  }
  return out
}

const STEPS = [0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 180, 240, 360, 720, 1440]
const minutes = (m: number) => m === 0 ? '0' : m < 1 ? `${Math.round(m * 60)}s` : m < 60 ? `${m}m` : m % 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m / 60}h`
/** Lanes' scale when the chat is too long to fit: wide enough for a run label every couple of minutes. */
export const PX_PER_MIN = 40
/** The timeline's width in px: the minute scale, or the visible width if that is wider. */
export const trackWidth = (t0: number, t1: number, visible: number) => Math.max(visible, ((t1 - t0) / 60e3) * PX_PER_MIN)
/** Round marks from 0, at least gap px apart, none in the last 56px where the now (or finish) label sits. */
export function axisTicks(t0: number, t1: number, px = 1000, gap = 200): Array<{ at: number; label: string }> {
  const perMin = px / ((t1 - t0) / 60e3)
  const step = STEPS.find(s => s * perMin >= gap) ?? 1440
  const n = Math.floor((px - 56) / (step * perMin) + 1e-9) + 1
  return Array.from({ length: Math.max(1, n) }, (_, i) => ({ at: t0 + i * step * 60e3, label: minutes(i * step) }))
}

/** Constellation's stage height: a phone gets taller as the team grows, so seven roles still fit. */
export const ringHeight = (w: number, n: number) => w < 560 ? 440 + Math.max(0, n - 5) * 30 : 400

/**
 * Constellation's layout: the lead in the middle, each role on its own fixed bearing, on the inner ring
 * while it works and the outer ring otherwise, so a change is one calm move in or out and nothing crosses.
 * The inner ring widens only as far as its nodes and labels need. nr: node radius; label: label width.
 */
export function rings(team: Array<{ role: string; state: string }>, w: number, h: number) {
  const nr = 16, lr = 26, label = w < 560 ? 84 : 100
  const cy = (h - 32) / 2, cx = w / 2
  const ry = cy - nr - 8, rx = Math.min(w / 2 - label / 2 - 6, ry * 2.2)
  const you = { x: 30, y: 26 }
  const n = Math.max(1, team.length)
  const angle: Record<string, number> = {}
  team.forEach((m, i) => { angle[m.role] = -Math.PI / 2 + (i * 2 * Math.PI) / n + (n % 2 ? 0 : Math.PI / n) })
  const box = (x: number, y: number) => ({ l: x - label / 2, r: x + label / 2, t: y - nr, b: y + nr + 32 })
  // The lead and the line under it, fitted to leadW.
  const leadW = label + 16
  const fixed = [{ l: cx - leadW / 2, r: cx + leadW / 2, t: cy - lr, b: cy + lr + 22 }, { l: you.x - 16, r: you.x + 16, t: you.y - 16, b: you.y + 34 }]
  const hit = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) => a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b
  let s = 0.46, at: Record<string, { x: number; y: number; ring: 'inner' | 'outer' }> = {}
  for (; s <= 0.86; s += 0.02) {
    at = {}
    for (const m of team) {
      const k = m.state === 'active' ? s : 1, a = angle[m.role]
      at[m.role] = { x: cx + Math.cos(a) * rx * k, y: cy + Math.sin(a) * ry * k, ring: k < 1 ? 'inner' : 'outer' }
    }
    const inner = team.filter(m => m.state === 'active').map(m => box(at[m.role].x, at[m.role].y))
    const all = team.map(m => box(at[m.role].x, at[m.role].y))
    if (inner.every(b => !fixed.some(f => hit(b, f)) && all.filter(o => o !== b && !(o.l === b.l && o.t === b.t)).every(o => !hit(b, o)))) break
  }
  return { cx, cy, rx, ry, inner: s, lr, nr, label, leadW, you, angle, at }
}
