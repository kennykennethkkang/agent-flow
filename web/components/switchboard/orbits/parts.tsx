'use client'
// Bits the four extra pictures share: role glyphs, labels, the on-screen check, and Reveal for callouts.
import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { RoleState } from '@/lib/orbit-views'
import { vscodeBridge } from '@/lib/vscode-bridge'
import type { OrbitChat } from '../orbit'

export type ViewProps = { chat: OrbitChat; showTools: boolean; instant?: boolean }

export const NAME = (r: string) => r === 'qa' ? 'QA' : r ? r[0].toUpperCase() + r.slice(1) : r
export const LABEL: Record<RoleState, string> = { active: 'working', done: 'done', waiting: 'queued', unused: 'not used' }

// 16x16 strokes; f marks a filled shape. Drawn as SVG here and as Path2D on the Constellation canvas.
type Shape = { d?: string; c?: [number, number, number]; r?: [number, number, number, number, number]; f?: true }
export const GLYPHS: Record<string, Shape[]> = {
  you: [{ c: [8, 5.5, 2.5] }, { d: 'M3 13.5a5 5 0 0 1 10 0' }],
  lead: [{ c: [8, 8, 5.5] }, { c: [8, 8, 2], f: true }],
  researcher: [{ c: [7, 7, 4] }, { d: 'm10 10 3.5 3.5' }],
  engineer: [{ d: 'M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5' }],
  qa: [{ d: 'M8 2 3 4v4c0 3 2.2 5 5 6 2.8-1 5-3 5-6V4z' }, { d: 'm5.8 8 1.6 1.6 3-3.2' }],
  designer: [{ d: 'M10.5 2.5 13.5 5.5 6 13H3v-3z' }],
  ops: [{ r: [2.5, 3, 11, 4, 1] }, { r: [2.5, 9, 11, 4, 1] }, { d: 'M5 5h.01M5 11h.01' }],
  growth: [{ d: 'm2.5 11.5 4-4 2.5 2.5 4.5-5' }, { d: 'M10 5h3.5v3.5' }],
  jev: [{ d: 'M8 2.5 9.4 6.6 13.5 8 9.4 9.4 8 13.5 6.6 9.4 2.5 8 6.6 6.6z' }],
  commit: [{ c: [8, 8, 2.6] }, { d: 'M1.5 8h3.9M10.6 8h3.9' }],
  other: [{ c: [8, 8, 4.5] }],
}
export const glyphOf = (k: string) => GLYPHS[k] ?? GLYPHS.other

export function Glyph({ k, size = 16 }: { k: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={(1.5 * 16) / size} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {glyphOf(k).map((s, i) => s.d ? <path key={i} d={s.d} />
        : s.c ? <circle key={i} cx={s.c[0]} cy={s.c[1]} r={s.c[2]} fill={s.f ? 'currentColor' : 'none'} stroke={s.f ? 'none' : undefined} />
        : <rect key={i} x={s.r![0]} y={s.r![1]} width={s.r![2]} height={s.r![3]} rx={s.r![4]} />)}
    </svg>
  )
}

/** Whether the picture can be seen: on screen, tab shown, and the VS Code panel open. Sets data-paused on el so CSS loops stop. */
export function useLive(el: RefObject<HTMLElement | null>): boolean {
  const [live, setLive] = useState(true)
  useEffect(() => {
    const node = el.current
    if (!node) return
    let on = true
    const check = () => { const v = on && !document.hidden && vscodeBridge?.shown !== false; node.toggleAttribute('data-paused', !v); setLive(v) }
    const io = new IntersectionObserver(([e]) => { on = e.isIntersecting; check() }); io.observe(node)
    document.addEventListener('visibilitychange', check)
    const off = vscodeBridge?.onShown(check)
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', check); off?.() }
  }, [el])
  return live
}

/** Shows children while `on`, and keeps the last ones through a fade and collapse when it goes off. */
export function Reveal({ on, children, className }: { on: boolean; children: ReactNode; className?: string }) {
  const last = useRef(children)
  if (on) last.current = children
  return (
    <div className="ov-reveal" data-on={on || undefined} aria-hidden={!on || undefined} inert={!on || undefined}>
      <div className={className}>{last.current}</div>
    </div>
  )
}

/** The colors behind a state, as CSS vars, for the DOM pictures. */
export const TONE: Record<string, string> = {
  active: 'var(--hub-blue)', working: 'var(--hub-blue)', done: 'var(--hub-green)', almost: 'var(--hub-teal)',
  needs: 'var(--hub-red)', idle: 'var(--hub-yellow)', waiting: 'var(--hub-mute)', unused: 'var(--hub-ash)',
}

/** The lead's look by chat state: working, needs, done (or almost), idle. */
export const leadState = (c: OrbitChat, almost: boolean) => c.state === 'working' ? 'working' : c.state === 'needs-you' ? 'needs' : c.state === 'done' ? (almost ? 'almost' : 'done') : 'idle'

/** The line under the lead, same words as the Orbit's. */
export function leadLine(c: OrbitChat, almost: boolean, active: string[]): string {
  if (c.state === 'working') return active.length ? `${active.length > 1 ? `${active.length} roles` : active[0]} working` : 'planning'
  if (c.state === 'needs-you') return 'waiting on you'
  if (c.state === 'done') return almost ? 'almost done' : 'finished'
  return `idle ${c.ago}`
}

/** The legend under a picture. */
export function Legend({ tools, almost }: { tools: boolean; almost: boolean }) {
  const keys: Array<[string, string]> = [['working', TONE.active], ...(tools ? [['tool call', 'var(--hub-yellow)'] as [string, string]] : []), ['done', TONE.done], ...(almost ? [['almost done', TONE.almost] as [string, string]] : []), ['needs you', TONE.needs]]
  return <p className="ov-legend" aria-hidden>{keys.map(([l, c]) => <span key={l} style={{ '--c': c } as React.CSSProperties}><i />{l}</span>)}</p>
}
