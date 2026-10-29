'use client'
import { useState } from 'react'
import type { Changes } from '@/lib/hub-types'
import { caps, panel, repoOf } from './look'
import { CopyCommit } from './chat-cards'

const mono = { font: '400 12px/1.5 var(--hub-mono)' } as const
const Counts = ({ a, r }: { a: number; r: number }) => <span style={{ ...mono, whiteSpace: 'nowrap' }}><span style={{ color: 'var(--hub-green)' }}>+{a}</span> <span style={{ color: 'var(--hub-red)' }}>-{r}</span></span>
const TAG = { modified: '', added: 'new', deleted: 'deleted', untracked: 'new' } as const

/** The files a chat's folder has uncommitted, each with an inline diff, to review before committing. */
export function ChangesPanel({ changes, sessionId, cwd, commit, onCopy, onOpen }: {
  changes: Changes | null; sessionId: string; cwd: string; commit?: string; onCopy: (text: string) => Promise<boolean>; onOpen: (file: string) => void
}) {
  const [open, setOpen] = useState<string>()
  const mine = changes?.sessionId === sessionId ? changes : null
  const files = mine?.files ?? []
  const target = files.find(f => f.path === open) ?? files[0]
  return (
    <section aria-label="Changes" style={panel}>
      <h3 style={caps}>
        <span>Changes{mine ? ` · ${files.length} ${files.length === 1 ? 'file' : 'files'}` : ''}</span>
        {files.length > 0 && <Counts a={files.reduce((n, f) => n + f.added, 0)} r={files.reduce((n, f) => n + f.removed, 0)} />}
      </h3>
      {!mine && <p style={{ margin: 0, color: 'var(--hub-ash)', fontSize: 13 }}>Reading the changes in {repoOf(cwd)}...</p>}
      {mine && !files.length && <p style={{ margin: 0, color: 'var(--hub-ash)', fontSize: 13 }}>No uncommitted changes in {repoOf(cwd)}.</p>}
      {files.length > 0 && <>
        <p style={{ margin: 0, color: 'var(--hub-ash)', fontSize: 12 }}>Uncommitted in {repoOf(cwd)}: other chats in this folder may have made some of these.</p>
        <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
          {files.map(f => {
            const on = open === f.path
            return (
              <li key={f.path} style={{ border: '1px solid var(--hub-hair)', borderRadius: 6, overflow: 'hidden', minWidth: 0 }}>
                <button type="button" className="hub-link hub-fold" aria-expanded={on} onClick={() => setOpen(on ? undefined : f.path)}
                  style={{ display: 'flex', width: '100%', justifyContent: 'space-between', gap: 10, alignItems: 'center', padding: '8px 10px', borderRadius: 0, color: 'var(--hub-body)' }}>
                  <span style={{ display: 'flex', gap: 8, alignItems: 'center', minWidth: 0 }}>
                    <b aria-hidden>›</b>
                    <span style={{ ...mono, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.path}</span>
                    {TAG[f.status] && <span className="hub-chip ver">{TAG[f.status]}</span>}
                  </span>
                  <Counts a={f.added} r={f.removed} />
                </button>
                {on && (f.diff
                  ? <div className="hub-diff" role="region" aria-label={`Diff of ${f.path}`}>
                      {f.diff.split('\n').map((l, i) => <div key={i} className={l.startsWith('+') ? 'a' : l.startsWith('-') ? 'r' : l.startsWith('@@') ? 'h' : undefined}>{l || ' '}</div>)}
                    </div>
                  : <p style={{ margin: 0, padding: '8px 10px', borderTop: '1px solid var(--hub-hair)', color: 'var(--hub-ash)', fontSize: 12 }}>{f.note ?? 'No text diff.'}</p>)}
              </li>
            )
          })}
        </ul>
      </>}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        {commit && <CopyCommit small text={commit} onCopy={onCopy} />}
        {target && <button type="button" className="hub-btn" style={{ padding: '6px 10px', fontSize: 12 }} onClick={() => onOpen(target.path)}
          title={`Opens ${target.path} against the last commit`}>Open in VS Code diff</button>}
      </div>
    </section>
  )
}
