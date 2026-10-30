'use client'

/**
 * Settings, in sections: a nav on the left (a wrapping row on a phone) and the picked section's rows.
 * Claude Code rows go through the extension's whitelist into ~/.claude/settings.json, so new chats pick them up.
 * Search runs across every section; installed lists sit in folds apart from the switches.
 */
import { useState, type ReactNode } from 'react'
import type { HubState, SettingKey, SwitchboardKey } from '@/lib/hub-types'
import { gearRows } from '@/lib/gear-rows'
import type { HubCommand } from '@/lib/vscode-bridge'
import { SignIns } from './sign-ins'
import { label } from './look'

export function Switch({ on, onChange, label, text }: { on: boolean; onChange: (next: boolean) => void; label: string; text?: string }) {
  return (
    <button type="button" role="switch" className="hub-switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <span aria-hidden />{text}
    </button>
  )
}

/** A native select in the hub's look; long option text truncates in the box. */
export function Pick({ options, value, onChange, label, muted }: { options: Array<[string, string]>; value: string; onChange: (v: string) => void; label: string; muted?: boolean }) {
  return (
    <select className="hub-select" aria-label={label} value={value} onChange={e => onChange(e.target.value)} style={muted ? { color: 'var(--hub-mute)' } : undefined}>
      {options.map(([v, text]) => <option key={v} value={v}>{text}</option>)}
    </select>
  )
}

const MODELS: Array<[string, string]> = [['default', 'Default'], ['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']]
const ROLE_MODELS: Array<[RoleModel, string]> = [['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']]
type RoleModel = Extract<HubCommand, { type: 'hub-role-model' }>['model']
const EFFORTS: Array<[string, string]> = [['default', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra high'], ['max', 'Max']]
const IDLE: Array<[string, string]> = [['5', 'After 5 min'], ['15', 'After 15 min'], ['30', 'After 30 min'], ['60', 'After 1 h'], ['never', 'Never']]

const SECTIONS = ['Chats', 'Models', 'Accounts', 'Integrations', 'Installed'] as const
export type Section = typeof SECTIONS[number]
export type Layout = 'classic' | 'desk'
const LAYOUTS: Array<[Layout, string]> = [['desk', 'Desk'], ['classic', 'Classic']]
type Row = { label: string; control: ReactNode; hint?: string; section: Section }

function Line({ row }: { row: Row }) {
  return (
    <div className="hub-set-row">
      <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
        <span style={{ color: 'var(--hub-ink)' }}>{row.label}</span>
        {row.hint && <span style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--hub-ash)' }}>{row.hint}</span>}
      </span>
      {row.control}
    </div>
  )
}

const sub = { ...label, lineHeight: 1, margin: '16px 0 4px' } as const

/** start: the section to open on. layout: this device's own pick, kept in its browser storage. */
export function Gear({ hub, send, start = 'Chats', layout, onLayout }: { hub: HubState; send: (c: HubCommand) => void; onSignIns?: () => void; start?: Section; layout?: Layout; onLayout?: (l: Layout) => void }) {
  const [q, setQ] = useState('')
  const [at, setAt] = useState<Section>(start)
  const c = hub.controls.claude
  const sb = hub.controls.switchboard
  const set = (key: SettingKey, value: boolean | string | null) => send({ type: 'hub-setting', key, value })
  const own = (key: SwitchboardKey, value: boolean | number | string | null) => send({ type: 'hub-switchboard', key, value })
  const query = q.trim().toLowerCase()
  const lead = c.model ?? 'default'

  const rows: Row[] = [
    ...(layout && onLayout ? [{ section: 'Chats' as const, label: 'Layout', hint: 'This device only. Desk puts chats on the left, the chat in the middle and Today, To-do and Git on the right.',
      control: <Pick label="Layout" options={LAYOUTS} value={layout} onChange={v => onLayout(v as Layout)} /> }] : []),
    { section: 'Chats', label: 'Your name', hint: 'Chats call you by this name. Leave it empty to skip it.',
      // Keyed by the saved name, so a save from another window shows here.
      control: <input key={sb.name} className="hub-select" aria-label="Your name" placeholder="Name" maxLength={40} defaultValue={sb.name} style={{ cursor: 'text' }}
        onBlur={e => { const v = e.target.value.trim(); if (v !== sb.name) own('name', v) }}
        onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} /> },
    { section: 'Chats', label: 'Hide idle chats', hint: 'A chat that stopped and stayed quiet this long leaves the list; Find still has it.',
      control: <Pick label="Hide idle chats" options={IDLE} value={sb.idleMinutes === null ? 'never' : String(sb.idleMinutes)} onChange={v => own('idleMinutes', v === 'never' ? null : Number(v))} /> },
    { section: 'Chats', label: 'Continue at usage limit', hint: 'When a usage limit resets, Claude picks the chat up again by itself.',
      control: <Switch label="Continue at usage limit" on={hub.keep.autoContinue} onChange={next => set('autoContinueAtUsageLimit', next)} /> },
    { section: 'Chats', label: 'Fresh branch for new chats', hint: 'A chat that continues from a full one starts on its own git branch.',
      control: <Switch label="Fresh branch for new chats" on={hub.keep.freshBranch} onChange={next => send({ type: 'hub-keep', freshBranch: next })} /> },
    { section: 'Chats', label: 'Brief for new chats', hint: 'New chats first read what other chats in the project are doing.',
      control: <Switch label="Brief for new chats" on={sb.brief} onChange={next => own('brief', next)} /> },
    { section: 'Chats', label: 'Push to your phone', hint: 'When a chat finishes.', control: <Switch label="Push to your phone" on={c.push} onChange={next => set('agentPushNotifEnabled', next)} /> },
    { section: 'Chats', label: 'Keep phone access in Apple Notes', hint: 'One private note, "Switchboard access", with the code and links; updated when they change. Off stops updates.',
      control: <Switch label="Keep phone access in Apple Notes" on={sb.accessNote} onChange={next => own('accessNote', next)} /> },
    { section: 'Chats', label: 'Notify when a chat needs input', control: <Switch label="Notify when a chat needs input" on={c.needInput} onChange={next => set('inputNeededNotifEnabled', next)} /> },

    { section: 'Models', label: 'Lead model', hint: 'The main chat, and every role set to Inherit.',
      control: <Pick label="Lead model" options={MODELS} value={lead} onChange={v => set('model', v === 'default' ? null : v)} /> },
    { section: 'Models', label: 'Lead effort', hint: 'The main chat, and every role set to Inherit.',
      control: <Pick label="Lead effort" options={EFFORTS} value={c.effortLevel ?? 'default'} onChange={v => set('effortLevel', v === 'default' ? null : v)} /> },
    ...hub.installed.filter(i => i.kind === 'role').map((r): Row => {
      const value = r.model && r.model !== 'inherit' ? r.model : 'inherit'
      const options: Array<[string, string]> = [['inherit', `Inherit (${lead})`], ...ROLE_MODELS]
      // A full model id in the file shows as its own option.
      if (!options.some(o => o[0] === value)) options.push([value, value])
      return { section: 'Models', label: r.name,
        control: <Pick label={`${r.name} model`} options={options} value={value} muted={value === 'inherit'} onChange={v => { if (v !== value) send({ type: 'hub-role-model', role: r.name, model: v as RoleModel }) }} /> }
    }),

    { section: 'Integrations', label: 'Hooks', hint: 'Claude Code reports each chat\'s progress to Switchboard. Off removes the hooks from ~/.claude/settings.json.',
      control: <Switch label="Hooks" on={sb.hooks} onChange={next => own('hooks', next)} /> },
    { section: 'Integrations', label: 'Status bar button', hint: 'The Switchboard button in VS Code\'s status bar.',
      control: <Switch label="Status bar button" on={sb.statusBar} onChange={next => own('statusBar', next)} /> },
    { section: 'Integrations', label: 'Status line', hint: hub.controls.statusLineReady ? undefined : 'Needs claude-mods/kit/statusline.mjs.',
      control: hub.controls.statusLineReady ? <Switch label="Status line" on={c.statusLine} onChange={next => set('statusLine', next)} /> : <span style={{ color: 'var(--hub-ash)', fontSize: 12 }}>Not set up</span> },
    { section: 'Integrations', label: 'Sync rules and roles', hint: `${hub.controls.rulesNote ?? 'Not synced yet'}. Writes ~/.claude/CLAUDE.md, ~/.codex/AGENTS.md and ~/.claude/agents; files you edited are kept.`,
      control: (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <button type="button" className="hub-link" onClick={() => send({ type: 'hub-rules-sync' })}>Sync now</button>
          <Switch label="Sync rules and roles" on={sb.syncRules} onChange={next => own('syncRules', next)} />
        </span>
      ) },
    { section: 'Integrations', label: 'Remote Control at startup', hint: 'Lets the Claude app reach new chats.', control: <Switch label="Remote Control at startup" on={hub.rc.atStartup} onChange={on => send({ type: 'hub-rc', on })} /> },
    ...hub.rcServers.map((r): Row => ({ section: 'Integrations', label: `Remote Control for all repos in ${r.name}`, hint: `Chats you start from the Claude app begin in ${r.folder.replace(/^\/Users\/[^/]+/, '~')} and can work in any repo under it.`,
      control: <Switch label={`Remote Control for all repos in ${r.name}`} on={r.on} onChange={on => send({ type: 'hub-rc-server', folder: r.folder, on })} /> })),
  ]

  const lists = gearRows(hub, query)
  const hits = query ? rows.filter(row => `${row.label} ${row.hint ?? ''} ${row.section}`.toLowerCase().includes(query)) : []
  const accountsHit = query && 'accounts sign-ins logins aws web apps chrome projects'.includes(query)
  const listHits = query ? lists.filter(l => l.match) : []

  const installed = (only = lists) => (
    <div style={{ display: 'grid' }}>
      {only.map(l => (
        // Remounts open while searching, so every hit shows.
        <details key={`${l.label}:${query ? 'q' : ''}`} open={query ? true : undefined} className="hub-fold-list">
          <summary>
            <b aria-hidden>›</b>
            <span style={{ flex: 1, minWidth: 0, color: 'var(--hub-ink)' }}>{l.label}</span>
            <span style={{ font: '400 12px/1 var(--hub-mono)', color: 'var(--hub-ash)' }}>{l.names.length}</span>
          </summary>
          {l.names.length
            ? <ul role="list" className="hub-names">{l.names.map((n, i) => <li key={n} title={l.tips[i] ? `${n}: ${l.tips[i]}` : n}>{n}</li>)}</ul>
            : <p style={{ margin: '0 0 10px 22px', fontSize: 12, color: 'var(--hub-ash)' }}>None</p>}
        </details>
      ))}
    </div>
  )

  const body = (s: Section) => {
    if (s === 'Accounts') return <SignIns hub={hub} send={send} />
    if (s === 'Installed') return (
      <>
        <Line row={{ section: 'Installed', label: 'Set up', hint: 'Installs the plugins, mods, MCP servers, rules and roles Switchboard works with. Skips what you have.',
          control: <button type="button" className="hub-btn" onClick={() => send({ type: 'hub-setup' })}>Set up</button> }} />
        <Line row={{ section: 'Installed', label: 'Export kit', hint: 'Roles, skills, plugins and mods as one folder you can copy to another Mac.',
          control: <button type="button" className="hub-btn" onClick={() => send({ type: 'hub-kit-export' })}>Export</button> }} />
        <h4 style={sub}>Installed</h4>
        {installed()}
      </>
    )
    const mine = rows.filter(r => r.section === s)
    if (s !== 'Models') return mine.map(r => <Line key={r.label} row={r} />)
    return (
      <>
        {mine.slice(0, 2).map(r => <Line key={r.label} row={r} />)}
        {mine.length > 2 && <h4 style={sub}>Roles</h4>}
        {mine.slice(2).map(r => <Line key={r.label} row={r} />)}
      </>
    )
  }

  return (
    <section aria-label="Settings" className="hub-settings">
      <nav aria-label="Settings sections" className="hub-set-nav">
        <input type="search" className="hub-search" aria-label="Find a setting" placeholder="Find a setting" value={q} onChange={e => setQ(e.target.value)} />
        <div role="tablist" aria-orientation="vertical">
          {SECTIONS.map(s => (
            <button key={s} type="button" role="tab" aria-selected={!query && at === s} onClick={() => { setAt(s); setQ('') }}>{s}</button>
          ))}
        </div>
      </nav>
      <div role="tabpanel" aria-label={query ? 'Search results' : at} style={{ minWidth: 0 }}>
        {query
          ? <>
              {hits.map(r => <Line key={r.label} row={{ ...r, hint: [r.section, r.hint].filter(Boolean).join('. ') }} />)}
              {accountsHit && <Line row={{ section: 'Accounts', label: 'Accounts', hint: 'AWS profiles, web app logins, and which ones each project uses.',
                control: <button type="button" className="hub-btn" onClick={() => { setAt('Accounts'); setQ('') }}>Open</button> }} />}
              {listHits.length > 0 && <><h4 style={sub}>Installed</h4>{installed(listHits)}</>}
              {!hits.length && !accountsHit && !listHits.length && <p style={{ color: 'var(--hub-ash)', margin: '8px 0' }}>Nothing matches.</p>}
            </>
          : body(at)}
      </div>
    </section>
  )
}
