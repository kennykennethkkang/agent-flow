'use client'
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useHub } from '@/hooks/use-hub'
import { chatProjects, hideIdle, inProjects, liveChats } from '@/lib/archive'
import { switcherItems, type SwitchItem } from '@/lib/switcher'
import { todayView } from '@/lib/today'
import { byNeed, taskTotals } from '@/lib/progress'
import { roleModels } from '@/lib/gear-rows'
import { boxNote } from '@/lib/message-box'
import { ChatCards, History, ProjectFilter, type Card } from './chat-cards'
import { ChatPicture } from './chat-picture'
import { MessageBox } from './message-box'
import { ChangesPanel } from './changes'
import { GitPanel } from './git-panel'
import { TodoPanel, todoFolder } from './todo-panel'
import { Switcher } from './switcher'
import { TodayCard } from './today'
import { NewChat } from './new-chat'
import { Gear, type Layout, type Section } from './gear'
import { SignIns } from './sign-ins'
import { PhoneAddress, PhoneQr } from './phone-qr'
import { DevRows } from './dev-rows'
import { ChatMenu } from './chat-menu'
import { Sheet } from './sheet'
import { placeOf, repoOf } from './look'

const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); return true } catch { return false } }
const PROJECTS_KEY = 'switchboard.projects'
const LAYOUT_KEY = 'switchboard.layout'
const LIMIT: Record<string, string> = { five_hour: '5h', seven_day: '7d' }
const isMac = () => typeof navigator !== 'undefined' && /Mac|iP/.test(navigator.platform)
const NARROW = '(max-width: 760px)'
type Tab = 'chats' | 'chat' | 'todo' | 'git'

const Ic = ({ d }: { d: string }) => <svg className="hub-ic" aria-hidden width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d={d} /></svg>
const ICON = {
  find: 'M7 12.5a5.5 5.5 0 1 0 0-11 5.5 5.5 0 0 0 0 11ZM11 11l3.5 3.5',
  plus: 'M8 3v10M3 8h10',
  out: 'M9 2.5h4.5V7M13.5 2.5 7 9M12 9.5v3a1 1 0 0 1-1 1H3.5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h3',
  phone: 'M5 1.5h6a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1ZM7 12.2h2',
  awake: 'M8 1.8v5.4M4.4 4a5.2 5.2 0 1 0 7.2 0',
  gear: 'M8 10.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4ZM13 8l1.4-1-1.2-2.1-1.6.6-1.3-.8L10 3H6l-.3 1.7-1.3.8-1.6-.6L1.6 7 3 8 1.6 9l1.2 2.1 1.6-.6 1.3.8L6 13h4l.3-1.7 1.3-.8 1.6.6L14.4 9 13 8Z',
  chats: 'M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2v-7Z',
  chat: 'M8 8m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0M8 8m-6 0a6 6 0 1 0 12 0a6 6 0 1 0 -12 0',
  todo: 'M3 4h1.5M3 8h1.5M3 12h1.5M7 4h6M7 8h6M7 12h6',
  git: 'M5 2.5v7M5 9.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4ZM11 6.5a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM11 6.5c0 3-6 2-6 4',
}

/** The URL's ?layout= wins, then this device's pick, else Desk. */
function useLayout(): [Layout, (l: Layout) => void] {
  const [layout, setLayout] = useState<Layout>('desk')
  useEffect(() => {
    const q = new URLSearchParams(location.search).get('layout')
    if (q === 'desk' || q === 'classic') { setLayout(q); return }
    try { if (localStorage.getItem(LAYOUT_KEY) === 'classic') setLayout('classic') } catch { /* no storage: Desk */ }
  }, [])
  const pick = (l: Layout) => {
    setLayout(l)
    try { localStorage.setItem(LAYOUT_KEY, l) } catch { /* no storage */ }
    // A pick in Settings beats the link it was opened with.
    const u = new URL(location.href)
    if (u.searchParams.has('layout')) { u.searchParams.delete('layout'); history.replaceState(null, '', u) }
  }
  return [layout, pick]
}

function useNarrow() {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const m = matchMedia(NARROW)
    const on = () => setNarrow(m.matches)
    on(); m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [])
  return narrow
}

export function Switchboard() {
  const { hub, send, isDemo, isVSCode, isLive, problem, down } = useHub()
  const sendRef = useRef(send)
  sendRef.current = send
  const [layout, setLayout] = useLayout()
  const desk = layout === 'desk'
  const narrow = useNarrow()
  const [tab, setTab] = useState<Tab>('chat')
  const [pick, setPick] = useState<{ id?: string; key: boolean }>({ key: false })
  const [panel, setPanel] = useState<'none' | 'new' | 'gear' | 'signins'>('none')
  const [gearAt, setGearAt] = useState<{ at: Section; n: number }>({ at: 'Chats', n: 0 })
  const [finding, setFinding] = useState(false)
  const [phone, setPhone] = useState(false)
  const [reveal, setReveal] = useState<{ chain: string; at: number }>()
  // The project filter is this device's own, like the tool-calls toggle.
  const [projects, setProjects] = useState<string[]>([])
  useEffect(() => { try { const v = JSON.parse(localStorage.getItem(PROJECTS_KEY) ?? '[]'); if (Array.isArray(v)) setProjects(v.filter(p => typeof p === 'string')) } catch { /* no storage: show all */ } }, [])
  const pickProjects = (next: string[]) => { setProjects(next); try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(next)) } catch { /* no storage */ } }
  const cards: Card[] = useMemo(() => byNeed(liveChats(hub.chats, hub.archive ?? [])
    .map(chat => ({ chat, progress: hub.progress.find(p => p.sessionId === chat.sessionId) }))), [hub])
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
  // On a phone the chat page sits below the whole rail (Classic) or behind the Chat tab (Desk), so a tap brings it up.
  const select = (id: string, key: boolean) => {
    setPick({ id, key })
    if (!matchMedia(NARROW).matches) return
    const smooth = !matchMedia('(prefers-reduced-motion: reduce)').matches
    if (desk) { setTab('chat'); window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' }); return }
    requestAnimationFrame(() => document.getElementById('pic-name')?.closest('section')?.scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' }))
  }
  const choose = (item: SwitchItem) => {
    setFinding(false)
    // A Find pick outside the filter clears it, so the chat shows. A History chain key starts with its folder.
    if (item.kind === 'live') { select(item.id, true); if (!shown.some(c => c.chat.sessionId === item.id)) pickProjects([]) }
    else { setReveal({ chain: item.chain, at: Date.now() }); if (desk) setTab('chats'); if (!inProjects(item.chain.split('\n')[0], projects)) pickProjects([]) }
  }
  const openGear = (at: Section = 'Chats') => { setGearAt(g => ({ at, n: g.n + 1 })); setPanel('gear') }
  // The To-do lists follow the shown chat's project, else this window's.
  const todoAt = todoFolder(Object.keys(hub.todos ?? {}), current?.chat.cwd, hub.thisWindow)
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
  const windows = hub.windows ?? []
  const starred = useMemo(() => hub.starred.map(s => s.sessionId), [hub.starred])
  // A project's window: the window holding any chat of that project.
  const projectTint = (name: string) => placeOf(cards.find(c => repoOf(c.chat.cwd) === name)?.chat.cwd, windows)?.color
  const itemTint = (item: SwitchItem) => placeOf(item.kind === 'live' ? cards.find(c => c.chat.sessionId === item.id)?.chat.cwd : item.chain.split('\n')[0], windows)?.color
  const menu = (chat: Card['chat']) => <ChatMenu chat={chat} starred={starred.includes(chat.sessionId)} send={send} onMac={isVSCode} />
  const needs = cards.filter(c => c.progress?.state === 'needs-you').length
  const todoCount = (todoAt && hub.todos?.[todoAt]?.todo.length) || 0
  const files = hub.changes?.sessionId === currentId ? hub.changes?.files.length ?? 0 : 0

  const header = (
    <header className="hub-top">
      <strong className="hub-brand"><i aria-hidden />Switchboard</strong>
      <button type="button" className="hub-btn primary hub-new" aria-expanded={panel === 'new'} onClick={() => setPanel(panel === 'new' ? 'none' : 'new')}><Ic d={ICON.plus} />New chat</button>
      <button type="button" className="hub-btn hub-find" aria-haspopup="dialog" aria-label="Find a chat" onClick={() => setFinding(true)} title="Find a chat, live or in History">
        <Ic d={ICON.find} /><span className="hub-lbl">Find</span> <kbd>{isMac() ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
      {isDemo && <span className="hub-note">Sample data: no VS Code window is connected</span>}
      {down && !isDemo && <span role="status" className="hub-note" style={{ color: 'var(--hub-yellow)' }}>Not live, retrying: {down}</span>}
      <span className="hub-limit" title={limit?.resetsAt ? `Resets ${limit.resetsAt}` : undefined}>
        {limit && <i aria-hidden><b style={{ width: `${Math.min(100, Math.round(limit.percentUsed))}%` }} /></i>}
        {limit ? `${LIMIT[limit.kind] ?? limit.kind.replace('_', ' ')} limit · ${Math.round(limit.percentUsed)}% used` : ''}
      </span>
      {isVSCode && <>
        <button type="button" className="hub-btn" aria-label="Open in browser" onClick={() => send({ type: 'hub-web', phone: false })} title={web ? `Open ${web} in your browser` : 'Start the browser app, then open it'}><Ic d={ICON.out} /><span className="hub-lbl">Open in browser ↗</span></button>
        <span style={{ position: 'relative' }}>
          {/* Asking for the link also starts the app when it is not running. */}
          <button type="button" className="hub-btn" aria-label="Phone" aria-haspopup="dialog" aria-expanded={phone} onClick={() => { if (!phone) send({ type: 'hub-web', phone: true }); setPhone(!phone) }}><Ic d={ICON.phone} /><span className="hub-lbl">Phone</span></button>
          {phone && (
            <div role="dialog" aria-label="Open Switchboard on your phone" className="hub-pop" onKeyDown={e => { if (e.key === 'Escape') setPhone(false) }}>
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
      {hub.awake !== undefined && <button type="button" className="hub-btn hub-awake" aria-label="Keep awake" aria-pressed={hub.awake} onClick={() => send({ type: 'hub-awake', on: !hub.awake })}
        title="Keeps this Mac awake so Switchboard and dev servers answer from anywhere. With the lid closed, only while on power.">
        <Ic d={ICON.awake} /><span className="hub-lbl">{hub.awake ? 'Awake' : 'Keep awake'}</span></button>}
      <button type="button" className="hub-btn hub-gear" aria-label="Settings" title="Settings" aria-expanded={panel === 'gear' || panel === 'signins'} onClick={() => (panel === 'none' || panel === 'new' ? openGear() : setPanel('none'))}>
        <Ic d={ICON.gear} /><span className="hub-classic-only" aria-hidden>⚙</span>
      </button>
    </header>
  )
  const devices = isVSCode && hub.devices?.map(d => (
    <div key={d.id} role="alert" className="hub-device">
      <span style={{ flex: 1, minWidth: 200 }}>A device wants to open Switchboard: {d.ua} at {d.ip} ({d.network})</span>
      <button type="button" className="hub-btn primary" onClick={() => send({ type: 'hub-device', id: d.id, allow: true })}>Allow</button>
      <button type="button" className="hub-btn" onClick={() => send({ type: 'hub-device', id: d.id, allow: false })}>Deny</button>
    </div>
  ))
  const newChat = <NewChat hub={hub} send={send} onDone={() => setPanel('none')} />
  const gear = <Gear key={gearAt.n} hub={hub} send={send} start={gearAt.at} layout={layout} onLayout={setLayout} onSignIns={() => setPanel('signins')} />
  const signIns = <SignIns hub={hub} send={send} problem={problem} onClose={() => openGear('Accounts')} />
  const filter = (projectChips.length > 1 || projects.length > 0) && <ProjectFilter projects={projectChips} picked={projects} tint={projectTint} onChange={pickProjects} />
  const dev = <DevRows dev={(hub.dev ?? []).filter(d => inProjects(d.folder, projects))} tailscale={hub.tailscale} isVSCode={isVSCode} send={send} />
  const chatCards = <ChatCards cards={rail} waits={hub.waits} selected={currentId} windows={windows} here={hub.thisWindow} onSelect={select} starred={starred} menu={menu}
    empty={cards.length ? 'No chats in the picked projects.' : undefined} />
  const history = <History archive={(hub.archive ?? []).filter(a => inProjects(a.cwd, projects))} chats={cards.map(c => c.chat)} search={hub.search} reveal={reveal}
    onSearch={q => send({ type: 'hub-search', q })}
    onNote={sessionId => send({ type: 'hub-open-note', sessionId })} onResume={(sessionId, ai) => send({ type: 'hub-resume', sessionId, ai })} />
  const todayCard = <TodayCard today={today} tasks={tasks} />
  const todo = todoAt && hub.todos?.[todoAt] && <TodoPanel key={todoAt} folder={todoAt} todos={hub.todos} chats={hub.chats} progress={hub.progress} windows={windows} send={send} />
  const place = placeOf(current?.chat.cwd, windows)
  const picture = current
    ? <ChatPicture chat={current.chat} progress={current.progress} live={hub.live.find(l => l.sessionId === current.chat.sessionId)} instant={pick.key} models={models}
        profile={hub.tools?.chats[current.chat.sessionId]} flagged={hub.tools?.flagged} onProfile={tools => send({ type: 'hub-chat-tools', sessionId: current.chat.sessionId, tools })}
        place={place} menu={<ChatMenu chat={current.chat} starred={starred.includes(current.chat.sessionId)} send={send} onMac={isVSCode} />}
        installed={hub.installed} connections={hub.connections} toolsOpen={desk} onInstalled={() => openGear('Installed')}
        onFocus={() => send({ type: 'hub-focus-chat', sessionId: current.chat.sessionId })}
        onAnswer={(askId, choice) => send({ type: 'hub-answer', sessionId: current.chat.sessionId, askId, choice })} onCopy={copy}
        limits={hub.live.flatMap(l => l.limits)} autoContinue={hub.keep.autoContinue}
        onSend={text => send(boxNote(current.chat) ? { type: 'hub-new-chat', path: current.chat.cwd, text, remote: false } : { type: 'hub-send', sessionId: current.chat.sessionId, text })} />
    : <section style={{ padding: 20, color: 'var(--hub-ash)' }}>Pick a chat, or start one.</section>
  const message = current && <MessageBox key={current.chat.sessionId} chat={current.chat} send={send} problem={problem} />
  const changes = current && <ChangesPanel key={current.chat.sessionId} changes={hub.changes} sessionId={current.chat.sessionId} cwd={current.chat.cwd} commit={current.progress?.commit}
    onCopy={copy} onOpen={file => send({ type: 'hub-open-diff', sessionId: current.chat.sessionId, file })} />
  const git = current && <GitPanel key={`git-${current.chat.sessionId}`} repo={hub.repo} sessionId={current.chat.sessionId} chat={current.chat} commit={current.progress?.commit} isVSCode={isVSCode} send={send} />
  const switcher = finding && <Switcher items={items} tint={itemTint} onPick={choose} onClose={() => setFinding(false)} />

  if (!desk) return (
    <div className="hub" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', background: 'var(--hub-surface)', color: 'var(--hub-body)', font: '400 14px/1.6 var(--hub-sans)' }}>
      {header}
      {devices}
      {panel === 'new' && <div style={{ padding: 16, borderBottom: '1px solid var(--hub-hair)' }}>{newChat}</div>}
      {panel === 'gear' && gear}
      {panel === 'signins' && signIns}
      <main className="hub-app" style={{ flex: 1 }}>
        <aside className="hub-rail" aria-label="Chats" style={{ padding: 16, background: 'var(--hub-canvas)' }}>
          {filter}{dev}{chatCards}{history}
        </aside>
        <div style={{ minWidth: 0 }}>
          <div style={{ padding: '20px 20px 0' }}>{todayCard}</div>
          {todo && <div style={{ padding: '12px 20px 0' }}>{todo}</div>}
          {picture}
          {message}
          {current && <div style={{ padding: '0 20px 20px', display: 'grid', gap: 12 }}>{changes}{git}</div>}
        </div>
      </main>
      {switcher}
    </div>
  )

  // Desk: chats on the left, the chat in the middle, Today, To-do, Changes and Git on the right. A phone shows one at a time, picked by the tab bar.
  const tabs: Array<[Tab, string, string, number]> = [['chats', 'Chats', ICON.chats, needs], ['chat', 'Chat', ICON.chat, 0], ['todo', 'To-do', ICON.todo, todoCount], ['git', 'Git', ICON.git, files]]
  const sec = (title: string, meta?: ReactNode) => <div className="desk-sec-h"><h2>{title}</h2>{meta !== undefined && <span>{meta}</span>}</div>
  return (
    <div className="hub desk" data-layout="desk" data-tab={tab}>
      {header}
      {devices}
      <aside className="desk-rail" aria-label="Chats">
        {narrow && todayCard}
        {filter}
        {sec('Chats', `${rail.length}${rail.length < cards.length ? ` of ${cards.length}` : ''}`)}
        {chatCards}
        {dev}
        {history}
      </aside>
      <main className="desk-center" aria-label="This chat">
        {picture}
        {message}
      </main>
      <aside className="desk-right" aria-label="Today and this project">
        {!narrow && <div className="desk-today">{todayCard}</div>}
        <div className="desk-todo">{todo || <section className="desk-empty">No to-do list for this project yet.</section>}</div>
        <div className="desk-git">{changes}{git}</div>
      </aside>
      <nav className="desk-tabs" aria-label="Sections">
        {tabs.map(([t, name, d, n]) => (
          <button key={t} type="button" aria-current={tab === t ? 'page' : undefined} onClick={() => { setTab(t); window.scrollTo({ top: 0 }) }}>
            <Ic d={d} />{name}{n > 0 && <span className="desk-badge" data-alert={t === 'chats' || undefined}>{n}<span className="sr-only"> {t === 'chats' ? 'need you' : t === 'todo' ? 'items' : 'files changed'}</span></span>}
          </button>
        ))}
      </nav>
      {panel === 'new' && <Sheet title="New chat" onClose={() => setPanel('none')}>{newChat}</Sheet>}
      {panel === 'gear' && <Sheet title="Settings" wide onClose={() => setPanel('none')}>{gear}</Sheet>}
      {panel === 'signins' && <Sheet title="Accounts" wide onClose={() => setPanel('none')}>{signIns}</Sheet>}
      {switcher}
    </div>
  )
}
