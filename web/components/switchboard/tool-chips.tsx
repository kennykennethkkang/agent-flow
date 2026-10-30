'use client'
import { useState } from 'react'
import type { ChatProfile } from '@/lib/hub-types'
import { caps } from './look'

export const chip = (on: boolean, flagged = false) => ({
  font: '500 12px/1 var(--hub-mono)', padding: '6px 10px', borderRadius: 99, cursor: 'pointer', display: 'inline-flex', gap: 6, alignItems: 'center',
  color: on ? 'var(--hub-ink)' : 'var(--hub-ash)', background: on ? 'var(--hub-blue-soft)' : 'transparent',
  border: `1px solid ${flagged ? 'var(--hub-yellow)' : on ? 'var(--hub-blue)' : 'var(--hub-hair)'}`,
}) as const

// Mirrors ALWAYS in extension/src/hub/tools.ts: on in every chat, so superpowers planning is never lost.
const LOCKED = ['superpowers', 'ponytail', 'code-review', 'context7', 'playwright']

// Library keys are absolute paths (~/.claude/switchboard/design-md/<brand>/DESIGN.md); project ones are relative.
const isLib = (k: string) => /^([/\\]|[A-Za-z]:)/.test(k)
const brand = (k: string) => k.split(/[/\\]/).slice(-2)[0]

const link = { font: 'inherit', padding: 0, border: 0, background: 'none', color: 'var(--hub-blue)', cursor: 'pointer', textTransform: 'inherit' } as const

/** A chat's plugins, skills and design references as toggle chips. Flagged plugins carry a warning and are never on unless pressed; All skips them.
 *  tips: what each one does, by name, for the hover title. */
export function ToolChips({ profile, flagged, tips = {}, onChange }: { profile: ChatProfile; flagged: string[]; tips?: Record<string, string>; onChange: (p: ChatProfile) => void }) {
  const [find, setFind] = useState('')
  const group = (kind: 'plugins' | 'skills' | 'assets', label: string) => {
    const map = profile[kind] ?? {}
    const names = Object.keys(map).filter(n => !isLib(n)).sort()
    if (!names.length) return null
    const locked = (n: string) => kind === 'plugins' && LOCKED.includes(n.split('@')[0])
    const setAll = (on: boolean) => onChange({ ...profile, [kind]: { ...map, ...Object.fromEntries(names.map(n => [n, locked(n) ? true : kind === 'plugins' && flagged.includes(n) ? map[n] && on : on])) } })
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        <h4 style={caps}>
          <span>{label}</span>
          <span style={{ display: 'flex', gap: 10 }}>
            {names.filter(n => map[n]).length} of {names.length} on
            <button type="button" style={link} onClick={() => setAll(true)}>All</button>
            <button type="button" style={link} onClick={() => setAll(false)}>None</button>
          </span>
        </h4>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {names.map(n => {
            const on = map[n], warn = kind === 'plugins' && flagged.includes(n)
            const fixed = locked(n)
            return (
              <button key={n} type="button" aria-pressed={on} disabled={fixed} style={{ ...chip(on, warn), ...(fixed ? { cursor: 'default' } : {}) }}
                title={[warn ? `${n}: flagged: never turned on automatically` : fixed ? `${n.split('@')[0]}: always on in every chat` : n, tips[n]].filter(Boolean).join('\n')}
                onClick={() => onChange({ ...profile, [kind]: { ...map, [n]: !on } })}>
                {warn && <span aria-label="flagged" style={{ color: 'var(--hub-yellow)' }}>!</span>}
                {kind === 'plugins' ? n.split('@')[0] : n}
              </button>
            )
          })}
        </div>
      </div>
    )
  }
  // Library: only what is on shows; the filter finds more to turn on.
  const library = () => {
    const map = profile.assets ?? {}
    const keys = Object.keys(map).filter(isLib).sort((a, b) => brand(a).localeCompare(brand(b)))
    if (!keys.length) return null
    const q = find.trim().toLowerCase()
    const shown = keys.filter(k => map[k] || (q && brand(k).toLowerCase().includes(q))).slice(0, 24)
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        <h4 style={caps}><span>Design library</span><span>{keys.filter(k => map[k]).length} of {keys.length} on</span></h4>
        <input type="search" value={find} onChange={e => setFind(e.target.value)} placeholder={`Find a look (${keys.length})`} aria-label="Find a design library look"
          style={{ font: '500 12px/1 var(--hub-mono)', padding: '6px 10px', borderRadius: 99, minWidth: 0, background: 'transparent', color: 'var(--hub-ink)', border: '1px solid var(--hub-hair)' }} />
        {shown.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {shown.map(k => (
              <button key={k} type="button" aria-pressed={map[k]} style={chip(map[k])} title={k}
                onClick={() => onChange({ ...profile, assets: { ...map, [k]: !map[k] } })}>{brand(k)}</button>
            ))}
          </div>
        )}
        {q && !keys.some(k => brand(k).toLowerCase().includes(q)) && <p style={{ ...caps, textTransform: 'none' }}>No look matches "{find.trim()}".</p>}
      </div>
    )
  }
  return <div style={{ display: 'grid', gap: 10 }}>{group('plugins', 'Plugins')}{group('skills', 'Skills')}{group('assets', 'Design references')}{library()}</div>
}
