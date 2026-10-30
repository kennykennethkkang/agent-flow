'use client'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AiId, ArchivedChat, ChatProgress, ChatRow, ChatState, TaskRow, HandoffWait, NoteSearch, WindowInfo } from '@/lib/hub-types'
import { byWindow } from '@/lib/windows'
import { eta, say } from '@/lib/eta'
import { archiveChains, filterChains, historyCount, liveVersion, projectName, splitVersion } from '@/lib/archive'
import { ALMOST, STATE, WINDOW_VAR, ago, almostDone, caps, coverage, label, missedCount } from './look'
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

export const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`
export const hhmm = (at: number) => new Date(at).toTimeString().slice(0, 5)

/** The state chip: a working chat whose lead already stopped is wrapping up, not working; a done one with a request not covered is almost done. */
export const chipOf = (p?: ChatProgress) => p?.state === 'working' && p.waiting ? { ...STATE.working, label: 'Wrapping up' } : almostDone(p) ? ALMOST : STATE[p?.state ?? 'idle']

/** "1 subagent, 1 job still running" while the lead waits on them; the chip already says Wrapping up. */
export function stillRunning(p?: ChatProgress): string | undefined {
  if (!p?.waiting) return undefined
  const subs = p.running?.length ?? 0, jobs = p.jobs?.length ?? 0
  const parts = [subs ? plural(subs, 'subagent') : '', jobs ? plural(jobs, 'job') : ''].filter(Boolean)
  return parts.length ? `${parts.join(', ')} still running` : undefined
}

/** "All 3 tasks done" for a finished chat; "1 request not covered" for an almost done one. */
export const finishedLine = (p: ChatProgress) => missedCount(p)
  ? `${plural(missedCount(p), 'request')} not covered`
  : p.tasks.length ? `All ${plural(p.tasks.length, 'task')} done` : 'Finished'

/** A done chat's receipt on its page: what Kenneth asked and what got done. What is left lives in the to-do panel only. */
export function Receipt({ p }: { p: ChatProgress }) {
  const done = p.report?.done.length ? p.report.done : p.tasks.filter(t => t.status === 'completed').map(t => t.subject)
  const parts = ([['You asked', p.asked ?? []], ['Done', done]] as const).filter(x => x[1].length)
  if (!parts.length) return null
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 10 }}>
      {parts.map(([name, items]) => (
        <div key={name} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4 }}>
          <span style={label}>{name}</span>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4, fontSize: 13 }}>
            {items.map((t, i) => {
              // A request Jev checked: a green tick when Done covers it, a teal box when it does not; unchecked ones get no mark.
              const v = name === 'You asked' ? coverage(p, i) : 'covered'
              return (
                <li key={i} data-s={v === 'covered' ? 'completed' : v} style={{ display: 'flex', gap: 10, alignItems: 'baseline', minWidth: 0, color: v === 'missed' ? 'var(--hub-teal)' : 'var(--hub-body)' }}>
                  {v ? <span className="hub-tick" aria-hidden style={{ alignSelf: 'center' }} /> : <span aria-hidden style={{ color: 'var(--hub-ash)', flex: 'none', width: 14, textAlign: 'center' }}>›</span>}
                  <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{t}{v === 'missed' && <span style={{ color: 'var(--hub-ash)' }}> (not covered)</span>}</span>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </div>
  )
}

export const Check = ({ size = 10 }: { size?: number }) => (
  <svg aria-hidden width={size} height={size} viewBox="0 0 10 10" style={{ flex: 'none' }}><path d="M2 5.2 4.2 7.4 8 3" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" /></svg>
)

/** One row per task with its status tick and owner role; max: rows shown before "N more". */
export function TaskRows({ tasks, models = {}, max, small, state }: { tasks: TaskRow[]; models?: Record<string, string>; max?: number; small?: boolean; state?: ChatState }) {
  const shown = max ? tasks.slice(0, max) : tasks
  const Row = small ? 'span' : 'li'
  const rows = shown.map(t => (
    <Row key={t.id} data-s={t.status} data-c={state} style={{ display: 'flex', gap: small ? 8 : 10, alignItems: 'center', fontSize: small ? 12 : undefined, color: t.status === 'pending' ? 'var(--hub-mute)' : 'var(--hub-body)' }}>
      <span className="hub-tick" aria-hidden style={small ? { width: 12, height: 12 } : undefined} />
      <span style={{ minWidth: 0, ...(small ? { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } : {}) }}><span className="sr-only">{t.status.replace('_', ' ')}: </span>{t.subject}{t.role && <span style={{ color: 'var(--hub-ash)' }}> · {t.role}{models[t.role] ? ` · ${models[t.role]}` : ''}</span>}</span>
    </Row>
  ))
  const more = tasks.length - shown.length
  // In a card the rows sit inside a button, so they are spans.
  if (small) return <span style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4 }}>{rows}{more > 0 && <span style={{ fontSize: 12, color: 'var(--hub-ash)', paddingLeft: 20 }}>{more} more</span>}</span>
  return <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>{rows}</ul>
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
    {manual && <textarea readOnly aria-label="Commit message" value={text} rows={Math.min(12, Math.max(3, text.split("\n").length))} autoFocus onFocus={e => e.currentTarget.select()} onBlur={() => { setManual(false); setSaid(undefined) }}
      ref={el => el?.select()} style={{ font: '400 12px/1.5 var(--hub-mono)', padding: '6px 8px', borderRadius: 6, minWidth: 0, flex: '1 1 160px', background: 'var(--hub-canvas)', color: 'var(--hub-ink)', border: '1px solid var(--hub-hair)', resize: 'none' }} />}
  </span>
}

/** onSelect's key: the pick came from the keyboard, so the picture swaps with no crossfade. */
/** windows: grouped under each VS Code window, here (the panel's own) first. */
/** starred: session ids with a star. menu: each card's actions, beside it (a card is one button, so the menu cannot sit inside it). */
export function ChatCards({ cards, waits = [], selected, windows = [], here, empty = 'No chats yet. Start one with New chat.', starred = [], menu, onSelect }: { cards: Card[]; waits?: HandoffWait[]; selected?: string; windows?: WindowInfo[]; here?: string; empty?: string; starred?: string[]; menu?: (chat: ChatRow) => ReactNode; onSelect: (id: string, key: boolean) => void }) {
  if (!cards.length) return <p style={{ color: 'var(--hub-ash)', margin: 0, padding: 4 }}>{empty}</p>
  const groups = byWindow(cards, windows, here)
  const more = { waits, selected, starred, menu, onSelect }
  if (!groups.some(g => g.window)) return <CardList cards={cards} label="Chats" {...more} />
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14 }}>
      {groups.map(g => {
        const color = g.window && WINDOW_VAR[g.window.color]
        const name = g.window?.name ?? 'Other'
        return (
          <section key={g.window?.workspace ?? ''} aria-label={g.here ? `${name}, this window` : name} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6 }}>
            <h3 title={g.window?.workspace} style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0 4px', minWidth: 0, font: '600 12px/1.2 var(--hub-sans)', letterSpacing: 0.5, textTransform: 'uppercase', color: color ?? 'var(--hub-ash)' }}>
              {color && <i aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }} />}
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
              {g.here && <span style={{ font: '600 12px/1 var(--hub-mono)', letterSpacing: 0.4, flexShrink: 0, textTransform: 'none' }}>· this window</span>}
            </h3>
            <CardList cards={g.cards} label={`Chats in ${name}`} stripe={color} grouped {...more} />
          </section>
        )
      })}
    </div>
  )
}

/** stripe: the window color down each card's left edge. grouped: the group heading names the project, so the card does not. */
function CardList({ cards, label, stripe, grouped, waits, selected, starred, menu, onSelect }: { cards: Card[]; label: string; stripe?: string; grouped?: boolean; waits: HandoffWait[]; selected?: string; starred: string[]; menu?: (chat: ChatRow) => ReactNode; onSelect: (id: string, key: boolean) => void }) {
  return (
    <ul role="list" aria-label={label} style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6 }}>
      {cards.map(({ chat, progress }) => {
        const s = chipOf(progress), finished = progress?.state === 'done', running = stillRunning(progress)
        const active = progress?.roles.find(r => r.state === 'active')?.role
        const on = chat.sessionId === selected
        const { origin, version } = splitVersion(chat.name)
        const wait = waits.find(w => w.sessionId === chat.sessionId)
        const tasks = progress?.tasks ?? [], done = tasks.filter(t => t.status === 'completed').length
        const open = tasks.length - done
        const left = progress?.state === 'working' && open ? eta(progress, Date.now()).leftMs : undefined
        return (
          <li key={chat.sessionId} className="hub-card-li" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6, position: 'relative' }}>
            <button type="button" className="hub-card" onClick={e => onSelect(chat.sessionId, e.detail === 0)} aria-pressed={on} style={stripe ? { borderLeft: `3px solid ${stripe}` } : undefined}>
              <span className="hub-card-top" style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline', paddingRight: menu ? 30 : 0 }}>
                <span style={{ display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 }}>
                  {starred.includes(chat.sessionId) && <span title="Starred" style={{ color: 'var(--hub-yellow)', flex: 'none' }}>★<span className="sr-only"> starred</span></span>}
                  <span className="hub-card-name" style={{ color: 'var(--hub-ink)', fontWeight: 500, letterSpacing: 0.2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{origin || projectName(chat)}</span>
                  {version > 1 && <Version n={version} />}
                </span>
                <span className="hub-chip" style={{ color: s.color, background: s.soft, flexShrink: 0 }}>{finished ? <Check /> : <i aria-hidden />}{s.label}</span>
              </span>
              <span style={{ font: '400 12px/1.5 var(--hub-mono)', color: 'var(--hub-ash)' }}>
                {[grouped ? '' : projectName(chat), finished ? '' : active, progress ? ago(progress.at) : ''].filter(Boolean).join(' · ')}
              </span>
              {/* A button reads its children as flat text, so the progressbar screen readers get sits beside it; this one is the look. */}
              {tasks.length > 0 && !finished && <span aria-hidden style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'center' }}>
                <TaskBar done={done} total={tasks.length} height={3} label="" />
                <span style={{ font: '400 12px/1 var(--hub-mono)', color: 'var(--hub-ash)' }}>{done} of {tasks.length}{left !== undefined && <span style={{ color: 'var(--hub-mute)' }}> · {say(left)} left</span>}</span>
              </span>}
              {left !== undefined && <span className="sr-only">{say(left)} left</span>}
              {tasks.length > 0 && !finished && <span aria-hidden style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' }}><TaskRows tasks={tasks} max={5} small state={progress?.state} /></span>}
              {running && <span style={{ color: 'var(--hub-blue)', fontSize: 13 }}>{running}</span>}
              {progress?.state === 'idle' && open > 0 && <span style={{ color: 'var(--hub-yellow)', fontSize: 13 }}>{plural(open, 'task')} open</span>}
              {finished && <span style={{ color: s.color, fontSize: 13 }}>{finishedLine(progress)}{progress.finishedAt ? <span className="hub-num"> · {hhmm(progress.finishedAt)}</span> : ''}</span>}
              {wait && <span style={{ color: 'var(--hub-yellow)', fontSize: 13 }}>Waiting for {wait.tasks} task{wait.tasks === 1 ? '' : 's'} to finish before moving to {wait.next}</span>}
              {progress?.state === 'needs-you' && progress.question && <span style={{ color: 'var(--hub-red)', fontSize: 13 }}>{progress.question}</span>}
            </button>
            {tasks.length > 0 && !finished && <div className="sr-only"><TaskBar done={done} total={tasks.length} label={`Tasks done in ${origin || projectName(chat)}`} /></div>}
            {menu && <span className="hub-more-at">{menu(chat)}</span>}
          </li>
        )
      })}
    </ul>
  )
}

/** Toggle chips, one per project; none pressed shows every project. */
/** tint: a project's window color, as a dot in its chip. */
export function ProjectFilter({ projects, picked, tint, onChange }: { projects: { name: string; count: number }[]; picked: string[]; tint?: (name: string) => string | undefined; onChange: (picked: string[]) => void }) {
  return (
    <div role="group" aria-label="Show chats from these projects" style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
      {projects.map(({ name, count }) => {
        const on = picked.includes(name)
        return (
          <button key={name} type="button" aria-pressed={on} style={chip(on)} onClick={() => onChange(on ? picked.filter(p => p !== name) : [...picked, name])}>
            {tint?.(name) && <i aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: tint(name), flex: 'none' }} />}
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
                          <button type="button" className="hub-btn" style={{ padding: '6px 10px', fontSize: 12 }} aria-label={`Resume v${v.version}`}
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
