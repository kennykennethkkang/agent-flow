'use client'
import type { ChatProfile } from '@/lib/hub-types'
import { caps } from './look'

export const chip = (on: boolean, flagged = false) => ({
  font: '500 12px/1 var(--hub-mono)', padding: '6px 10px', borderRadius: 99, cursor: 'pointer', display: 'inline-flex', gap: 6, alignItems: 'center',
  color: on ? 'var(--hub-ink)' : 'var(--hub-ash)', background: on ? 'var(--hub-blue-soft)' : 'transparent',
  border: `1px solid ${flagged ? 'var(--hub-yellow)' : on ? 'var(--hub-blue)' : 'var(--hub-hair)'}`,
}) as const

// Mirrors ALWAYS in extension/src/hub/tools.ts: on in every chat, so superpowers planning is never lost.
const LOCKED = ['superpowers', 'ponytail', 'code-review', 'context7', 'playwright']

/** A chat's plugins and skills as toggle chips. Flagged plugins carry a warning and are never on unless pressed. */
export function ToolChips({ profile, flagged, onChange }: { profile: ChatProfile; flagged: string[]; onChange: (p: ChatProfile) => void }) {
  const group = (kind: 'plugins' | 'skills', label: string) => {
    const names = Object.keys(profile[kind]).sort()
    if (!names.length) return null
    return (
      <div style={{ display: 'grid', gap: 6 }}>
        <h4 style={caps}><span>{label}</span><span>{names.filter(n => profile[kind][n]).length} of {names.length} on</span></h4>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {names.map(n => {
            const on = profile[kind][n], warn = kind === 'plugins' && flagged.includes(n)
            const locked = kind === 'plugins' && LOCKED.includes(n.split('@')[0])
            return (
              <button key={n} type="button" aria-pressed={on} disabled={locked} style={{ ...chip(on, warn), ...(locked ? { cursor: 'default' } : {}) }}
                title={warn ? `${n}: flagged by a scan, never turned on automatically` : locked ? `${n.split('@')[0]}: always on in every chat` : n}
                onClick={() => onChange({ ...profile, [kind]: { ...profile[kind], [n]: !on } })}>
                {warn && <span aria-label="flagged" style={{ color: 'var(--hub-yellow)' }}>!</span>}
                {kind === 'plugins' ? n.split('@')[0] : n}
              </button>
            )
          })}
        </div>
      </div>
    )
  }
  return <div style={{ display: 'grid', gap: 10 }}>{group('plugins', 'Plugins')}{group('skills', 'Skills')}</div>
}
