'use client'
// Lanes: who worked when, one lane per role that took part, on the chat's own clock (0 is when it started).
// Overlapping runs of a role are one bar with a count; tool calls are faint ticks with detail on hover;
// a loop back is one marker. Unused roles fold into a line below. Timings are derived, see timeline().
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'
import { almostDone } from '../look'
import { axisTicks, laneBars, loopBacks, teamOf, timeline, trackWidth, type LaneBar } from '@/lib/orbit-views'
import type { ToolCall } from '@/lib/hub-types'
import { Glyph, NAME, Reveal, useLive, type ViewProps } from './parts'
import { describe } from '../orbit'
import { say } from '@/lib/eta'

const pct = (u: number) => `${(Math.min(1, Math.max(0, u)) * 100).toFixed(3)}%`
/** A bar from a to b (0..1) of the track. Its label sticks to the pinned column while the bar runs under it. */
const place = (a: number, b: number): CSSProperties => ({ left: pct(a), width: pct(b - a) })
const clock = (at: number) => new Date(at).toTimeString().slice(0, 5)
const WORD = { active: 'working', done: 'done', waiting: 'waiting', unused: 'not used' } as const

/** A commit message: its summary, then any body lines as bullets, wrapped as written. */
export function Commit({ text }: { text: string }) {
  const [head, ...rest] = text.trim().split('\n')
  const body = rest.map(l => l.trim()).filter(Boolean).map(l => l.replace(/^[-*•]\s*/, ''))
  return (
    <div className="ovl-commit">
      <code>{head}</code>
      {body.length > 0 && <ul>{body.map((l, i) => <li key={i}><code>{l}</code></li>)}</ul>}
    </div>
  )
}

export function Lanes({ chat, showTools }: ViewProps) {
  const root = useRef<HTMLDivElement>(null), scroller = useRef<HTMLDivElement>(null)
  useLive(root)
  // The whole chat on a fixed minute scale; the chart scrolls sideways and opens at now. While the view sits at
  // the end it stays there as the chart grows; scrolling back unpins it.
  const [box, setBox] = useState({ vw: 0, lw: 148 }), [at, setAt] = useState({ start: true, end: true })
  const stick = useRef(true), drag = useRef<{ x: number; l: number } | null>(null)
  useEffect(() => {
    const s = scroller.current
    if (!s) return
    const ro = new ResizeObserver(() => setBox({ vw: s.clientWidth, lw: parseFloat(getComputedStyle(s).getPropertyValue('--lw')) || 148 }))
    ro.observe(s)
    return () => ro.disconnect()
  }, [])
  const p = chat.progress, almost = almostDone(p)
  const tl = p && timeline(p, Date.now())
  const px = tl ? trackWidth(tl.t0, tl.t1, Math.max(0, box.vw - box.lw)) : 0
  const sync = () => {
    const s = scroller.current
    if (!s) return
    const max = s.scrollWidth - s.clientWidth
    stick.current = s.scrollLeft >= max - 4
    setAt(o => o.start === s.scrollLeft <= 4 && o.end === stick.current ? o : { start: s.scrollLeft <= 4, end: stick.current })
  }
  useLayoutEffect(() => { const s = scroller.current; if (s && stick.current) s.scrollLeft = s.scrollWidth; sync() })
  const go = (left: number) => {
    const s = scroller.current
    if (s) s.scrollTo({ left, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const s = e.currentTarget, by = { ArrowLeft: -160, ArrowRight: 160 }[e.key]
    if (by) s.scrollBy({ left: e.shiftKey ? by * 4 : by })
    else if (e.key === 'Home') go(0)
    else if (e.key === 'End') go(s.scrollWidth)
    else return
    e.preventDefault()
  }
  // Mouse drag pans; touch and trackpads scroll natively.
  const down = (e: PointerEvent<HTMLDivElement>) => { if (e.pointerType === 'mouse' && e.button === 0 && !(e.target as Element).closest('button')) drag.current = { x: e.clientX, l: e.currentTarget.scrollLeft } }
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = drag.current, s = e.currentTarget
    if (!d || (!s.hasAttribute('data-drag') && Math.abs(e.clientX - d.x) < 4)) return
    if (!s.hasAttribute('data-drag')) { s.setAttribute('data-drag', ''); s.setPointerCapture(e.pointerId) }
    s.scrollLeft = d.l - (e.clientX - d.x)
  }
  const up = (e: PointerEvent<HTMLDivElement>) => { drag.current = null; e.currentTarget.removeAttribute('data-drag') }
  if (!tl) return (
    <div ref={root} className="ov-stage ov-lanes" role="img" aria-label={describe(chat)}>
      <p className="ov-empty">Nothing on the clock yet. Lanes fill in as the lead and its roles start work.</p>
    </div>
  )

  const team = teamOf(p), loops = loopBacks(p)
  const shown = team.filter(m => m.state !== 'unused'), unused = team.filter(m => m.state === 'unused')
  const f = (t: number) => (t - tl.t0) / (tl.t1 - tl.t0)
  const axis = axisTicks(tl.t0, tl.t1, px, Math.max(110, (box.vw - box.lw) / 5))
  const over = px > box.vw - box.lw + 1
  const lead = chat.state === 'working' ? 'active' : chat.state === 'needs-you' ? 'needs' : chat.state === 'done' ? (almost ? 'almost' : 'done') : 'idle'
  const leadWord = { active: 'working', needs: 'needs you', done: 'finished', almost: 'almost done', idle: 'stopped' }[lead]
  const end = chat.state === 'working' || chat.state === 'needs-you' ? 'now' : `${chat.state === 'done' ? 'done' : 'stopped'} ${clock(tl.t1)}`

  const grid = <span className="ovl-grid" aria-hidden>{axis.slice(1).map(t => <i key={t.label} style={{ left: pct(f(t.at)) }} />)}</span>
  const ticks = (list: ToolCall[]) => showTools && list.map(t =>
    <i key={`${t.at}:${t.tool}`} className="ovl-tick" style={{ left: pct(f(t.at)) }} title={`${t.tool}${t.target ? ` ${t.target}` : ''} · ${new Date(t.at).toTimeString().slice(0, 8)}`} />)
  const label = (k: string, name: string, word: string, s: string, model?: string) => (
    <div className="ovl-label" data-s={s}>
      <Glyph k={k} size={14} />
      <span><b>{name}</b><small><span className="ovl-word">{word}</span>{model ? ` · ${model}` : ''}</small></span>
    </div>
  )
  // A bar too narrow for its label: the lane's last one says it beside itself, on the side with room; earlier ones stay quiet.
  const bar = (b: LaneBar, text: string, last: boolean) => {
    const a = f(b.from), z = f(b.to), inside = (z - a) * px >= 72, tag = <>{b.count > 1 && <b>×{b.count}</b>}{text}</>
    return [
      <span key={b.ids[0]} className="ovl-bar" data-s={b.state} style={place(a, z)}>{inside && <span>{tag}</span>}</span>,
      !inside && last && <span key={`${b.ids[0]}:t`} className="ovl-tag" data-s={b.state} style={a > 0.5 ? { right: `calc(${pct(1 - a)} + 6px)` } : { left: `calc(${pct(z)} + 6px)` }}>{tag}</span>,
    ]
  }

  return (
    <div ref={root} className="ov-stage ov-lanes" data-chat={lead}>
      <div ref={scroller} className="ovl-scroll" tabIndex={over ? 0 : -1} role="region" aria-label="Timeline, scrolls sideways"
        data-over={over || undefined} onScroll={sync} onKeyDown={keys} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <div className="ovl-chart" style={box.vw ? { width: box.lw + px } : undefined} role="img" aria-label={`${describe(chat)} Timeline from ${clock(tl.t0)} to ${end === 'now' ? 'now' : clock(tl.t1)}.`}>
          <div className="ovl-row ovl-axis">
            <div className="ovl-label ovl-jump">
              {over && <>
                <button type="button" tabIndex={-1} disabled={at.start} onClick={() => go(0)}>Start</button>
                <button type="button" tabIndex={-1} disabled={at.end} onClick={() => go(scroller.current?.scrollWidth ?? 0)}>{end === 'now' ? 'Now' : 'End'}</button>
              </>}
            </div>
            <div className="ovl-track">
              {axis.map(t => <span key={t.label} style={{ left: pct(f(t.at)) }}>{t.label}</span>)}
              <span className="ovl-end">{end}</span>
            </div>
          </div>

          <div className="ovl-row" data-s={lead}>
            {label('lead', 'Lead', leadWord, lead, chat.live?.model)}
            <div className="ovl-track">
              {grid}
              <span className="ovl-bar ovl-lead" style={place(0, tl.asked ? f(tl.asked) : 1)} />
              {tl.asked && <span className="ovl-wait" style={{ left: pct(f(tl.asked)) }}><b>Waiting on you</b></span>}
              {ticks(tl.leadTools)}
            </div>
          </div>

          {shown.map(m => {
            const row = tl.rows.find(r => r.role === m.role)!, bars = laneBars(row.runs, tl.t0, tl.t1, 8 / px)
            return (
              <div key={m.role} className="ovl-row" data-s={m.state}>
                {label(m.role, NAME(m.role), WORD[m.state], m.state, chat.models?.[m.role])}
                <div className="ovl-track">
                  {grid}
                  {bars.map((b, i) => bar(b, i === bars.length - 1 && m.task ? m.task : bars.length > 1 ? `Run ${i + 1}` : say(b.to - b.from).replace(/^about /, ''), i === bars.length - 1))}
                  {!bars.length && <span className="ovl-queued">{m.task ? `next: ${m.task}` : 'waiting'}</span>}
                  {loops.filter(l => l.role === m.role).map(l => <span key={l.at} className="ovl-loop" style={{ left: pct(f(Math.max(tl.t0, l.at))) }} title="Sent back after a later role started">↺</span>)}
                  {ticks(row.tools)}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {unused.length > 0 && <p className="ovl-unused">Not used: {unused.map(m => NAME(m.role)).join(', ')}</p>}
      <Reveal on={chat.state === 'needs-you'} className="ov-call"><span data-tone="needs"><b>Needs you</b>{p?.question ?? 'This chat is waiting on you.'}</span></Reveal>
      <Reveal on={chat.state === 'done'} className="ov-call"><span data-tone={almost ? 'almost' : 'done'}><b>{almost ? 'Almost done' : 'Finished'}</b>{p?.commit ? <Commit text={p.commit} /> : 'No commit message.'}</span></Reveal>
      <p className="ov-legend" aria-hidden>
        <span style={{ '--c': 'var(--hub-blue)' } as CSSProperties}><i />working</span>
        <span style={{ '--c': almost ? 'var(--hub-teal)' : 'var(--hub-green)' } as CSSProperties}><i />done</span>
        <span style={{ '--c': 'var(--hub-red)' } as CSSProperties}><i />waiting on you</span>
        {showTools && <span className="ovl-key-tick">tool call</span>}
        {loops.length > 0 && <span>↺ sent back</span>}
      </p>
    </div>
  )
}
