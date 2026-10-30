'use client'
import type { ReactNode } from 'react'
import type { CiRun, TestRun } from '@/lib/hub-types'
import { ciLine, ciState, testsLine } from '@/lib/checks'
import { short } from '@/lib/pr-card'
import { usePopover } from './use-popover'

const mono = { font: '400 12px/1.5 var(--hub-mono)' } as const
const pillStyle = { marginLeft: 'auto', padding: '6px 14px', fontSize: 12, borderRadius: 99 } as const
const CI: Record<string, { color: string; word: string }> = {
  running: { color: 'var(--hub-yellow)', word: 'Running' }, failed: { color: 'var(--hub-red)', word: 'Failed' },
  passed: { color: 'var(--hub-green)', word: 'Passed' }, other: { color: 'var(--hub-ash)', word: 'Ended' },
}
const jobColor = (j: CiRun['jobs'][number]) => j.status !== 'completed' ? CI.running.color : j.conclusion === 'success' ? CI.passed.color : j.conclusion === 'skipped' || j.conclusion === 'cancelled' ? CI.other.color : CI.failed.color

const Dot = ({ color, size = 8 }: { color: string; size?: number }) => <i aria-hidden style={{ width: size, height: size, borderRadius: '50%', flex: 'none', background: color }} />

/** A link that opens its detail on hover or focus, like the PR card's conflicts. */
function Hint({ label, color, children }: { label: ReactNode; color: string; children: ReactNode }) {
  const p = usePopover()
  return (
    <span {...p.wrap} style={{ position: 'relative', minWidth: 0 }}>
      <button type="button" className="hub-link" {...p.button}
        style={{ padding: '2px 0', fontSize: 12, color, textDecoration: 'underline', textUnderlineOffset: 3, textDecorationColor: 'color-mix(in srgb, currentColor 45%, transparent)' }}>{label}</button>
      {p.open && <div id={p.id} role="tooltip" style={{ position: 'absolute', left: 0, top: '100%', paddingTop: 6, zIndex: 5, width: 'min(520px, 86vw)' }}><div style={{ display: 'grid', gap: 8, padding: 12, borderRadius: 10,
        background: 'var(--hub-elev)', border: '1px solid var(--hub-hair-strong)', boxShadow: '0 10px 28px rgba(0, 0, 0, 0.28)' }}>{children}</div></div>}
    </span>
  )
}

const Shell = ({ head, foot, line }: { head: ReactNode; foot: ReactNode; line: string }) => (
  <div style={{ display: 'grid', gap: 8 }}>
    <div style={{ border: '1px solid var(--hub-hair)', borderRadius: 10, background: 'var(--hub-canvas)', minWidth: 0 }}>
      <div style={{ display: 'grid', gap: 4, padding: 12 }}>{head}</div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '10px 12px', borderTop: '1px solid var(--hub-hair)' }}>{foot}</div>
    </div>
    <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--hub-body)', maxWidth: '68ch' }}>{line}</p>
  </div>
)

/** The chat's newest test run, only while it failed. */
export function TestsCard({ run: t, onSend }: { run: TestRun; onSend?: () => void }) {
  return <Shell line={testsLine(t)}
    head={<>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, font: '500 14px/1.3 var(--hub-sans)', color: 'var(--hub-ink)' }}>
        <Dot color="var(--hub-red)" />Tests failing
        {t.failed ? <span style={{ font: '500 13px/1.3 var(--hub-sans)', color: 'var(--hub-red)' }}>{t.failed}{t.total ? ` of ${t.total}` : ''}</span> : null}
        <span style={{ ...mono, marginLeft: 'auto', color: 'var(--hub-ash)', fontVariantNumeric: 'tabular-nums' }}>{short(t.at)}</span>
      </span>
      <code title={t.command} style={{ ...mono, color: 'var(--hub-mute)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.command}</code>
    </>}
    foot={<>
      {t.tail?.length ? <Hint label="Last lines of output" color="var(--hub-red)">
        <pre style={{ ...mono, margin: 0, color: 'var(--hub-body)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{t.tail.join('\n')}</pre>
      </Hint> : <span style={{ fontSize: 12, color: 'var(--hub-ash)' }}>No output</span>}
      {onSend && <button type="button" className="hub-btn primary" onClick={onSend} title="Sends the command and its last lines to this chat" style={pillStyle}>Send to chat</button>}
    </>} />
}

/** The branch's newest GitHub Actions run. */
export function CiCard({ run: c, busy, onOpen, onRerun }: { run: CiRun; busy: boolean; onOpen: () => void; onRerun: () => void }) {
  const s = CI[ciState(c)], failed = ciState(c) === 'failed'
  const bad = c.jobs.filter(j => jobColor(j) === CI.failed.color)
  return <Shell line={ciLine(c)}
    head={<>
      <span style={{ display: 'flex', alignItems: 'center', gap: 8, font: '500 14px/1.3 var(--hub-sans)', color: 'var(--hub-ink)', minWidth: 0 }}>
        <Dot color={s.color} /><span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.workflow}</span>
        <span style={{ font: '500 13px/1.3 var(--hub-sans)', color: s.color }}>{s.word}</span>
        <span style={{ ...mono, marginLeft: 'auto', color: 'var(--hub-ash)', fontVariantNumeric: 'tabular-nums' }}>{short(c.at)}</span>
      </span>
      {c.jobs.length > 0 && <ul role="list" aria-label="Jobs" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
        {c.jobs.map((j, i) => <li key={i} title={`${j.name}: ${j.conclusion ?? j.status}`} style={{ display: 'flex' }}>
          <Dot color={jobColor(j)} size={7} /><span className="sr-only">{j.name}: {j.conclusion ?? j.status}</span></li>)}
        <li style={{ ...mono, color: 'var(--hub-ash)' }}>{c.sha}</li>
      </ul>}
    </>}
    foot={<>
      {bad.length > 0 && <Hint label={`${bad.length} failed ${bad.length === 1 ? 'job' : 'jobs'}`} color="var(--hub-red)">
        {bad.map((j, i) => <div key={i} style={{ display: 'flex', gap: 10, minWidth: 0, padding: '3px 8px', borderLeft: '2px solid var(--hub-red)', background: 'var(--hub-canvas)', borderRadius: '0 4px 4px 0' }}>
          <span style={{ fontSize: 12, color: 'var(--hub-ink)', flex: 'none' }}>{j.name}</span>
          <code style={{ ...mono, color: 'var(--hub-body)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.step ?? j.conclusion}</code>
        </div>)}
      </Hint>}
      <button type="button" className="hub-link" onClick={onOpen} style={{ padding: '2px 0', fontSize: 12, marginLeft: failed ? undefined : 'auto' }}>Open run ↗</button>
      {failed && <button type="button" className="hub-btn primary" disabled={busy} onClick={onRerun} title={`gh run rerun ${c.id} --failed`} style={pillStyle}>Re-run failed</button>}
    </>} />
}
