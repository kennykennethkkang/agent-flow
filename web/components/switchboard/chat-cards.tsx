'use client'
import { useEffect, useRef, useState } from 'react'
import type { AiId, ArchivedChat, ChatProgress, ChatRow, HandoffWait, NoteSearch } from '@/lib/hub-types'
import { archiveChains, filterChains, historyCount, liveVersion, splitVersion } from '@/lib/archive'
import { STATE, ago, caps, repoOf } from './look'
import { chip } from './tool-chips'

export type Card = { chat: ChatRow; progress?: ChatProgress }

/** A slim done/total bar; .hub-bar animates the fill except under reduced motion. */
export function TaskBar({ done, total, label, height = 4 }: { done: number; total: number; label: string; height?: number }) {
  return (
    <div className="hub-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={total} aria-valuenow={done} aria-valuetext={`${done} of ${total}`}
      style={{ height, borderRadius: height / 2, background: 'var(--hub-hair)', overflow: 'hidden' }}>
      <div style={{ height: '100%', background: done === total ? 'var(--hub-green)' : 'var(--hub-blue)', borderRadius: height / 2, transform: `scaleX(${total ? done / total : 0})` }} />
    </div>
  )
}

/** Copies the commit message and says so for 1.4 s; onCopy answers whether the clipboard took it.
 *  With no clipboard (an older webview, a denied permission) it shows the text selected for a manual copy. */
export function CopyCommit({ text, onCopy, small }: { text: string; onCopy: (text: string) => Promise<boolean>; small?: boolean }) {
  const [said, setSaid] = useState<string>()
  const [manual, setManual] = useState(false)
  const copy = async () => {
    const ok = await onCopy(text)
    setManual(!ok)
    setSaid(ok ? 'Copied' : `Press ${/Mac|iP/.test(navigator.platform) ? 'Cmd' : 'Ctrl'}+C to copy`)
    if (ok) setTimeout(() => setSaid(undefined), 1400)
  }
  return <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', maxWidth: '100%' }}>
    <button type="button" className="hub-btn" onClick={() => void copy()} aria-live="polite"
      style={small ? { padding: '6px 10px', fontSize: 12 } : undefined}>{said ?? 'Copy commit message'}</button>
    {manual && <textarea readOnly aria-label="Commit message" value={text} rows={Math.min(6, Math.max(3, text.split("\n").length))} autoFocus onFocus={e => e.currentTarget.select()} onBlur={() => { setManual(false); setSaid(undefined) }}
      ref={el => el?.select()} style={{ font: '400 12px/1.5 var(--hub-mono)', padding: '6px 8px', borderRadius: 6, minWidth: 0, flex: '1 1 160px', background: 'var(--hub-canvas)', color: 'var(--hub-ink)', border: '1px solid var(--hub-hair)', resize: 'none' }} />}
  </span>
}

/** onSelect's key: the pick came from the keyboard, so the picture swaps with no crossfade. */
/** models: each role's model, shown beside the active role. */
export function ChatCards({ cards, waits = [], selected, models = {}, empty = 'No chats yet. Start one with New chat.', onSelect, onCopy }: { cards: Card[]; waits?: HandoffWait[]; selected?: string; models?: Record<string, string>; empty?: string; onSelect: (id: string, key: boolean) => void; onCopy: (text: string) => Promise<boolean> }) {
  if (!cards.length) return <p style={{ color: 'var(--hub-ash)', margin: 0, padding: 4 }}>{empty}</p>
  return (
    <ul role="list" aria-label="Chats" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6 }}>
      {cards.map(({ chat, progress }) => {
        const s = STATE[progress?.state ?? 'idle']
        const active = progress?.roles.find(r => r.state === 'active')?.role
        const on = chat.sessionId === selected
        const { origin, version } = splitVersion(chat.name)
        const wait = waits.find(w => w.sessionId === chat.sessionId)
        const tasks = progress?.tasks ?? [], done = tasks.filter(t => t.status === 'completed').length
        return (
          <li key={chat.sessionId} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6 }}>
            <button type="button" className="hub-card" onClick={e => onSelect(chat.sessionId, e.detail === 0)} aria-pressed={on}>
              <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                <span style={{ display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 }}>
                  <span style={{ color: 'var(--hub-ink)', fontWeight: 500, letterSpacing: 0.2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{origin || repoOf(chat.cwd)}</span>
                  {version > 1 && <Version n={version} />}
                </span>
                <span className="hub-chip" style={{ color: s.color, background: s.soft, flexShrink: 0 }}><i aria-hidden />{s.label}</span>
              </span>
              <span style={{ font: '400 12px/1.5 var(--hub-mono)', color: 'var(--hub-ash)' }}>
                {repoOf(chat.cwd)}{active ? ` · ${active}${models[active] ? ` · ${models[active]}` : ''}` : ''}{progress ? ` · ${ago(progress.at)}` : ''}
              </span>
              {/* A button reads its children as flat text, so the progressbar screen readers get sits beside it; this one is the look. */}
              {tasks.length > 0 && <span aria-hidden style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'center' }}>
                <TaskBar done={done} total={tasks.length} height={3} label="" />
                <span style={{ font: '400 11px/1 var(--hub-mono)', color: 'var(--hub-ash)' }}>{done}/{tasks.length}</span>
              </span>}
              {wait && <span style={{ color: 'var(--hub-yellow)', fontSize: 13 }}>Waiting for {wait.tasks} task{wait.tasks === 1 ? '' : 's'} to finish before moving to {wait.next}</span>}
              {progress?.state === 'needs-you' && progress.question && <span style={{ color: 'var(--hub-red)', fontSize: 13 }}>{progress.question}</span>}
              {progress?.state === 'done' && !progress.commit && <span style={{ color: 'var(--hub-ash)', fontSize: 13 }}>No commit message</span>}
            </button>
            {tasks.length > 0 && <div className="sr-only"><TaskBar done={done} total={tasks.length} label={`Tasks done in ${origin || repoOf(chat.cwd)}`} /></div>}
            {progress?.state === 'done' && progress.commit && <div style={{ padding: '0 12px 6px' }}><CopyCommit small text={progress.commit} onCopy={onCopy} /></div>}
          </li>
        )
      })}
    </ul>
  )
}

/** Toggle chips, one per project; none pressed shows every project. */
export function ProjectFilter({ projects, picked, onChange }: { projects: { name: string; count: number }[]; picked: string[]; onChange: (picked: string[]) => void }) {
  return (
    <div role="group" aria-label="Show chats from these projects" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
      {projects.map(({ name, count }) => {
        const on = picked.includes(name)
        return (
          <button key={name} type="button" aria-pressed={on} style={chip(on)} onClick={() => onChange(on ? picked.filter(p => p !== name) : [...picked, name])}>
            {name}<span style={{ color: 'var(--hub-mute)' }}>{count}</span>
          </button>
        )
      })}
      {picked.length > 0 && <button type="button" className="hub-link" onClick={() => onChange([])}>All</button>}
    </div>
  )
}

const Version = ({ n }: { n: number }) => <span className="hub-chip ver" title={`Version ${n} of this chat: it continues an earlier chat that filled up`}>v{n}</span>
const since = (at: number) => { const a = ago(at); return a === 'now' ? 'just now' : `${a} ago` }
const ellipsis = { minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const

/** The snippet with each match of q marked. */
function Snippet({ text, q }: { text: string; q: string }) {
  const parts = q ? text.split(new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig')) : [text]
  return <q style={{ display: 'block', quotes: 'none', color: 'var(--hub-ash)', fontSize: 12, lineHeight: 1.5 }}>{parts.map((p, i) => (i % 2 ? <mark key={i}>{p}</mark> : p))}</q>
}

/**
 * Chats that filled up and continued in a new one, one row per chain; a row opens its versions, newest first.
 * The search box filters by name, and by words in the handoff notes (the extension searches those: onSearch).
 * reveal: the switcher's pick, which opens History at that chain.
 */
export function History({ archive, chats, search, reveal, onSearch, onNote, onResume }: {
  archive: ArchivedChat[]; chats: ChatRow[]; search: NoteSearch | null; reveal?: { chain: string; at: number }
  onSearch: (q: string) => void; onNote: (sessionId: string) => void; onResume: (sessionId: string, ai: AiId) => void
}) {
  const [open, setOpen] = useState(false)
  const [chain, setChain] = useState<string>()
  const [q, setQ] = useState('')
  const [warn, setWarn] = useState<string>()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  // The switcher's pick: open History at that chain, then focus its row once a render has put it in the page.
  const focusChain = useRef<string>(undefined)
  useEffect(() => {
    if (!reveal) return
    setOpen(true); setChain(reveal.chain); setQ('')
    focusChain.current = reveal.chain
  }, [reveal])
  useEffect(() => {
    if (!focusChain.current) return
    const row = document.querySelector<HTMLElement>(`[data-chain="${CSS.escape(focusChain.current)}"]`)
    if (!row) return
    focusChain.current = undefined
    row.scrollIntoView({ block: 'nearest' }); row.focus()
  })
  useEffect(() => () => clearTimeout(timer.current), [])
  if (!archive.length) return null
  const all = archiveChains(archive)
  const query = q.trim()
  const hits = new Map((search?.q === query ? search.hits : []).map(h => [h.sessionId, h.snippet]))
  const chains = filterChains(all, query, new Set(hits.keys()))
  const type = (v: string) => {
    setQ(v)
    if (v.trim()) setOpen(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => onSearch(v.trim().length >= 2 ? v.trim() : ''), 250)
  }
  return (
    <section aria-label="History" style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--hub-hair)', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6, minWidth: 0 }}>
      <button type="button" className="hub-link hub-fold" aria-expanded={open} onClick={() => setOpen(!open)} style={{ ...caps, alignItems: 'center', width: '100%', padding: '8px 4px' }}>
        <span style={ellipsis}>History <span style={{ color: 'var(--hub-mute)', marginLeft: 4 }}>{historyCount(all)}</span></span>
        <b aria-hidden>›</b>
      </button>
      <input type="search" className="hub-search" aria-label="Search History by name or handoff note" placeholder="Search names and handoff notes" value={q}
        onChange={e => type(e.target.value)} onKeyDown={e => { if (e.key === 'Escape' && q) { e.stopPropagation(); type('') } }} />
      {open && !query && <p style={{ margin: '0 4px 4px', color: 'var(--hub-ash)', fontSize: 12, lineHeight: 1.5 }}>Chats that filled up. Each one carried on in a new chat with the next version number.</p>}
      {open && query && <p role="status" style={{ margin: '0 4px 4px', color: 'var(--hub-ash)', fontSize: 12 }}>{chains.length ? `${chains.length} of ${all.length} chains match` : `No chain matches "${query}".`}</p>}
      {open && (
        <ul role="list" aria-label="Closed chats" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
          {chains.map(c => {
            const key = `${c.latest.cwd}\n${c.origin}`, on = chain === key
            const now = liveVersion(c, chats), carried = now !== undefined && now > c.latest.version
            const snippet = c.versions.map(v => hits.get(v.sessionId)).find(Boolean)
            return (
              <li key={key}>
                <button type="button" className="hub-card" data-chain={key} aria-expanded={on} onClick={() => setChain(on ? undefined : key)} style={{ padding: '10px 12px' }}>
                  <span style={{ display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 }}>
                    <span style={{ ...ellipsis, color: 'var(--hub-body)' }}>{c.origin}</span>
                    <Version n={c.latest.version} />
                  </span>
                  <span style={{ font: '400 12px/1.5 var(--hub-mono)', color: 'var(--hub-ash)' }}>{c.latest.project} · {carried ? <span style={{ color: 'var(--hub-blue)' }}>continued as v{now}</span> : `closed ${since(c.latest.archivedAt)}`}</span>
                  {snippet && <Snippet text={snippet} q={query} />}
                </button>
                {on && (
                  <ol aria-label={`Versions of ${c.origin}`} style={{ listStyle: 'none', margin: '2px 0 8px 12px', padding: '0 0 0 8px', borderLeft: '1px solid var(--hub-hair)', display: 'grid' }}>
                    {c.versions.map(v => (
                      <li key={v.sessionId} style={{ display: 'grid', gap: 2 }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                          <span style={{ font: '500 12px/1 var(--hub-mono)', color: 'var(--hub-body)', minWidth: 22 }}>v{v.version}</span>
                          <span style={{ ...ellipsis, font: '400 12px/1 var(--hub-mono)', color: 'var(--hub-ash)', flex: 1 }}>closed {since(v.archivedAt)}</span>
                          {v.note && <button type="button" className="hub-link" style={{ padding: '6px 4px' }} onClick={() => onNote(v.sessionId)} aria-label={`Open the handoff note of v${v.version}`}>Note</button>}
                          <button type="button" className="hub-link" style={{ padding: '6px 4px' }} aria-label={`Resume v${v.version}`}
                            onClick={() => { if (now !== undefined && now > v.version && warn !== v.sessionId) setWarn(v.sessionId); else { setWarn(undefined); onResume(v.sessionId, v.ai) } }}>
                            Resume
                          </button>
                        </span>
                        {warn === v.sessionId && <span role="alert" style={{ color: 'var(--hub-yellow)', fontSize: 12, padding: '0 0 6px 30px' }}>v{now} is still open. Press Resume again to run v{v.version} beside it.</span>}
                      </li>
                    ))}
                  </ol>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
