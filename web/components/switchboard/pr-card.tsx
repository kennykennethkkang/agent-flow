'use client'
import type { ReactNode } from 'react'
import type { RepoView } from '@/lib/hub-types'
import { pill, short, summary } from '@/lib/pr-card'
import { usePopover } from './use-popover'

const mono = { font: '400 12px/1.5 var(--hub-mono)' } as const
const PALETTE = ['var(--hub-w-amber)', 'var(--hub-w-violet)', 'var(--hub-w-teal)', 'var(--hub-w-rose)', 'var(--hub-w-lime)']
const STATE: Record<string, string> = { OPEN: 'var(--hub-green)', MERGED: 'var(--hub-violet)', CLOSED: 'var(--hub-red)' }
const name = (p: string) => p.split('/').pop() ?? p
const cap = (s: string) => s.charAt(0) + s.slice(1).toLowerCase()

const Warn = () => <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round">
  <path d="M8 2 1.5 13.5h13L8 2Z" /><path d="M8 6.5v3.2M8 11.6v.1" strokeLinecap="round" /></svg>

/** The branch against its base, from readMerge: PR state, conflicts with the lines behind them, and both sides' recent commits. */
export function PrCard({ repo: r, create, busy, onOpen, onResolve }: {
  repo: RepoView; create?: ReactNode; busy: boolean; onOpen: (url: string) => void; onResolve: () => void
}) {
  const p = usePopover()
  const m = r.merge
  if (!m) return null
  // Authors keep one color across the timeline and the popover; You is always blue.
  const order = [...new Set([...m.commits.map(c => c.author), ...(m.conflicts ?? []).map(c => c.by)].filter(a => a !== 'You'))]
  const tint = (a: string) => (a === 'You' ? 'var(--hub-blue)' : PALETTE[order.indexOf(a) % PALETTE.length])
  const cs = m.conflicts ?? []
  const who = [...new Set(cs.map(c => c.by))].join(' and ')
  const pr = r.pr
  const total = (pr?.additions ?? 0) + (pr?.deletions ?? 0)

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ border: '1px solid var(--hub-hair)', borderRadius: 10, background: 'var(--hub-canvas)', minWidth: 0 }}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '12px 20px', padding: 12 }}>
          <div style={{ flex: '1 1 160px', minWidth: 0, display: 'grid', gap: 4, alignContent: 'start' }}>
            <span style={{ display: 'flex', alignItems: 'center', gap: 8, font: '500 14px/1.3 var(--hub-sans)', color: 'var(--hub-ink)' }}>
              <i aria-hidden style={{ width: 8, height: 8, borderRadius: '50%', flex: 'none', background: pr ? STATE[pr.state] ?? 'var(--hub-ash)' : 'var(--hub-ash)' }} />
              {pr ? cap(pr.state) : 'No pull request'}
            </span>
            {m.files > 0 && <span style={{ font: '500 13px/1.3 var(--hub-sans)', color: 'var(--hub-yellow)' }}>{m.files} {m.files === 1 ? 'conflict' : 'conflicts'}</span>}
            {pr && <button type="button" className="hub-link" onClick={() => onOpen(pr.url)}
              style={{ padding: 0, fontSize: 12, textAlign: 'left', color: 'var(--hub-ash)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {pr.number ? `#${pr.number} ` : ''}{pr.title} ↗</button>}
            <span style={{ fontSize: 12, color: 'var(--hub-ash)' }}>into <code style={mono}>{m.base}</code>{m.behind ? ` · ${m.behind} behind` : ''}</span>
          </div>
          <div style={{ flex: '0 1 220px', minWidth: 0, display: 'grid', gap: 8, alignContent: 'start' }}>
            {!pr && create && <div style={{ justifySelf: 'end' }}>{create}</div>}
            {m.commits.length > 0 && <ol role="list" aria-label={`Commits since ${m.base} split off`}
              style={{ listStyle: 'none', margin: 0, padding: '0 0 0 2px', display: 'grid', position: 'relative' }}>
              <i aria-hidden style={{ position: 'absolute', left: 5, top: 9, bottom: 9, width: 1, background: 'var(--hub-hair)' }} />
              {m.commits.map(c => <li key={c.hash} style={{ display: 'grid', gridTemplateColumns: '8px 7ch 1fr auto', alignItems: 'center', gap: 10, minHeight: 22, fontSize: 12 }}>
                <i aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: tint(c.author), boxShadow: '0 0 0 2px var(--hub-canvas)', position: 'relative' }} />
                <code style={{ ...mono, color: 'var(--hub-mute)' }}>{c.hash.slice(0, 7)}</code>
                <span style={{ color: 'var(--hub-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.author}</span>
                <span style={{ ...mono, color: 'var(--hub-ash)', fontVariantNumeric: 'tabular-nums' }}>{short(c.at)}</span>
              </li>)}
            </ol>}
          </div>
        </div>

        {cs.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 12px', borderTop: '1px solid var(--hub-hair)' }}>
          <span {...p.wrap} style={{ position: 'relative', minWidth: 0 }}>
            <button type="button" className="hub-link" {...p.button}
              style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '2px 0', fontSize: 12, color: 'var(--hub-yellow)', textDecoration: 'underline', textUnderlineOffset: 3, textDecorationColor: 'color-mix(in srgb, currentColor 45%, transparent)' }}>
              <Warn />{m.files} {m.files === 1 ? 'conflict' : 'conflicts'} with {m.base}
            </button>
            {/* The top padding bridges the gap, so moving the mouse down keeps it open. */}
            {p.open && <div id={p.id} role="tooltip" style={{ position: 'absolute', left: 0, top: '100%', paddingTop: 6, zIndex: 5, width: 'min(480px, 86vw)' }}><div style={{ display: 'grid', gap: 10, padding: 12, borderRadius: 10,
              background: 'var(--hub-elev)', border: '1px solid var(--hub-hair-strong)', boxShadow: '0 10px 28px rgba(0, 0, 0, 0.28)' }}>
              <span style={{ fontSize: 13, color: 'var(--hub-ink)' }}><b style={{ fontWeight: 500, color: tint(cs[0].by) }}>{who}</b> changed the same lines on {m.base}</span>
              {cs.map(c => <div key={c.path} style={{ display: 'grid', gap: 4, minWidth: 0 }}>
                <span style={{ fontSize: 12, color: 'var(--hub-mute)' }}><code style={{ ...mono, color: 'var(--hub-body)' }} title={c.path}>{name(c.path)}</code>{c.line ? ` line ${c.line}` : ''}</span>
                {c.line != null && [[c.by, c.theirs], ['You', c.ours]].map(([who, text]) => <div key={who} style={{ display: 'flex', gap: 10, minWidth: 0, padding: '3px 8px', borderLeft: `2px solid ${tint(who!)}`, background: 'var(--hub-canvas)', borderRadius: '0 4px 4px 0' }}>
                  <span style={{ ...mono, color: tint(who!), flex: 'none', minWidth: '5ch' }}>{who}</span>
                  <code title={text} style={{ ...mono, color: 'var(--hub-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{text || '(removed)'}</code>
                </div>)}
              </div>)}
              {m.files > cs.length && <span style={{ fontSize: 12, color: 'var(--hub-ash)' }}>and {m.files - cs.length} more</span>}
            </div></div>}
          </span>
          <button type="button" className="hub-btn primary" disabled={busy} onClick={onResolve} title="Asks this chat to merge and fix them; nothing is committed"
            style={{ marginLeft: 'auto', padding: '6px 14px', fontSize: 12, borderRadius: 99 }}>Resolve conflicts</button>
        </div>}
      </div>

      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--hub-body)', maxWidth: '68ch' }}>{summary(r)}</p>
      <span className="hub-chip ver" style={{ justifySelf: 'start', gap: 8 }}>
        {pill(r)}
        {total > 0 && <span aria-hidden style={{ display: 'flex', width: 36, height: 4, borderRadius: 2, overflow: 'hidden', background: 'var(--hub-hair)' }}>
          <i style={{ width: `${(100 * (pr?.additions ?? 0)) / total}%`, background: 'var(--hub-green)' }} />
          <i style={{ flex: 1, background: 'var(--hub-red)' }} />
        </span>}
      </span>
    </div>
  )
}
