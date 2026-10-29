'use client'
import { useEffect, useRef, useState } from 'react'
import type { AiId, ArchivedChat, ChatProgress, ChatRow, TaskRow, HandoffWait, NoteSearch, WindowColor, WindowInfo } from '@/lib/hub-types'
import { byWindow } from '@/lib/windows'
import { eta, say } from '@/lib/eta'
import { archiveChains, filterChains, historyCount, liveVersion, splitVersion } from '@/lib/archive'
import { ALMOST, STATE, ago, almostDone, caps, coverage, missedCount, repoOf } from './look'
import { chip } from './tool-chips'

export type Card = { chat: ChatRow; progress?: ChatProgress }

// Spelled out: Tailwind drops a custom property whose name never appears in the sources.
const WINDOW_VAR: Record<WindowColor, string> = {
  violet: 'var(--hub-w-violet)', amber: 'var(--hub-w-amber)', teal: 'var(--hub-w-teal)', rose: 'var(--hub-w-rose)', lime: 'var(--hub-w-lime)', cobalt: 'var(--hub-w-cobalt)',
}

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

/** The state chip: a working chat whose lead already stopped is wrapping up, not working; a done one with Left items is almost done. */
export const chipOf = (p?: ChatProgress) => p?.state === 'working' && p.waiting ? { ...STATE.working, label: 'Wrapping up' } : almostDone(p) ? ALMOST : STATE[p?.state ?? 'idle']

/** "Wrapping up: 2 subagents, 1 background job" while the lead waits on them. */
export function stillRunning(p?: ChatProgress): string | undefined {
  if (!p?.waiting) return undefined
  const subs = p.running?.length ?? 0, jobs = p.jobs?.length ?? 0
  const parts = [subs ? plural(subs, 'subagent') : '', jobs ? plural(jobs, 'background job') : ''].filter(Boolean)
  return parts.length ? `Wrapping up: ${parts.join(', ')}` : undefined
}

/** "All 3 tasks done, nothing running" for a finished chat; "2 items left, nothing running" for an almost done one. */
export const finishedLine = (p: ChatProgress) => missedCount(p)
  ? `${plural(missedCount(p), 'request')} not covered, nothing running`
  : almostDone(p)
  ? `${plural(p.report!.left.length, 'item')} left, nothing running`
  : `${p.tasks.length ? `All ${plural(p.tasks.length, 'task')} done, n` : 'N'}othing running`

const label = { font: '500 11px/1.2 var(--hub-mono)', color: 'var(--hub-ash)', textTransform: 'uppercase', letterSpacing: 0.4 } as const

/** A done chat's receipt: what Kenneth asked, what got done (the standup, else the finished tasks) and what is left.
 *  small: inside a card's button, so spans, and two rows a section. */
export function Receipt({ p, small }: { p: ChatProgress; small?: boolean }) {
  const done = p.report?.done.length ? p.report.done : p.tasks.filter(t => t.status === 'completed').map(t => t.subject)
  const parts = ([['You asked', p.asked ?? [], 'var(--hub-ash)'], ['Done', done, 'var(--hub-green)'], ['Left', p.report?.left ?? [], 'var(--hub-teal)']] as const).filter(x => x[1].length)
  if (!parts.length) return null
  const Box = small ? 'span' : 'div', List = small ? 'span' : 'ul', Row = small ? 'span' : 'li'
  return (
    <Box style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: small ? 6 : 10 }}>
      {parts.map(([name, items, color]) => {
        const shown = small ? items.slice(0, 2) : items
        return (
          <Box key={name} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 4 }}>
            <span style={{ ...label, color: name === 'Left' ? color : label.color }}>{name}</span>
            <List style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: small ? 2 : 4, fontSize: small ? 12 : 13 }}>
              {shown.map((t, i) => {
                // A request Jev checked: a green tick when Done covers it, teal and marked when it does not.
                const v = name === 'You asked' ? coverage(p, i) : undefined
                const c = v === 'covered' ? 'var(--hub-green)' : v === 'missed' ? 'var(--hub-teal)' : color
                return (
                  <Row key={i} style={{ display: 'flex', gap: 8, alignItems: 'baseline', minWidth: 0, color: name === 'Left' || v === 'missed' ? c : 'var(--hub-body)' }}>
                    <span aria-hidden style={{ color: c, flex: 'none', width: 10, display: 'inline-grid', placeItems: 'center' }}>{name === 'Done' || v === 'covered' ? <Check /> : name === 'Left' || v === 'missed' ? '○' : '›'}</span>
                    <span style={small ? ellipsis : { minWidth: 0, overflowWrap: 'anywhere' }}>{t}{v === 'missed' && <span style={{ color: 'var(--hub-ash)' }}> (not covered)</span>}</span>
                  </Row>
                )
              })}
              {items.length > shown.length && <Row style={{ fontSize: 12, color: 'var(--hub-ash)', paddingLeft: 18 }}>{items.length - shown.length} more</Row>}
            </List>
          </Box>
        )
      })}
    </Box>
  )
}

export const Check = ({ size = 10 }: { size?: number }) => (
  <svg aria-hidden width={size} height={size} viewBox="0 0 10 10" style={{ flex: 'none' }}><path d="M2 5.2 4.2 7.4 8 3" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" /></svg>
)

/** One row per task with its status tick and owner role; max: rows shown before "N more". */
export function TaskRows({ tasks, models = {}, max, small }: { tasks: TaskRow[]; models?: Record<string, string>; max?: number; small?: boolean }) {
  const shown = max ? tasks.slice(0, max) : tasks
  const Row = small ? 'span' : 'li'
  const rows = shown.map(t => (
    <Row key={t.id} data-s={t.status} style={{ display: 'flex', gap: small ? 8 : 10, alignItems: 'center', fontSize: small ? 12 : undefined, color: t.status === 'pending' ? 'var(--hub-ash)' : 'var(--hub-body)' }}>
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
    {manual && <textarea readOnly aria-label="Commit message" value={text} rows={Math.min(6, Math.max(3, text.split("\n").length))} autoFocus onFocus={e => e.currentTarget.select()} onBlur={() => { setManual(false); setSaid(undefined) }}
      ref={el => el?.select()} style={{ font: '400 12px/1.5 var(--hub-mono)', padding: '6px 8px', borderRadius: 6, minWidth: 0, flex: '1 1 160px', background: 'var(--hub-canvas)', color: 'var(--hub-ink)', border: '1px solid var(--hub-hair)', resize: 'none' }} />}
  </span>
}

/** onSelect's key: the pick came from the keyboard, so the picture swaps with no crossfade. */
/** models: each role's model, shown beside the active role. windows: grouped under each VS Code window, here (the panel's own) first. */
export function ChatCards({ cards, waits = [], selected, models = {}, windows = [], here, empty = 'No chats yet. Start one with New chat.', onSelect, onCopy }: { cards: Card[]; waits?: HandoffWait[]; selected?: string; models?: Record<string, string>; windows?: WindowInfo[]; here?: string; empty?: string; onSelect: (id: string, key: boolean) => void; onCopy: (text: string) => Promise<boolean> }) {
  if (!cards.length) return <p style={{ color: 'var(--hub-ash)', margin: 0, padding: 4 }}>{empty}</p>
  const groups = byWindow(cards, windows, here)
  if (!groups.some(g => g.window)) return <CardList cards={cards} label="Chats" waits={waits} selected={selected} models={models} onSelect={onSelect} onCopy={onCopy} />
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 14 }}>
      {groups.map(g => {
        const color = g.window && WINDOW_VAR[g.window.color]
        const name = g.window?.name ?? 'Other'
        return (
          <section key={g.window?.workspace ?? ''} aria-label={g.here ? `${name}, this window` : name} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6 }}>
            <h3 title={g.window?.workspace} style={{ display: 'flex', alignItems: 'center', gap: 6, margin: '0 4px', minWidth: 0, font: '600 11px/1.2 var(--hub-sans)', letterSpacing: 0.5, textTransform: 'uppercase', color: color ?? 'var(--hub-ash)' }}>
              {color && <i aria-hidden style={{ width: 7, height: 7, borderRadius: '50%', background: 'currentColor', flexShrink: 0 }} />}
              <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{name}</span>
              {g.here && <span style={{ font: '600 10px/1 var(--hub-mono)', letterSpacing: 0.6, flexShrink: 0 }}>· this window</span>}
            </h3>
            <CardList cards={g.cards} label={`Chats in ${name}`} stripe={color} waits={waits} selected={selected} models={models} onSelect={onSelect} onCopy={onCopy} />
          </section>
        )
      })}
    </div>
  )
}

/** stripe: the window color down each card's left edge. */
function CardList({ cards, label, stripe, waits, selected, models, onSelect, onCopy }: { cards: Card[]; label: string; stripe?: string; waits: HandoffWait[]; selected?: string; models: Record<string, string>; onSelect: (id: string, key: boolean) => void; onCopy: (text: string) => Promise<boolean> }) {
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
          <li key={chat.sessionId} style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 6 }}>
            <button type="button" className="hub-card" onClick={e => onSelect(chat.sessionId, e.detail === 0)} aria-pressed={on} style={stripe ? { borderLeft: `3px solid ${stripe}` } : undefined}>
              <span style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'baseline' }}>
                <span style={{ display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0 }}>
                  <span style={{ color: 'var(--hub-ink)', fontWeight: 500, letterSpacing: 0.2, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{origin || repoOf(chat.cwd)}</span>
                  {version > 1 && <Version n={version} />}
                </span>
                <span className="hub-chip" style={{ color: s.color, background: s.soft, flexShrink: 0 }}>{finished ? <Check /> : <i aria-hidden />}{s.label}</span>
              </span>
              <span style={{ font: '400 12px/1.5 var(--hub-mono)', color: 'var(--hub-ash)' }}>
                {repoOf(chat.cwd)}{active ? ` · ${active}${models[active] ? ` · ${models[active]}` : ''}` : ''}{progress ? ` · ${ago(progress.at)}` : ''}
              </span>
              {/* A button reads its children as flat text, so the progressbar screen readers get sits beside it; this one is the look. */}
              {tasks.length > 0 && <span aria-hidden style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', gap: 8, alignItems: 'center' }}>
                <TaskBar done={done} total={tasks.length} height={3} label="" />
                <span style={{ font: '400 11px/1 var(--hub-mono)', color: 'var(--hub-ash)' }}>{done}/{tasks.length}{left !== undefined && <span style={{ color: 'var(--hub-mute)' }}> · {say(left)} left</span>}</span>
              </span>}
              {left !== undefined && <span className="sr-only">{say(left)} left</span>}
              {tasks.length > 0 && !finished && <span aria-hidden style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' }}><TaskRows tasks={tasks} max={5} small /></span>}
              {running && <span style={{ color: 'var(--hub-blue)', fontSize: 13 }}>{running}</span>}
              {progress?.state === 'idle' && open > 0 && <span style={{ color: 'var(--hub-yellow)', fontSize: 13 }}>{plural(open, 'task')} open</span>}
              {finished && <span style={{ color: s.color, fontSize: 13 }}>{finishedLine(progress)}{progress.finishedAt ? ` · finished ${hhmm(progress.finishedAt)}` : ''}</span>}
              {finished && <Receipt p={progress} small />}
              {finished && progress.commit && <span style={{ ...ellipsis, font: '400 12px/1.5 var(--hub-mono)', color: 'var(--hub-body)' }}>{progress.commit.split('\n')[0]}</span>}
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
