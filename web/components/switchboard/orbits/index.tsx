'use client'
// The center picture in the style this viewer picked: Orbit (the default), Relay, Lanes, Constellation or Deck.
// Same props as Orbit; the pick lives in localStorage like the tool-calls switch.
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { VIEWS, VIEW_KEY, parseView, type View } from '@/lib/orbit-views'
import { Orbit } from '../orbit'
import { Relay } from './relay'
import { Lanes } from './lanes'
import { Constellation } from './constellation'
import { Deck } from './deck'
import type { ViewProps } from './parts'
import './orbits.css'

const TITLE: Record<View, string> = { orbit: 'Orbit', relay: 'Relay', lanes: 'Lanes', constellation: 'Constellation', deck: 'Deck' }
const PICTURE = { relay: Relay, lanes: Lanes, constellation: Constellation, deck: Deck }

export function OrbitView(props: ViewProps) {
  const [view, setView] = useState<View>('orbit')
  const group = useRef<HTMLDivElement>(null)
  useEffect(() => { try { setView(parseView(localStorage.getItem(VIEW_KEY))) } catch { /* no storage: Orbit */ } }, [])
  const pick = (v: View, focus = false) => {
    setView(v)
    try { localStorage.setItem(VIEW_KEY, v) } catch { /* no storage */ }
    if (focus) group.current?.querySelector<HTMLElement>(`[data-v="${v}"]`)?.focus()
  }
  // Arrows move the choice, as a radio group does; Home and End jump to the ends.
  const keys = (e: KeyboardEvent) => {
    const i = VIEWS.indexOf(view), n = VIEWS.length
    const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? (i + 1) % n : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? (i + n - 1) % n : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : -1
    if (to < 0) return
    e.preventDefault(); pick(VIEWS[to], true)
  }
  const Picture = view === 'orbit' ? null : PICTURE[view]
  return (
    <div className="ov">
      <div ref={group} role="radiogroup" aria-label="Picture style" className="ov-seg hub-seg" onKeyDown={keys}>
        {VIEWS.map(v => <button key={v} type="button" role="radio" data-v={v} aria-checked={v === view} tabIndex={v === view ? 0 : -1} onClick={() => pick(v)}>{TITLE[v]}</button>)}
      </div>
      {/* A new style or chat fades in; picked from the keyboard (instant), it just swaps. */}
      {Picture ? <div key={`${view}:${props.chat.id}`} className="ov-fade" data-instant={props.instant || undefined}><Picture {...props} /></div>
        : <Orbit {...props} />}
    </div>
  )
}
