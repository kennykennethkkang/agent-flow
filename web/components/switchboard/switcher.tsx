'use client'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { rankItems, type SwitchItem } from '@/lib/switcher'
import { STATE } from './look'

const Marked = ({ text, hits }: { text: string; hits: number[] }) => {
  const on = new Set(hits)
  return <>{[...text].map((ch, i) => (on.has(i) ? <mark key={i}>{ch}</mark> : ch))}</>
}

/** Cmd+K: type part of a name, arrows to move, Enter to open, Esc to close. Focus stays in the dialog. */
export function Switcher({ items, onPick, onClose }: { items: SwitchItem[]; onPick: (item: SwitchItem) => void; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState(0)
  const input = useRef<HTMLInputElement>(null)
  const list = useId()
  const ranked = useMemo(() => rankItems(items, q).slice(0, 50), [items, q])
  const sel = Math.min(at, Math.max(0, ranked.length - 1))
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null
    input.current?.focus()
    return () => back?.focus?.()
  }, [])
  useEffect(() => { document.getElementById(`${list}-${sel}`)?.scrollIntoView({ block: 'nearest' }) }, [sel, list])
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setAt((sel + (e.key === 'ArrowDown' ? 1 : -1) + ranked.length) % Math.max(1, ranked.length)) }
    else if (e.key === 'Enter') { e.preventDefault(); if (ranked[sel]) onPick(ranked[sel].item) }
    else if (e.key === 'Escape') { e.preventDefault(); onClose() }
    // The input is the dialog's one stop: Tab stays in it.
    else if (e.key === 'Tab') e.preventDefault()
  }
  return (
    <div className="hub-scrim" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div role="dialog" aria-modal="true" aria-label="Find a chat" className="hub-palette" onKeyDown={key}>
        <input ref={input} value={q} onChange={e => { setQ(e.target.value); setAt(0) }} placeholder="Find a chat, live or in History"
          role="combobox" aria-expanded="true" aria-controls={list} aria-autocomplete="list" aria-activedescendant={ranked[sel] ? `${list}-${sel}` : undefined} />
        <ul id={list} role="listbox" aria-label="Chats">
          {ranked.map(({ item, hits }, i) => (
            <li key={`${item.kind}:${item.id}`} id={`${list}-${i}`} role="option" aria-selected={i === sel}
              onMouseMove={() => setAt(i)} onClick={() => onPick(item)}>
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                <Marked text={item.name} hits={hits} />{item.version > 1 && <span className="hub-chip ver" style={{ marginLeft: 6 }}>v{item.version}</span>}
              </span>
              {item.kind === 'live'
                ? <span className="hub-chip" style={{ color: STATE[item.state].color, background: STATE[item.state].soft }}><i aria-hidden />{STATE[item.state].label}</span>
                : <span style={{ font: '400 12px/1 var(--hub-mono)', color: 'var(--hub-ash)' }}>History</span>}
            </li>
          ))}
          {!ranked.length && <li role="presentation" style={{ color: 'var(--hub-ash)', cursor: 'default' }}>No chat matches.</li>}
        </ul>
        <p aria-hidden>↑↓ move · Enter open · Esc close</p>
      </div>
    </div>
  )
}
