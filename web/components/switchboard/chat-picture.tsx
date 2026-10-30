'use client'
import { useEffect, useReducer, useState, type ReactNode } from 'react'
import type { Ask, ChatProfile, Choice, ChatProgress, ChatRow, Connection, Installed, Limit, SessionLive, TaskRow } from '@/lib/hub-types'
import { askChoice } from '@/lib/ask'
import { limitLine, testsPrompt } from '@/lib/checks'
import { eta, say, type Eta } from '@/lib/eta'
import { ago, almostDone, caps, coverage, panel, repoOf } from './look'
import { OrbitView } from './orbits'
import { Switch } from './gear'
import { Check, CopyCommit, Receipt, chipOf, finishedLine, hhmm, plural, stillRunning } from './chat-cards'
import { ToolsCard } from './tools-card'
import { CommitText } from './commit-text'
import { TestsCard } from './check-cards'

const TOOLS_KEY = 'switchboard.toolCalls'
const clock = (at: number) => new Date(at).toTimeString().slice(0, 8)
const row = { display: 'flex', gap: 8, flexWrap: 'wrap' } as const
const field = { font: '400 13px/1.4 var(--hub-sans)', padding: '7px 10px', borderRadius: 8, minWidth: 0, background: 'var(--hub-canvas)', color: 'var(--hub-ink)', border: '1px solid var(--hub-hair)' } as const
/** "42 min", "1 h 25 min", "under a minute". */
const dur = (ms: number) => say(ms).replace(/^about /, '')
const small = caps
const mono = { font: '400 12px/1.4 var(--hub-mono)', color: 'var(--hub-ash)', whiteSpace: 'nowrap' } as const

/** One segment per task, in list order: done green, current blue (yellow once the chat stopped), pending a hairline. */
function Steps({ tasks, stopped }: { tasks: TaskRow[]; stopped: boolean }) {
  const done = tasks.filter(t => t.status === 'completed').length, at = tasks.findIndex(t => t.status === 'in_progress')
  const fill = { completed: 'var(--hub-green)', in_progress: stopped ? 'var(--hub-yellow)' : 'var(--hub-blue)', pending: 'var(--hub-hair-strong)' }
  return (
    <div role="progressbar" aria-label="Tasks done" aria-valuemin={0} aria-valuemax={tasks.length} aria-valuenow={done}
      aria-valuetext={`${done} of ${tasks.length} done${at >= 0 ? `, on step ${done + 1}` : ''}`} style={{ display: 'flex', gap: 2, height: 6 }}>
      {tasks.map(t => <i key={t.id} style={{ flex: 1, minWidth: 0, borderRadius: 3, background: fill[t.status] }} />)}
    </div>
  )
}

/** The working or idle chat's tracker: which step, how long, what is done and what is left. */
function Progress({ p, e, now, models, since }: { p: ChatProgress; e: Eta; now: number; models: Record<string, string>; since: string }) {
  const cur = e.current, open = e.total - e.done, stopped = p.state === 'idle'
  const role = (t: TaskRow) => t.role ? ` · ${t.role}${models[t.role] ? ` · ${models[t.role]}` : ''}` : ''
  const done = p.tasks.filter(t => t.status === 'completed'), doing = p.tasks.filter(t => t.status === 'in_progress'), pending = p.tasks.filter(t => t.status === 'pending')
  return <>
    <h3 style={caps}><span>Tasks in this chat</span>{!stopped && <span>Running {dur(e.elapsedMs)}</span>}</h3>
    <div style={{ display: 'grid', gap: 4 }}>
      <p style={{ margin: 0, font: '500 12px/1.3 var(--hub-mono)', color: 'var(--hub-mute)' }}>{e.done} of {e.total} done</p>
      {cur && <p data-s="in_progress" data-c={p.state} aria-current="step" style={{ margin: 0, display: 'flex', gap: 10, alignItems: 'center', font: '500 17px/1.3 var(--hub-sans)', color: 'var(--hub-ink)', overflowWrap: 'anywhere', textWrap: 'balance' }}><span className="hub-tick" aria-hidden /><span><span className="sr-only">now: </span>{cur.subject}</span></p>}
      {cur && (cur.role || cur.startedAt !== undefined) && <p style={{ ...mono, margin: 0, paddingLeft: 24, whiteSpace: 'normal' }}>{role(cur).slice(3)}{cur.role && cur.startedAt !== undefined ? ' · ' : ''}{cur.startedAt !== undefined && `for ${dur(now - cur.startedAt)}`}</p>}
    </div>
    <Steps tasks={p.tasks} stopped={stopped} />
    <p role="status" className="hub-num" style={{ margin: 0, fontSize: 14, color: 'var(--hub-body)' }}>
      {stopped && open ? <span style={{ color: 'var(--hub-yellow)' }}>Stopped with {plural(open, 'task')} left{since !== 'now' ? `, quiet for ${since}` : ''}.</span>
        : !open ? <span style={{ color: 'var(--hub-green)' }}>Every task done.</span>
        : e.leftMs !== undefined ? <><span style={{ color: 'var(--hub-ink)', fontWeight: 500 }}>{say(e.leftMs).replace(/^./, c => c.toUpperCase())} left</span> <span style={{ color: 'var(--hub-ash)', fontSize: 13 }}>at {dur(e.perTaskMs!)} per task so far</span></>
        : <span style={{ color: 'var(--hub-ash)' }}>Estimate after the first task.</span>}
    </p>
    <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
      {done.length > 4 && <li style={{ color: 'var(--hub-ash)', fontSize: 12, paddingLeft: 28 }}>{done.length - 3} earlier tasks done</li>}
      {done.slice(done.length > 4 ? -3 : 0).map(t => <li key={t.id} data-s="completed" style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--hub-ash)', fontSize: 13 }}>
        <span className="hub-tick" aria-hidden /><span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}><span className="sr-only">done: </span>{t.subject}</span>
        {t.startedAt !== undefined && t.doneAt !== undefined && <span style={mono}>{dur(t.doneAt - t.startedAt)}</span>}
      </li>)}
      {doing.filter(t => t.id !== cur?.id).map(t => <li key={t.id} data-s="in_progress" data-c={p.state} style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--hub-body)', fontSize: 13 }}>
        <span className="hub-tick" aria-hidden /><span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}><span className="sr-only">also now: </span>{t.subject}<span style={{ color: 'var(--hub-ash)' }}>{role(t)}</span></span>
      </li>)}
    </ul>
    {pending.length > 0 && <div style={{ display: 'grid', gap: 4 }}>
      <h4 style={small}><span>Not started</span><span>{pending.length}</span></h4>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
        {pending.map(t => <li key={t.id} data-s="pending" style={{ display: 'flex', gap: 10, alignItems: 'center', color: 'var(--hub-mute)', fontSize: 13 }}>
          <span className="hub-tick" aria-hidden /><span style={{ minWidth: 0, overflowWrap: 'anywhere' }}><span className="sr-only">left: </span>{t.subject}<span style={{ color: 'var(--hub-ash)' }}>{role(t)}</span></span>
        </li>)}
      </ul>
    </div>}
  </>
}

/** The top of Activity for a chat waiting on Kenneth (its open tasks) or an almost done one (the requests it missed).
 *  Working and stopped chats show their tasks in Progress only; a finished chat's leftovers live in the to-do panel. */
function LeftNow({ p }: { p: ChatProgress }) {
  const missed = p.state === 'done'
  const items = missed
    ? (p.asked ?? []).filter((_, i) => coverage(p, i) === 'missed').map(subject => ({ subject, s: 'missed' }))
    : p.tasks.filter(t => t.status !== 'completed').sort((a, b) => (a.status === 'in_progress' ? -1 : 0) - (b.status === 'in_progress' ? -1 : 0)).map(t => ({ subject: t.subject, s: t.status as string }))
  if (!items.length) return null
  return (
    <div style={{ display: 'grid', gap: 6, paddingBottom: 12, borderBottom: '1px solid var(--hub-hair)' }}>
      <h4 style={small}><span>{missed ? 'Not covered' : 'Open tasks'}</span>{!missed && <span style={{ color: 'var(--hub-red)', textTransform: 'none' }}>waiting on you</span>}</h4>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4, fontSize: 13 }}>
        {items.slice(0, 3).map((t, i) => <li key={i} data-s={t.s} data-c={p.state} style={{ display: 'flex', gap: 10, alignItems: 'center', color: t.s === 'pending' ? 'var(--hub-mute)' : 'var(--hub-body)' }}>
          <span className="hub-tick" aria-hidden /><span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{t.subject}</span>
        </li>)}
        {items.length > 3 && <li style={{ color: 'var(--hub-ash)', paddingLeft: 24 }}>{items.length - 3} more</li>}
      </ul>
    </div>
  )
}

/** The terminal's prompt with its options as buttons; several questions, a multiSelect one or Other text are filled in first, then sent together. */
function AskButtons({ ask, onAnswer }: { ask: Ask; onAnswer: (askId: string, choice: Choice) => void }) {
  const [picks, setPicks] = useState<Array<number | number[] | undefined>>([])
  const [others, setOthers] = useState<Record<number, string>>({})
  useEffect(() => { setPicks([]); setOthers({}) }, [ask.id])
  if (ask.kind === 'permission') return <>
    <p style={{ margin: 0, color: 'var(--hub-mute)', fontSize: 13 }}>{ask.tool}</p>
    {ask.preview && <code style={{ font: '400 12px/1.5 var(--hub-mono)', color: 'var(--hub-ink)', background: 'var(--hub-hair)', padding: '4px 8px', borderRadius: 6, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{ask.preview}</code>}
    <div style={row}>{ask.options.map((o, i) => <button key={i} type="button" className="hub-btn" onClick={() => onAnswer(ask.id, [i])}>{o}</button>)}</div>
  </>
  const qs = ask.questions ?? []
  const multi = qs.some(q => q.multiSelect)
  const together = qs.length > 1 || multi || Object.keys(others).length > 0
  const picked = (n: number) => [picks[n] ?? []].flat()
  const closeOther = (n: number) => { const rest = { ...others }; delete rest[n]; setOthers(rest) }
  const pick = (n: number, i: number) => {
    const next = [...picks]
    next[n] = qs[n].multiSelect ? (picked(n).includes(i) ? picked(n).filter(x => x !== i) : [...picked(n), i]) : i
    // A single-select question takes one answer, so an option closes its Other.
    if (!qs[n].multiSelect && n in others) closeOther(n)
    if (qs.length === 1 && !multi) onAnswer(ask.id, [i]); else setPicks(next)
  }
  const toggleOther = (n: number) => {
    if (n in others) return closeOther(n)
    setOthers({ ...others, [n]: '' })
    if (!qs[n].multiSelect) { const next = [...picks]; next[n] = undefined; setPicks(next) }
  }
  const choice = askChoice(qs, picks, others)
  return <>
    {qs.map((q, n) => (
      <div key={n} role="group" aria-label={q.header ?? q.question} style={{ display: 'grid', gap: 6 }}>
        {qs.length > 1 && <p style={{ margin: 0, fontSize: 13 }}>{q.header && <span style={{ color: 'var(--hub-ash)' }}>{q.header} · </span>}{q.question}</p>}
        <div style={row}>
          {q.options.map((o, i) => <button key={i} type="button" className="hub-btn hub-opt" aria-pressed={together ? picked(n).includes(i) : undefined} onClick={() => pick(n, i)}>{o}</button>)}
          <button type="button" className="hub-btn hub-opt" aria-pressed={n in others} onClick={() => toggleOther(n)}>Other…</button>
        </div>
        {n in others && <input type="text" autoFocus maxLength={200} style={field} aria-label={`Other answer for ${q.header ?? q.question}`} placeholder="Type your answer"
          value={others[n]} onChange={e => setOthers({ ...others, [n]: e.target.value })}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229 && choice) onAnswer(ask.id, choice) }} />}
      </div>
    ))}
    {together && <div><button type="button" className="hub-btn" disabled={!choice} onClick={() => choice && onAnswer(ask.id, choice)}>Submit answers</button></div>}
  </>
}

/** models: each role's model, for the orbit and the task list. */
/** profile: the chat's own plugins and skills, when Switchboard started it with a set; onProfile saves a change. */
/** limits and autoContinue: for the usage-limit card; onSend: queues a message to this chat. */
/** place: the VS Code window holding the chat, by color. menu: the chat's more actions. installed, connections, onInstalled, toolsOpen: for the Tools card. */
export function ChatPicture({ chat, progress, live, instant, models = {}, profile, flagged = [], limits = [], autoContinue = false, place, menu, installed, connections, toolsOpen, onInstalled, onProfile, onFocus, onAnswer, onCopy, onSend }: {
  chat: ChatRow; progress?: ChatProgress; live?: SessionLive; instant?: boolean; models?: Record<string, string>
  profile?: ChatProfile; flagged?: string[]; limits?: Limit[]; autoContinue?: boolean; onProfile?: (p: ChatProfile) => void; onFocus: () => void; onAnswer?: (askId: string, choice: Choice) => void; onCopy: (text: string) => Promise<boolean>; onSend?: (text: string) => void
  place?: { name: string; color: string }; menu?: ReactNode; installed?: Installed[]; connections?: Connection[]; toolsOpen?: boolean; onInstalled?: () => void
}) {
  const [showTools, setShowTools] = useState(true)
  useEffect(() => { try { if (localStorage.getItem(TOOLS_KEY) === 'off') setShowTools(false) } catch { /* no storage: keep on */ } }, [])
  // Durations move with the clock, not only with hook events.
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => { const t = setInterval(tick, 30e3); return () => clearInterval(t) }, [])
  const toggle = (on: boolean) => { setShowTools(on); try { localStorage.setItem(TOOLS_KEY, on ? 'on' : 'off') } catch { /* no storage */ } }

  const state = progress?.state ?? 'idle', s = chipOf(progress), name = chat.name ?? repoOf(chat.cwd)
  const since = ago(progress?.at ?? chat.updatedAt ?? Date.now())
  const tasks = progress?.tasks ?? [], now = Date.now(), e = progress && tasks.length ? eta(progress, now) : undefined
  const running = stillRunning(progress)
  const subs = (progress?.roles ?? []).filter(r => r.state === 'active' && progress?.running?.includes(r.id))
  const feed = [...(progress?.tools ?? [])].reverse().slice(0, 6)
  const cost = [live?.costUsd !== undefined ? `$${live.costUsd.toFixed(2)}` : '', live?.tokens ? `${Math.round(live.tokens / 1000)}k tokens` : ''].filter(Boolean).join(' · ')

  let left
  if (state === 'needs-you') left = <>
    <h3 style={{ ...caps, color: 'var(--hub-red)' }}><span>{progress?.limited ? 'Usage limit' : 'Needs you'}</span></h3>
    <p style={{ margin: 0, font: '500 17px/1.3 var(--hub-sans)', color: 'var(--hub-ink)', overflowWrap: 'anywhere', textWrap: 'balance' }}>{progress?.question ?? 'This chat is waiting on you.'}</p>
    {progress?.limited && <p style={{ margin: 0, color: 'var(--hub-body)', fontSize: 13 }}>{limitLine(limits, autoContinue)}</p>}
    {progress?.ask && onAnswer && chat.ai !== 'codex' && <AskButtons ask={progress.ask} onAnswer={onAnswer} />}
    <div><button type="button" className={progress?.ask && onAnswer ? 'hub-btn' : 'hub-btn primary'} onClick={onFocus}>Answer in terminal</button></div>
  </>
  else if (state === 'done' && progress) left = <>
    <h3 style={caps}><span>{s.label}</span>{progress.finishedAt && <span>{hhmm(progress.finishedAt)}</span>}</h3>
    <p role="status" style={{ margin: 0, display: 'flex', gap: 10, alignItems: 'center', color: s.color, fontSize: 15 }}>
      <span style={{ display: 'inline-grid', placeItems: 'center', width: 22, height: 22, borderRadius: '50%', background: s.color, color: 'var(--hub-canvas)', flex: 'none' }}><Check size={12} /></span>
      <span>{finishedLine(progress)}.</span>
    </p>
    {progress.commit
      ? <div style={{ display: 'grid', gap: 8, justifyItems: 'start', minWidth: 0 }}>
          <div style={{ display: 'grid', width: '100%', minWidth: 0 }}><CommitText text={progress.commit} color={s.color} soft={s.soft} /></div>
          <CopyCommit text={progress.commit} onCopy={onCopy} />
        </div>
      : <p style={{ margin: 0, color: 'var(--hub-ash)' }}>No commit message.</p>}
    <Receipt p={progress} />
  </>
  else left = <>
    {progress && e ? <Progress p={progress} e={e} now={now} models={models} since={since} />
      : <><h3 style={caps}><span>Tasks in this chat</span></h3><p style={{ margin: 0, color: 'var(--hub-ash)' }}>No task list yet{state === 'idle' ? `. This chat has been quiet for ${since}.` : '.'}</p></>}
    {running && <div role="status" style={{ display: 'grid', gap: 4, paddingTop: 4, borderTop: '1px solid var(--hub-hair)' }}>
      <p style={{ margin: 0, color: 'var(--hub-blue)', fontSize: 13 }}>{running}</p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2, font: '400 12px/1.5 var(--hub-mono)', color: 'var(--hub-body)' }}>
        {subs.map(r => <li key={r.id}>{r.role} <span style={{ color: 'var(--hub-ash)' }}>· since {hhmm(r.startedAt)}</span></li>)}
        {(progress?.jobs ?? []).map(j => <li key={j.id}>{j.label ?? 'Background command'} <span style={{ color: 'var(--hub-ash)' }}>· since {hhmm(j.startedAt)}</span></li>)}
      </ul>
    </div>}
  </>

  return (
    <section aria-labelledby="pic-name" className="hub-pic" style={{ display: 'grid', gap: 16, padding: 20, minWidth: 0, alignContent: 'start' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
        <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
          <h2 id="pic-name" style={{ margin: 0, font: '500 22px/1.15 var(--hub-sans)', color: 'var(--hub-ink)', textWrap: 'balance' }}>{name}</h2>
          <p style={{ margin: 0, font: '400 13px/1.4 var(--hub-mono)', color: 'var(--hub-ash)' }}>
            {place && <span title={`In the ${place.name} window`} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: place.color, marginRight: 8 }}><i aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: 'currentColor' }} />{place.name}{place.name === repoOf(chat.cwd) && <span className="sr-only"> window</span>}</span>}
            {place?.name === repoOf(chat.cwd) ? '' : repoOf(chat.cwd)}{place?.name === repoOf(chat.cwd) ? '· ' : ' · '}<span style={{ color: s.color }}>{s.label}</span> · {since}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Switch on={showTools} onChange={toggle} label="Show tool calls on the map" text="Tool calls" />
          <button type="button" className="hub-btn" onClick={onFocus}>Open terminal</button>
          {menu}
        </div>
      </div>
      <OrbitView chat={{ id: chat.sessionId, name, state, ago: since, progress, live, models }} showTools={showTools} instant={instant} />
      {progress?.tests && !progress.tests.ok && <TestsCard run={progress.tests} onSend={onSend && (() => onSend(testsPrompt(progress.tests!)))} />}
      <div className="hub-below">
        <div style={state === 'needs-you' ? { ...panel, border: '1px solid var(--hub-red)', background: 'var(--hub-red-soft)' } : panel}>{left}</div>
        <div style={panel}>
          <h3 style={caps}><span>Activity</span><span>{cost}</span></h3>
          {progress && (state === 'needs-you' || almostDone(progress)) && <LeftNow p={progress} />}
          {feed.length
            ? <ul className="hub-feed" aria-label="Latest tool calls, newest first" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6, font: '400 12px/1.5 var(--hub-mono)' }}>
                {feed.map(c => (
                  <li key={`${c.at}:${c.tool}`} style={{ display: 'grid', gridTemplateColumns: '64px minmax(0, 92px) minmax(0, 72px) minmax(0, 1fr)', gap: 8, color: 'var(--hub-mute)', whiteSpace: 'nowrap' }}>
                    <span>{clock(c.at)}</span>
                    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', minWidth: 0, overflow: 'hidden' }}>
                      <i aria-hidden style={{ flex: 'none', width: 6, height: 6, borderRadius: '50%', background: c.role === 'lead' ? 'var(--hub-ink)' : c.role === 'jev' ? 'var(--hub-violet)' : 'var(--hub-blue)' }} />
                      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.role}</span>
                    </span>
                    <span style={{ color: 'var(--hub-yellow)', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.tool}</span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--hub-body)' }}>{c.target ?? ''}</span>
                  </li>
                ))}
              </ul>
            : <p style={{ margin: 0, color: 'var(--hub-ash)', fontSize: 13 }}>No tool calls yet.</p>}
        </div>
      </div>
      {chat.ai !== 'codex' && (
        <ToolsCard profile={profile} flagged={flagged} installed={installed} connections={connections} open={toolsOpen} onProfile={onProfile} onInstalled={onInstalled} />
      )}
    </section>
  )
}
