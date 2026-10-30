'use client'
import { useEffect, useState } from 'react'
import type { ChatProgress, ChatRow, TodoItem, TodoList, WindowInfo } from '@/lib/hub-types'
import type { HubCommand } from '@/lib/vscode-bridge'
import { openElsewhere, ordered, runCount, runLanded, runTargets } from '@/lib/todo'
import { caps, panel, placeOf, repoOf } from './look'
import { Check, chipOf } from './chat-cards'
export { todoFolder } from '@/lib/todo'

const small = { padding: '6px 10px', fontSize: 12 } as const
const field = { font: '400 13px/1.4 var(--hub-sans)', padding: '7px 10px', borderRadius: 8, minWidth: 0, background: 'var(--hub-canvas)', color: 'var(--hub-ink)', border: '1px solid var(--hub-hair)' } as const
const row = { display: 'flex', alignItems: 'center', gap: 8, minHeight: 30, minWidth: 0 } as const
const tag = { fontSize: 12, color: 'var(--hub-ash)', whiteSpace: 'nowrap' } as const
const MAX = 300
const SYNC = { synced: 'Synced with origin', local: 'Only on this Mac', failing: 'Sync failing' } as const
// After a row goes away, focus lands somewhere useful instead of the page.
const refocus = (sel: string) => requestAnimationFrame(() => document.querySelector<HTMLElement>(sel)?.focus())
const hint = { margin: 0, fontSize: 12, lineHeight: 1.45, color: 'var(--hub-ash)' } as const

/** Future work for a project, kept across chats until done. Pick items to run them in a new chat or send them to a running one. */
/** windows: the chat a row runs in carries its window's color. */
export function TodoPanel({ folder: home, todos, chats, progress = [], windows, send }: { folder: string; todos: Record<string, TodoList>; chats: ChatRow[]; progress?: ChatProgress[]; windows?: WindowInfo[]; send: (c: HubCommand) => void }) {
  const [folder, setFolder] = useState(home)
  const list = todos[folder] ?? todos[home]
  const [text, setText] = useState('')
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [replacing, setReplacing] = useState(false)
  const [picked, setPicked] = useState<string[]>([])
  const [said, setSaid] = useState('')
  useEffect(() => { if (!said) return; const t = setTimeout(() => setSaid(''), 2500); return () => clearTimeout(t) }, [said])
  // A message waits for the list to show the change; a refused one never says it went.
  const [wait, setWait] = useState<{ path: string; msg: string; ok: (todo: TodoItem[]) => boolean } | null>(null)
  useEffect(() => { const l = wait && todos[wait.path]; if (l && wait.ok(l.todo)) { setSaid(wait.msg); setWait(null) } }, [todos, wait])
  // Never shown: the change did not land in time, so a later one (a handoff) cannot set it off.
  useEffect(() => { if (!wait) return; const t = setTimeout(() => setWait(null), 15_000); return () => clearTimeout(t) }, [wait])
  // Items that left the list (done here or elsewhere) drop out of the pick.
  const live = picked.filter(id => list.todo.some(t => t.id === id))
  const add = () => { if (text.trim()) { send({ type: 'hub-todo-add', path: folder, text: text.trim() }); setText('') } }
  const sync = list.sync
  const save = () => { if (editing?.text.trim()) send({ type: 'hub-todo-edit', path: folder, id: editing.id, text: editing.text.trim() }); setEditing(null) }
  const toggle = (id: string) => setPicked(live.includes(id) ? live.filter(x => x !== id) : [...live, id])
  const run = (to?: string, ids = live) => {
    const was = new Map(list.todo.map(t => [t.id, t.chat]))
    send({ type: 'hub-todo-run', path: folder, ids, ...(to ? { to } : {}) }); setPicked([])
    setWait({ path: folder, msg: to ? 'Sent to the chat.' : 'Starting a chat on it.', ok: todo => runLanded(todo, ids, was, to) })
  }
  const done = (t: TodoItem) => { refocus('[aria-label="New to-do item"]'); send({ type: 'hub-todo-remove', path: folder, id: t.id }); setWait({ path: folder, msg: `Done: ${t.text}`, ok: todo => !todo.some(x => x.id === t.id) }) }
  const name = (id?: string) => chats.find(c => c.sessionId === id)?.name
  const others = openElsewhere(todos, folder), folders = Object.keys(todos)
  const n = runCount(list.todo, live), targets = runTargets(chats, folder)
  return (
    <section aria-labelledby="todo-title" style={panel}>
      <h3 id="todo-title" style={caps}><span>To-do for later</span><span style={{ textTransform: 'none' }}>Shared by every chat</span></h3>
      <div style={{ ...row, flexWrap: 'wrap', fontSize: 13, marginTop: -4 }}>
        {folders.length > 1
          ? <select className="hub-select" aria-label="Project" value={folder} onChange={e => { setFolder(e.target.value); setPicked([]) }}>
              {folders.map(f => <option key={f} value={f}>{repoOf(f)} ({todos[f].todo.length})</option>)}
            </select>
          : <span style={{ color: 'var(--hub-ink)' }}>{repoOf(folder)}</span>}
        {others > 0 && <span style={{ color: 'var(--hub-ash)', fontSize: 12 }}>{others} in other projects</span>}
      </div>
      {list.todo.length > 0 && <p style={hint}>Saved for a later chat. Pick items to run them now.</p>}
      {list.todo.length > 1 && <label className="hub-check hub-pick" style={{ ...row, minHeight: 24, fontSize: 12, color: 'var(--hub-mute)', cursor: 'pointer', paddingLeft: 11 }}>
        <input type="checkbox" checked={live.length === list.todo.length} ref={el => { if (el) el.indeterminate = live.length > 0 && live.length < list.todo.length }}
          onChange={() => setPicked(live.length === list.todo.length ? [] : list.todo.map(t => t.id))} />
        Pick all
      </label>}
      {list.todo.length
        ? <ul role="list" aria-label="To-do items" className="hub-todo">
            {ordered(list.todo).map(({ t, depth }) => {
              if (editing?.id === t.id) return <li key={t.id} style={{ paddingLeft: 10 + depth * 20 }}>
                <form style={{ display: 'flex', gap: 6 }} onSubmit={e => { e.preventDefault(); save() }}>
                  <input aria-label="Edit to-do item" autoFocus maxLength={MAX} value={editing.text} onChange={e => setEditing({ id: t.id, text: e.target.value })}
                    onKeyDown={e => { if (e.key === 'Escape') { setEditing(null); refocus(`[data-edit="${t.id}"]`) } }} style={{ ...field, flex: 1 }} />
                  <button type="submit" className="hub-btn" style={small}>Save</button>
                </form>
              </li>
              const chat = t.chat ? chats.find(c => c.sessionId === t.chat) : undefined
              const ended = !!t.chat && !chat?.live
              const dot = chipOf(progress.find(p => p.sessionId === t.chat)).color
              return <li key={t.id} data-picked={live.includes(t.id) || undefined} style={{ ...row, flexWrap: 'wrap', alignItems: 'flex-start', columnGap: 8, rowGap: 0, paddingLeft: 10 + depth * 20 }}>
                <label className="hub-check hub-pick" style={{ display: 'flex', alignItems: 'flex-start', gap: 10, flex: '1 1 220px', minWidth: 0, cursor: 'pointer', fontSize: 13, color: 'var(--hub-ink)', paddingTop: 5 }}>
                  <input type="checkbox" aria-label={`Pick ${t.text} to run`} checked={live.includes(t.id)} onChange={() => toggle(t.id)} style={{ margin: '1px 0 0' }} />
                  <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                    {depth > 0 && <span style={{ ...tag, color: 'var(--hub-yellow)', marginRight: 2 }}>needed first</span>}{depth > 0 && ' '}
                    {t.text}
                    {t.chat && !ended && ' '}{t.chat && !ended && <span title={placeOf(chat?.cwd, windows) && `In the ${placeOf(chat?.cwd, windows)!.name} window`} style={{ ...tag, color: 'var(--hub-mute)', marginLeft: 2, ...(placeOf(chat?.cwd, windows) ? { borderLeft: `2px solid ${placeOf(chat?.cwd, windows)!.color}`, paddingLeft: 6 } : {}) }}>
                      <i aria-hidden style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: dot, marginRight: 5, verticalAlign: 1 }} />
                      in {chat?.name ?? 'a chat'}
                    </span>}
                    {ended && <> <span style={{ ...tag, marginLeft: 2 }}>chat ended</span></>}
                    {t.from && !t.chat && ' '}{t.from && !t.chat && <span style={{ ...tag, marginLeft: 2 }}>from {name(t.from) ?? 'a finished chat'}</span>}
                  </span>
                </label>
                <span style={{ display: 'flex', gap: 2, flex: 'none', marginLeft: 'auto' }}>
                  {ended && <button type="button" className="hub-link" style={{ fontSize: 12, color: 'var(--hub-blue)' }} aria-label={`Start ${t.text} again in a new chat`} onClick={() => run(undefined, [t.id])}>Start again</button>}
                  <button type="button" className="hub-link" style={{ fontSize: 12 }} data-edit={t.id} aria-label={`Edit ${t.text}`} onClick={() => setEditing({ id: t.id, text: t.text })}>Edit</button>
                  <button type="button" className="hub-link" style={{ fontSize: 12 }} aria-label={`Mark ${t.text} done`}
                    onClick={() => done(t)}>Done</button>
                </span>
              </li>
            })}
          </ul>
        : <p style={{ margin: 0, fontSize: 13, color: 'var(--hub-ash)' }}>Nothing saved for later. Add an item here, or a chat adds what it could not finish.</p>}
      {live.length > 0 && <div role="toolbar" aria-label="Run the picked items" style={{ ...row, flexWrap: 'wrap', padding: '8px 10px', borderRadius: 8, background: 'var(--hub-canvas)', border: '1px solid var(--hub-hair)' }}>
        <span style={{ fontSize: 12, color: 'var(--hub-ash)', flex: '1 1 120px' }}>{live.length} picked to run{n > live.length ? `, ${n - live.length} needed first` : ''}</span>
        <button type="button" className="hub-btn primary" style={small} onClick={() => run()}>Run in new chat</button>
        {targets.map(c => <button key={c.sessionId} type="button" className="hub-btn" style={small} onClick={() => run(c.sessionId)}>Send to {c.name ?? 'running chat'}</button>)}
        <button type="button" className="hub-link" style={{ fontSize: 12 }} onClick={() => setPicked([])}>Clear</button>
      </div>}
      {!!list.ticked?.length && <div role="group" aria-labelledby="ticked-title" style={{ display: 'grid', gap: 6, paddingTop: 10, borderTop: '1px solid var(--hub-hair)' }}>
        <h4 id="ticked-title" style={caps}><span>Ticked off by a chat</span><span>{list.ticked.length}</span></h4>
        <p style={hint}>A chat finished these. Put one back if it still needs doing.</p>
        <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 2 }}>
          {list.ticked.map(t => <li key={t.id} style={{ ...row, flexWrap: 'wrap', columnGap: 8, rowGap: 0, paddingLeft: 11 }}>
            <span style={{ display: 'flex', gap: 10, alignItems: 'baseline', flex: '1 1 220px', minWidth: 0, fontSize: 13, color: 'var(--hub-mute)' }}>
              <span style={{ color: 'var(--hub-green)', alignSelf: 'center', display: 'inline-flex', width: 18, justifyContent: 'center' }}><Check size={12} /></span>
              <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{t.text}<span style={{ ...tag, marginLeft: 6 }}>by {name(t.by) ?? 'a finished chat'}</span></span>
            </span>
            <button type="button" className="hub-link" style={{ fontSize: 12, marginLeft: 'auto', color: 'var(--hub-blue)' }} aria-label={`Put back ${t.text}`}
              onClick={() => send({ type: 'hub-todo-restore', path: folder, id: t.id })}>Put back</button>
          </li>)}
        </ul>
      </div>}
      <p role="status" style={{ margin: 0, fontSize: 12, color: 'var(--hub-green)', minHeight: said ? undefined : 0 }}>{said}</p>
      <form style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }} onSubmit={e => { e.preventDefault(); add() }}>
        <input aria-label="New to-do item" placeholder="Add something for later" maxLength={MAX} value={text} onChange={e => setText(e.target.value)} style={{ ...field, flex: '1 1 160px' }} />
        <button type="submit" className="hub-btn" style={small} disabled={!text.trim()}>Add</button>
      </form>
      {sync && <p style={{ ...row, flexWrap: 'wrap', margin: 0, fontSize: 12, color: sync.state === 'failing' ? 'var(--hub-red)' : 'var(--hub-ash)' }} title={sync.why}>
        {SYNC[sync.state]}{sync.why ? `: ${sync.why}` : ''}
      </p>}
      {sync?.canSync && (sync.optIn || sync.state === 'local') && <label className="hub-check" style={{ ...row, fontSize: 12, color: 'var(--hub-ash)', cursor: 'pointer' }}
        title="Pushes this list to origin on refs/switchboard/todo, so other devices see it. Private repos sync by themselves.">
        <input type="checkbox" checked={!!sync.optIn} onChange={() => send({ type: 'hub-todo-sync', path: folder, on: !sync.optIn })} />
        Sync this project
      </label>}
      {sync?.remote && <p style={{ ...row, flexWrap: 'wrap', margin: 0, fontSize: 12, color: 'var(--hub-ash)' }}>
        <span style={{ flex: '1 1 200px' }}>The list on origin cannot be read, so sync is stopped. Replacing it pushes only this list.</span>
        <button type="button" className="hub-btn" style={small}
          onClick={() => { if (replacing) { setReplacing(false); send({ type: 'hub-todo-replace', path: folder, remote: sync.remote! }) } else setReplacing(true) }}>
          {replacing ? 'Press again to overwrite origin\'s copy' : 'Replace the remote list with this one'}
        </button>
      </p>}

    </section>
  )
}
