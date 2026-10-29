'use client'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { useHub } from '@/hooks/use-hub'
import { chatProjects, hideIdle, inProjects, liveChats } from '@/lib/archive'
import { switcherItems, type SwitchItem } from '@/lib/switcher'
import { todayView } from '@/lib/today'
import { taskTotals } from '@/lib/progress'
import { roleModels } from '@/lib/gear-rows'
import { ChatCards, History, ProjectFilter, type Card } from './chat-cards'
import { ChatPicture } from './chat-picture'
import { MessageBox } from './message-box'
import { ChangesPanel } from './changes'
import { GitPanel } from './git-panel'
import { Switcher } from './switcher'
import { TodayCard } from './today'
import { NewChat } from './new-chat'
import { Gear } from './gear'
import { SignIns } from './sign-ins'
import { PhoneAddress, PhoneQr } from './phone-qr'
import { DevRows } from './dev-rows'

const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); return true } catch { return false } }
const PROJECTS_KEY = 'switchboard.projects'
const isMac = () => typeof navigator !== 'undefined' && /Mac|iP/.test(navigator.platform)

export function Switchboard() {
  const { hub, send, isDemo, isVSCode, isLive, problem } = useHub()
  const sendRef = useRef(send)
  sendRef.current = send
  const [pick, setPick] = useState<{ id?: string; key: boolean }>({ key: false })
  const [panel, setPanel] = useState<'none' | 'new' | 'gear' | 'signins'>('none')
  const [finding, setFinding] = useState(false)
  const [phone, setPhone] = useState(false)
  const [reveal, setReveal] = useState<{ chain: string; at: number }>()
  // The project filter is this device's own, like the tool-calls toggle.
  const [projects, setProjects] = useState<string[]>([])
  useEffect(() => { try { const v = JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? '[]'); if (Array.isArray(v)) setProjects(v.filter(p => typeof p === 'string')) } catch { /* no storage: show all */ } }, [])
  const pickProjects = (next: string[]) => { setProjects(next); try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(next)) } catch { /* no storage */ } }
  const cards: Card[] = useMemo(() => liveChats(hub.chats, hub.archive ?? [])
    .map(chat => ({ chat, progress: hub.progress.find(p => p.sessionId === chat.sessionId) }))
    .sort((a, b) => (b.progress?.at ?? b.chat.updatedAt ?? 0) - (a.progress?.at ?? a.chat.updatedAt ?? 0)), [hub])
  // The rail shows the picked projects only, and hides chats idle past the setting (the picked one stays); Find still reaches every chat.
  const shown = useMemo(() => cards.filter(c => inProjects(c.chat.cwd, projects)), [cards, projects])
  const projectChips = useMemo(() => chatProjects(cards.map(c => c.chat.cwd), projects), [cards, projects])
  const idleMinutes = hub.controls.switchboard.idleMinutes
  const rail = useMemo(() => hideIdle(shown, idleMinutes, pick.id), [shown, idleMinutes, pick.id])
  const current = shown.find(c => c.chat.sessionId === pick.id) ?? rail[0] ?? shown[0]
  const currentId = current?.chat.sessionId
  // The extension reads the shown chat's changes, then again with each refresh; asked again only when the chat or the connection changes.
  useEffect(() => { if (currentId) sendRef.current({ type: 'hub-changes', sessionId: currentId }) }, [currentId, isDemo, isVSCode, isLive])
  // Cmd+K (Ctrl+K elsewhere), caught before VS Code's webview takes it as the start of a chord.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'k' || e.altKey || e.shiftKey || !(isMac() ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return
      e.preventDefault(); e.stopPropagation()
      setFinding(f => !f)
    }
    document.addEventListener('keydown', down, true)
    return () => document.removeEventListener('keydown', down, true)
  }, [])
  const items = useMemo(() => (finding ? switcherItems(cards, hub.archive ?? []) : []), [finding, cards, hub.archive])
  const choose = (item: SwitchItem) => {
    setFinding(false)
    // A Find pick outside the filter clears it, so the chat shows. A History chain key starts with its folder.
    if (item.kind === 'live') { setPick({ id: item.id, key: true }); if (!shown.some(c => c.chat.sessionId === item.id)) pickProjects([]) }
    else { setReveal({ chain: item.chain, at: Date.now() }); if (!inProjects(item.chain.split('\n')[0], projects)) pickProjects([]) }
  }
  const today = useMemo(() => todayView(cards, hub.history, hub.live, Date.now(), hub.jev), [cards, hub.history, hub.live, hub.jev])
  const tasks = useMemo(() => taskTotals(cards), [cards])
  const models = useMemo(() => roleModels(hub.installed, hub.controls.claude.model), [hub.installed, hub.controls.claude.model])
  // Limits ride on each live chat's feed; the first one that has them is as fresh as any.
  const limit = hub.live.find(l => l.limits.length)?.limits[0]
  const web = hub.webUrl
  // The QR takes the Mac's name when there is one, since it outlasts an IP change; the IP stays listed below it.
  const pu = hub.phoneUrls
  const phoneLinks = ([['Wi-Fi', pu?.wifiName, pu?.wifi], ['Tailscale', pu?.tailscaleName, pu?.tailscale]] as [string, string | undefined, string | undefined][])
    .flatMap(([name, byName, byIp]) => (byName ?? byIp ? [{ name, url: (byName ?? byIp)!, ip: byName ? byIp : undefined }] : []))
  return (
    <div className="hub" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--hub-surface)', color: 'var(--hub-body)', font: '400 14px/1.6 var(--hub-sans)' }}>
      <header style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, padding: '10px 16px', borderBottom: '1px solid var(--hub-hair)', background: 'var(--hub-canvas)' }}>
        <strong style={{ display: 'flex', gap: 8, alignItems: 'center', font: '600 15px/1 var(--hub-sans)', color: 'var(--hub-ink)' }}>
          <i aria-hidden style={{ width: 10, height: 10, borderRadius: '50%', background: 'var(--hub-blue)', boxShadow: '0 0 0 3px var(--hub-blue-soft)' }} />Switchboard
        </strong>
        <button type="button" className="hub-btn primary" aria-expanded={panel === 'new'} onClick={() => setPanel(panel === 'new' ? 'none' : 'new')}>New chat</button>
        <button type="button" className="hub-btn" aria-haspopup="dialog" onClick={() => setFinding(true)} title="Find a chat, live or in History">
          Find <kbd style={{ font: '400 11px/1 var(--hub-mono)', color: 'var(--hub-ash)', marginLeft: 4 }}>{isMac() ? '⌘K' : 'Ctrl K'}</kbd>
        </button>
        {isDemo && <span style={{ color: 'var(--hub-ash)', fontSize: 13 }}>Sample data: no VS Code window is connected</span>}
        <span style={{ marginLeft: 'auto', font: '400 12px/1 var(--hub-mono)', color: 'var(--hub-mute)' }}>{limit ? `${limit.kind.replace('_', ' ')} ${Math.round(limit.percentUsed)}%` : ''}</span>
        {isVSCode && <>
          <button type="button" className="hub-btn" onClick={() => send({ type: 'hub-web', phone: false })} title={web ? `Open ${web} in your browser` : 'Start the browser app, then open it'}>Open in browser ↗</button>
          <span style={{ position: 'relative' }}>
            {/* Asking for the link also starts the app when it is not running. */}
            <button type="button" className="hub-btn" aria-haspopup="dialog" aria-expanded={phone} onClick={() => { if (!phone) send({ type: 'hub-web', phone: true }); setPhone(!phone) }}>Phone</button>
            {phone && (
              <div role="dialog" aria-label="Open Switchboard on your phone" onKeyDown={e => { if (e.key === 'Escape') setPhone(false) }}
                style={{ position: 'absolute', right: 0, top: 'calc(100% + 8px)', zIndex: 20, width: 236, padding: 12, display: 'grid', gap: 8, justifyItems: 'center', borderRadius: 10, background: 'var(--hub-card)', border: '1px solid var(--hub-hair-strong)', boxShadow: '0 8px 24px rgba(0, 0, 0, 0.25)' }}>
                {phoneLinks.map(({ name, url, ip }) => <Fragment key={name}>
                  <PhoneQr url={url} label={`QR code that opens Switchboard on your phone (${name})`} />
                  <span style={{ font: '400 12px/1 var(--hub-sans)', color: 'var(--hub-mute)' }}>{name}</span>
                  <PhoneAddress url={url} ip={ip} onCopy={copy} />
                </Fragment>)}
                {phoneLinks.length > 0 && hub.phoneUrls?.code && <span style={{ display: 'grid', gap: 4, justifyItems: 'center', paddingTop: 8, borderTop: '1px solid var(--hub-hair)', width: '100%' }}>
                  <span style={{ font: '600 18px/1.2 var(--hub-mono)', color: 'var(--hub-ink)', letterSpacing: '0.08em' }}>Code {hub.phoneUrls.code.slice(0, 3)} {hub.phoneUrls.code.slice(3)}</span>
                  <span style={{ font: '400 12px/1.4 var(--hub-sans)', color: 'var(--hub-mute)' }}>Type an address, then this code</span>
                </span>}
                {!phoneLinks.length && <span style={{ font: '400 12px/1.5 var(--hub-sans)', color: 'var(--hub-ash)' }}>{
                  hub.phoneUrls ? 'This Mac has no Wi-Fi or Tailscale address right now.'
                    : web ? 'The running browser app has no phone access (started without --lan). Stop it, then press Phone again.' : 'Starting the browser app...'}</span>}
              </div>
            )}
          </span>
        </>}
        {hub.awake !== undefined && <button type="button" className="hub-btn" aria-pressed={hub.awake} onClick={() => send({ type: 'hub-awake', on: !hub.awake })}
          title="Keeps this Mac awake so Switchboard and dev servers answer from anywhere. With the lid closed, only while on power."
          style={hub.awake ? { borderColor: 'var(--hub-green)', color: 'var(--hub-ink)' } : undefined}>{hub.awake ? 'Awake' : 'Keep awake'}</button>}
        <button type="button" className="hub-btn" aria-label="Settings" aria-expanded={panel === 'gear' || panel === 'signins'} onClick={() => setPanel(panel === 'none' || panel === 'new' ? 'gear' : 'none')}>⚙</button>
      </header>
      {isVSCode && hub.devices?.map(d => (
        <div key={d.id} role="alert" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, padding: '8px 16px', borderBottom: '1px solid var(--hub-hair)', background: 'var(--hub-blue-soft)', color: 'var(--hub-ink)' }}>
          <span style={{ flex: 1, minWidth: 200 }}>A device wants to open Switchboard: {d.ua} at {d.ip} ({d.network})</span>
          <button type="button" className="hub-btn primary" onClick={() => send({ type: 'hub-device', id: d.id, allow: true })}>Allow</button>
          <button type="button" className="hub-btn" onClick={() => send({ type: 'hub-device', id: d.id, allow: false })}>Deny</button>
        </div>
      ))}
      {panel === 'new' && <div style={{ padding: 16, borderBottom: '1px solid var(--hub-hair)' }}><NewChat hub={hub} send={send} onDone={() => setPanel('none')} /></div>}
      {panel === 'gear' && <Gear hub={hub} send={send} onSignIns={() => setPanel('signins')} />}
      {panel === 'signins' && <SignIns hub={hub} send={send} problem={problem} onClose={() => setPanel('gear')} />}
      <main className="hub-app" style={{ flex: 1 }}>
        <aside className="hub-rail" aria-label="Chats" style={{ padding: 16, background: 'var(--hub-canvas)' }}>
          {(projectChips.length > 1 || projects.length > 0) && <ProjectFilter projects={projectChips} picked={projects} onChange={pickProjects} />}
          <DevRows dev={(hub.dev ?? []).filter(d => inProjects(d.folder, projects))} tailscale={hub.tailscale} isVSCode={isVSCode} send={send} />
          <ChatCards cards={rail} waits={hub.waits} selected={currentId} models={models} windows={hub.windows} here={hub.thisWindow} onSelect={(id, key) => setPick({ id, key })} onCopy={copy}
            empty={cards.length ? 'No chats in the picked projects.' : undefined} />
          <History archive={(hub.archive ?? []).filter(a => inProjects(a.cwd, projects))} chats={cards.map(c => c.chat)} search={hub.search} reveal={reveal}
            onSearch={q => send({ type: 'hub-search', q })}
            onNote={sessionId => send({ type: 'hub-open-note', sessionId })} onResume={(sessionId, ai) => send({ type: 'hub-resume', sessionId, ai })} />
        </aside>
        <div style={{ minWidth: 0 }}>
          <TodayCard today={today} tasks={tasks} />
          {current
            ? <>
                <ChatPicture chat={current.chat} progress={current.progress} live={hub.live.find(l => l.sessionId === current.chat.sessionId)} instant={pick.key} models={models}
                  profile={hub.tools?.chats[current.chat.sessionId]} flagged={hub.tools?.flagged} onProfile={tools => send({ type: 'hub-chat-tools', sessionId: current.chat.sessionId, tools })}
                  onFocus={() => send({ type: 'hub-focus-chat', sessionId: current.chat.sessionId })}
                  onAnswer={(askId, choice) => send({ type: 'hub-answer', sessionId: current.chat.sessionId, askId, choice })} onCopy={copy} />
                <MessageBox key={current.chat.sessionId} chat={current.chat} send={send} problem={problem} />
                <div style={{ padding: '0 20px 20px', display: 'grid', gap: 12 }}>
                  <ChangesPanel key={current.chat.sessionId} changes={hub.changes} sessionId={current.chat.sessionId} cwd={current.chat.cwd} commit={current.progress?.commit}
                    onCopy={copy} onOpen={file => send({ type: 'hub-open-diff', sessionId: current.chat.sessionId, file })} />
                  <GitPanel key={`git-${current.chat.sessionId}`} repo={hub.repo} sessionId={current.chat.sessionId} commit={current.progress?.commit} isVSCode={isVSCode} send={send} />
                </div>
              </>
            : <section style={{ padding: 20, color: 'var(--hub-ash)' }}>Pick a chat, or start one.</section>}
        </div>
      </main>
      {finding && <Switcher items={items} onPick={choose} onClose={() => setFinding(false)} />}
    </div>
  )
}
