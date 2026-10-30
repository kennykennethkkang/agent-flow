'use client'
// Deck: one card per role, working ones open. A click opens or closes a card and that choice sticks for this chat.
import { useRef, useState } from 'react'
import { almostDone } from '../look'
import { teamOf, timeline, type TeamRole } from '@/lib/orbit-views'
import type { ToolCall } from '@/lib/hub-types'
import { say } from '@/lib/eta'
import { Glyph, LABEL, NAME, leadLine, leadState, useLive, type ViewProps } from './parts'
import { CommitText } from '../commit-text'

const clock = (at: number) => new Date(at).toTimeString().slice(0, 8)
const dur = (ms: number) => say(ms).replace(/^about /, '')
const CHEV = <svg className="ov-chev" viewBox="0 0 16 16" aria-hidden><path d="m6 3.5 4.5 4.5L6 12.5" /></svg>

function Feed({ list }: { list: ToolCall[] }) {
  if (!list.length) return null
  return <div><h4><span>Tool calls</span><span>{list.length}</span></h4>
    <ul className="ov-feed">{list.slice(-4).reverse().map(t => <li key={`${t.at}:${t.tool}`}><span>{clock(t.at)}</span><b>{t.tool}</b><span>{t.target ?? ''}</span></li>)}</ul>
  </div>
}

export function Deck({ chat, showTools }: ViewProps) {
  const root = useRef<HTMLDivElement>(null)
  useLive(root)
  const [manual, setManual] = useState<Record<string, boolean>>({})
  const p = chat.progress, almost = almostDone(p), team = teamOf(p), now = Date.now()
  const tl = p && timeline(p, now)
  const used = team.filter(r => r.state !== 'unused'), bench = team.filter(r => r.state === 'unused')
  const active = used.filter(r => r.state === 'active').map(r => r.role)
  const ls = leadState(chat, almost)
  const lead = p?.tools?.filter(t => t.role === 'lead') ?? []
  const cur = p?.tasks.find(t => t.status === 'in_progress')?.subject
  const tokens = chat.live?.tokens, cap = chat.live?.compactAt

  const card = (k: string, s: string, name: string, model: string | undefined, sum: string, chip: string, auto: boolean, body: React.ReactNode, tools: number, count = 0) => {
    const open = manual[k] ?? auto
    return (
      <article key={k} className="ov-card" data-s={s} data-open={open || undefined}>
        <button type="button" className="ov-hd" aria-expanded={open} aria-controls={`ov-bd-${k}`} onClick={() => setManual(m => ({ ...m, [k]: !open }))}>
          <span className="ov-gl" data-s={s}><Glyph k={k} />{count > 1 && <b className="ov-count">×{count}</b>}</span>
          <span className="ov-ttl"><span><i className="ov-ping" aria-hidden /><b>{name}</b>{model && <small>{model}</small>}</span><span className="ov-sum">{sum}</span></span>
          <span className="ov-end">{showTools && tools > 0 && <span className="ov-n">{tools} tool call{tools > 1 ? 's' : ''}</span>}<span className="ov-chip" data-s={s}><i /><span>{chip}</span></span>{CHEV}</span>
        </button>
        <div className="ov-bd" id={`ov-bd-${k}`}><div><div className="ov-in">{body}</div></div></div>
      </article>
    )
  }

  const roleCard = (r: TeamRole) => {
    const spans = tl?.rows.find(x => x.role === r.role)?.runs ?? []
    const sum = r.state === 'active' && r.running > 1 ? `${r.running} subagents: ${r.task ?? 'working'}` : r.task ?? (r.state === 'waiting' ? 'Queued by the lead' : 'Finished')
    return card(r.role, r.state, NAME(r.role), chat.models?.[r.role], sum, LABEL[r.state], r.state === 'active', <>
      {r.task && r.task !== sum && <p className="ov-task">{r.task}</p>}
      {spans.length > 0 && <div><h4><span>Subagents</span><span>{spans.length}</span></h4>
        <ul className="ov-runs">{spans.map((x, j) => <li key={x.id} data-s={x.state}><i aria-hidden /><span>Run {j + 1}{x.state === 'active' ? ', working' : ''}</span><span>{x.state === 'active' ? `${dur(now - x.from)} so far` : dur(x.to - x.from)}</span></li>)}</ul>
      </div>}
      {showTools && <Feed list={r.tools} />}
    </>, r.tools.length, r.running)
  }

  const leadSum = chat.state === 'needs-you' ? p?.question ?? 'Waiting on you' : chat.state === 'done' ? (p?.commit ? 'Finished. Commit message ready.' : 'Finished.') : cur ?? leadLine(chat, almost, active)
  const leadChip = { working: 'Working', needs: 'Needs you', done: 'Finished', almost: 'Almost done', idle: 'Idle' }[ls]
  return (
    <div ref={root} className="ov-stage ov-deck" aria-label="The chat as role cards">
      <p className="ov-you"><Glyph k="you" size={15} /><span><b>You</b>{p?.asked?.length ? <> · {p.asked.at(-1)}</> : null}</span><span>{chat.state === 'needs-you' ? 'waiting on you' : chat.ago}</span></p>
      {card('lead', ls, 'Lead', chat.live?.model, leadSum, leadChip, chat.state !== 'idle', <>
        {chat.state === 'needs-you' ? <p className="ov-note" data-tone="needs">{p?.question ?? 'This chat is waiting on you.'} Answer below.</p>
          : chat.state === 'done' ? <p className="ov-note" data-tone={almost ? 'almost' : 'done'}>{p?.commit ? <CommitText text={p.commit} max={180} /> : 'No commit message.'}</p>
          : cur && cur !== leadSum ? <p className="ov-task">{cur}</p> : null}
        {tokens && cap ? <div className="ov-ctx"><span>context</span><span className="ov-meter"><i style={{ transform: `scaleX(${Math.min(1, tokens / cap)})` }} /></span><span>{Math.round(Math.min(1, tokens / cap) * 100)}%</span></div> : null}
        {showTools && <Feed list={lead} />}
      </>, lead.length)}
      {used.map(roleCard)}
      {bench.length > 0 && <p className="ov-bench"><span>Not used</span>{bench.map(r => <span key={r.role} className="ov-chipb"><Glyph k={r.role} size={13} />{NAME(r.role)}</span>)}</p>}
    </div>
  )
}
