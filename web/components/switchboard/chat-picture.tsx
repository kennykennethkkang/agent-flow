'use client'
import { useEffect, useState } from 'react'
import type { ChatProfile, ChatProgress, ChatRow, SessionLive } from '@/lib/hub-types'
import { STATE, ago, caps, panel, repoOf } from './look'
import { Orbit } from './orbit'
import { Switch } from './gear'
import { CopyCommit, TaskBar } from './chat-cards'
import { ToolChips } from './tool-chips'

const TOOLS_KEY = 'switchboard.toolCalls'
const clock = (at: number) => new Date(at).toTimeString().slice(0, 8)

/** models: each role's model, for the orbit and the task list. */
/** profile: the chat's own plugins and skills, when Switchboard started it with a set; onProfile saves a change. */
export function ChatPicture({ chat, progress, live, instant, models = {}, profile, flagged = [], onProfile, onFocus, onCopy }: {
  chat: ChatRow; progress?: ChatProgress; live?: SessionLive; instant?: boolean; models?: Record<string, string>
  profile?: ChatProfile; flagged?: string[]; onProfile?: (p: ChatProfile) => void; onFocus: () => void; onCopy: (text: string) => Promise<boolean>
}) {
  const [showTools, setShowTools] = useState(true)
  useEffect(() => { try { if (localStorage.getItem(TOOLS_KEY) === 'off') setShowTools(false) } catch { /* no storage: keep on */ } }, [])
  const toggle = (on: boolean) => { setShowTools(on); try { localStorage.setItem(TOOLS_KEY, on ? 'on' : 'off') } catch { /* no storage */ } }

  const state = progress?.state ?? 'idle', s = STATE[state], name = chat.name ?? repoOf(chat.cwd)
  const since = ago(progress?.at ?? chat.updatedAt ?? Date.now())
  const tasks = progress?.tasks ?? [], done = tasks.filter(t => t.status === 'completed').length
  const feed = [...(progress?.tools ?? [])].reverse().slice(0, 6)
  const cost = [live?.costUsd !== undefined ? `$${live.costUsd.toFixed(2)}` : '', live?.tokens ? `${Math.round(live.tokens / 1000)}k tokens` : ''].filter(Boolean).join(' · ')

  let left
  if (state === 'needs-you') left = <>
    <h3 style={caps}><span>Needs you</span></h3>
    <p style={{ margin: 0, color: 'var(--hub-ink)', fontSize: 15 }}>{progress?.question ?? 'This chat is waiting on you.'}</p>
    <div><button type="button" className="hub-btn" onClick={onFocus}>Answer in terminal</button></div>
  </>
  else if (state === 'done') left = <>
    <h3 style={caps}><span>Done</span>{tasks.length > 0 && <span>{done} of {tasks.length}</span>}</h3>
    {progress?.commit
      ? <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <code style={{ font: '400 12px/1.5 var(--hub-mono)', color: 'var(--hub-green)', background: 'var(--hub-green-soft)', padding: '4px 8px', borderRadius: 6, overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' }}>{progress.commit}</code>
          <CopyCommit text={progress.commit} onCopy={onCopy} />
        </div>
      : <p style={{ margin: 0, color: 'var(--hub-ash)' }}>No commit message.</p>}
  </>
  else left = <>
    <h3 style={caps}><span>Tasks</span>{tasks.length > 0 && <span>{done} of {tasks.length}</span>}</h3>
    {tasks.length > 0 ? <>
      <TaskBar done={done} total={tasks.length} label="Tasks done" />
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
        {tasks.map(t => (
          <li key={t.id} data-s={t.status} style={{ display: 'flex', gap: 10, alignItems: 'center', color: t.status === 'pending' ? 'var(--hub-ash)' : 'var(--hub-body)' }}>
            <span className="hub-tick" aria-hidden />
            <span style={{ minWidth: 0 }}><span className="sr-only">{t.status.replace('_', ' ')}: </span>{t.subject}{t.role && <span style={{ color: 'var(--hub-ash)' }}> · {t.role}{models[t.role] ? ` · ${models[t.role]}` : ''}</span>}</span>
          </li>
        ))}
      </ul>
    </> : <p style={{ margin: 0, color: 'var(--hub-ash)' }}>No task list yet{state === 'idle' ? `. This chat has been quiet for ${since}.` : '.'}</p>}
  </>

  return (
    <section aria-labelledby="pic-name" style={{ display: 'grid', gap: 16, padding: 20, minWidth: 0, alignContent: 'start' }}>
      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
        <div style={{ display: 'grid', gap: 4, minWidth: 0 }}>
          <h2 id="pic-name" style={{ margin: 0, font: '500 22px/1.15 var(--hub-sans)', color: 'var(--hub-ink)', textWrap: 'balance' }}>{name}</h2>
          <p style={{ margin: 0, font: '400 13px/1.4 var(--hub-mono)', color: 'var(--hub-ash)' }}>{repoOf(chat.cwd)} · <span style={{ color: s.color }}>{s.label}</span> · {since}</p>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <Switch on={showTools} onChange={toggle} label="Tool calls" text="Tool calls" />
          <button type="button" className="hub-btn" onClick={onFocus}>Open terminal</button>
        </div>
      </div>
      <Orbit chat={{ id: chat.sessionId, name, state, ago: since, progress, live, models }} showTools={showTools} instant={instant} />
      <div className="hub-below">
        <div style={panel}>{left}</div>
        <div style={panel}>
          <h3 style={caps}><span>Activity</span><span>{cost}</span></h3>
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
        <details style={panel}>
          <summary style={{ ...caps, cursor: 'pointer' }}><span>Tools</span><span>{profile ? `${Object.values(profile.plugins).filter(Boolean).length} plugins on` : 'defaults'}</span></summary>
          {profile && onProfile
            ? <>
                <p style={{ margin: 0, color: 'var(--hub-ash)', fontSize: 13 }}>Changes save now and apply when this chat is resumed or restarted.</p>
                <ToolChips profile={profile} flagged={flagged} onChange={onProfile} />
              </>
            : <p style={{ margin: 0, color: 'var(--hub-ash)', fontSize: 13 }}>This chat runs with your default plugins and skills.</p>}
        </details>
      )}
    </section>
  )
}
