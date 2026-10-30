'use client'
// Relay: the chat as a pipeline, you to lead to each role to the commit. Wires light once work has
// passed along them, a packet runs down a wire when work moves, and qa sending work back shows as a loop tag.
import { useEffect, useRef, useState } from 'react'
import { ORDER, almostDone } from '../look'
import { loopsOf, teamOf, type TeamRole } from '@/lib/orbit-views'
import { Glyph, LABEL, Legend, NAME, Reveal, leadLine, leadState, useLive, type ViewProps } from './parts'
import { describe } from '../orbit'
import { CommitText } from '../commit-text'

type Station = { k: string; s: string; name: string; small: string; now?: string; role?: TeamRole }
type Packet = { id: number; wire: number; back?: boolean; tone: string }

export function Relay({ chat, showTools }: ViewProps) {
  const root = useRef<HTMLDivElement>(null)
  useLive(root)
  const p = chat.progress, almost = almostDone(p), team = teamOf(p), loops = loopsOf(p)
  const active = team.filter(r => r.state === 'active').map(r => r.role)
  const ls = leadState(chat, almost), finished = chat.state === 'done'
  const cur = p?.tasks.find(t => t.status === 'in_progress')?.subject
  const stations: Station[] = [
    { k: 'you', s: chat.state === 'needs-you' ? 'needs' : 'idle', name: 'You', small: chat.state === 'needs-you' ? 'answer below' : 'asked', now: chat.state === 'needs-you' ? undefined : p?.asked?.at(-1) },
    { k: 'lead', s: ls, name: 'Lead', small: [chat.live?.model, leadLine(chat, almost, active)].filter(Boolean).join(' · '), now: chat.state === 'needs-you' ? p?.question : cur },
    ...team.map(r => ({ k: r.role, s: r.state, name: NAME(r.role), small: [LABEL[r.state], chat.models?.[r.role]].filter(Boolean).join(' · '), now: r.state === 'unused' ? undefined : r.task, role: r })),
    { k: 'commit', s: finished ? (almost ? 'almost' : 'done') : 'unused', name: 'Commit', small: finished ? (p?.commit ? 'message ready' : 'no message') : 'not yet' },
  ]
  const bench = ORDER.filter(r => !team.some(m => m.role === r))
  const reached = (s: Station) => !['unused', 'waiting', 'idle'].includes(s.s) || s.k === 'you'
  const eng = stations.findIndex(s => s.k === 'engineer'), qa = stations.findIndex(s => s.k === 'qa')

  // Packets: a role starting pulls one in from the left, a role finishing sends one on, a question goes back to you.
  const prev = useRef<Map<string, string> | null>(null), seq = useRef(0)
  const [packets, setPackets] = useState<Packet[]>([])
  const [pops, setPops] = useState<Record<string, { key: string; tool: string; target?: string }>>({})
  const seen = useRef<Set<string> | null>(null)
  const key = stations.map(s => `${s.k}:${s.s}`).join('|')
  useEffect(() => {
    const now = new Map(stations.map(s => [s.k, s.s])), was = prev.current
    prev.current = now
    if (!was || matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const add: Packet[] = []
    stations.forEach((s, i) => {
      const before = was.get(s.k)
      if (before === undefined || before === s.s) return
      if (s.k === 'you' && s.s === 'needs') add.push({ id: ++seq.current, wire: 0, back: true, tone: 'var(--hub-red)' })
      else if (s.k === 'you' && before === 'needs') add.push({ id: ++seq.current, wire: 0, tone: 'var(--hub-ink)' })
      else if (s.k === 'commit' && (s.s === 'done' || s.s === 'almost')) add.push({ id: ++seq.current, wire: i - 1, tone: s.s === 'almost' ? 'var(--hub-teal)' : 'var(--hub-green)' })
      else if (s.role && s.s === 'active') add.push({ id: ++seq.current, wire: i - 1, tone: 'var(--hub-blue)' })
      else if (s.role && s.s === 'done' && before === 'active' && i < stations.length - 1) add.push({ id: ++seq.current, wire: i, tone: 'var(--hub-ink)' })
    })
    if (add.length) setPackets(list => [...list, ...add].slice(-6))
  }, [key])

  // The newest tool call per station pops above it, once; the first look at a chat shows none.
  const calls = p?.tools ?? [], callKey = calls.map(c => `${c.at}:${c.tool}`).join('|')
  useEffect(() => {
    const keys = calls.map(c => `${c.at}:${c.tool}`)
    if (!seen.current) { seen.current = new Set(keys); return }
    const fresh = calls.filter((c, i) => !seen.current!.has(keys[i]))
    keys.forEach(k => seen.current!.add(k))
    if (!fresh.length || !showTools) return
    setPops(old => {
      const next = { ...old }
      for (const c of fresh) { const at = stations.some(s => s.k === c.role) ? c.role : 'lead'; next[at] = { key: `${c.at}:${c.tool}`, tool: c.tool, target: c.target } }
      return next
    })
  }, [callKey])

  const wireLit = (i: number) => {
    const a = stations[i], b = stations[i + 1]
    if (i === 0) return chat.state === 'needs-you' ? 'red' : '1'
    if (b.k === 'commit') return b.s === 'done' ? 'green' : b.s === 'almost' ? 'teal' : undefined
    return reached(b) && reached(a) ? '1' : undefined
  }

  return (
    <div ref={root} className="ov-stage ov-relay">
      <ol className="ov-chain" role="img" aria-label={`${describe(chat)}${loops ? ` QA sent work back ${loops === 1 ? 'once' : `${loops} times`}.` : ''}`}>
        {stations.map((s, i) => [
          <li key={s.k} className="ov-st" data-s={s.s} data-k={s.k}>
            <span className="ov-disc">
              <svg className="ov-arc" viewBox="0 0 100 100" aria-hidden><circle cx="50" cy="50" r="47" /></svg>
              <Glyph k={s.k} size={s.k === 'lead' ? 20 : 16} />
              {s.role && s.role.running > 1 && <b className="ov-count">×{s.role.running}</b>}
              <span className="ov-ok" aria-hidden><svg viewBox="0 0 16 16"><path d="m4 8.4 2.6 2.6L12 5.6" /></svg></span>
              {showTools && pops[s.k] && <span key={pops[s.k].key} className="ov-pop" onAnimationEnd={() => setPops(o => { const n = { ...o }; delete n[s.k]; return n })}>
                {pops[s.k].tool}{pops[s.k].target && <span>{pops[s.k].target}</span>}
              </span>}
            </span>
            <span className="ov-lab">
              <b>{s.name}</b><small>{s.small}</small>
              {s.now && <span className="ov-now">{s.now}</span>}
              {s.role && s.role.runs.length > 1 && <span className="ov-subs">
                {s.role.runs.slice(0, 6).map((r, j) => <span key={r.id} className="ov-sub" data-s={r.state}><i />{j + 1}</span>)}
                {s.role.runs.length > 6 && <span className="ov-sub">+{s.role.runs.length - 6}</span>}
              </span>}
            </span>
          </li>,
          i < stations.length - 1 && <li key={`w${i}`} className="ov-wire" data-lit={wireLit(i)} aria-hidden>
            {packets.filter(k => k.wire === i).map(k => <span key={k.id} className="ov-run" data-back={k.back || undefined} style={{ '--c': k.tone } as React.CSSProperties}
              onAnimationEnd={() => setPackets(list => list.filter(x => x.id !== k.id))}><i /></span>)}
            {i === eng && qa === eng + 1 && loops > 0 && <span className="ov-loop">↺ {loops} loop{loops > 1 ? 's' : ''} back</span>}
          </li>,
        ])}
      </ol>
      {bench.length > 0 && <p className="ov-bench"><span>Not used</span>{bench.map(r => <span key={r} className="ov-chipb"><Glyph k={r} size={13} />{NAME(r)}</span>)}</p>}
      <Reveal on={chat.state === 'needs-you'} className="ov-call"><span data-tone="needs"><b>Needs you</b>{p?.question ?? 'This chat is waiting on you.'}</span></Reveal>
      <Reveal on={finished} className="ov-call"><span data-tone={almost ? 'almost' : 'done'}><b>{almost ? 'Almost done' : 'Finished'}</b>{p?.commit ? <CommitText text={p.commit} max={180} /> : 'No commit message.'}</span></Reveal>
      <Legend tools={showTools} almost={almost} />
    </div>
  )
}
