'use client'

/**
 * Settings in one searchable list. Claude Code rows go through the extension's
 * whitelist into ~/.claude/settings.json, so new chats pick them up.
 * Switch and Seg came over from the old Hub's ui.tsx; the rows from its Controls cards.
 */
import { useState, type ReactNode } from 'react'
import type { HubState, SettingKey, SwitchboardKey } from '@/lib/hub-types'
import { gearRows } from '@/lib/gear-rows'
import type { HubCommand } from '@/lib/vscode-bridge'

export function Switch({ on, onChange, label, text }: { on: boolean; onChange: (next: boolean) => void; label: string; text?: string }) {
  return (
    <button type="button" role="switch" className="hub-switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <span aria-hidden />{text}
    </button>
  )
}

function Seg<T extends string>({ options, value, onChange, label }: { options: Array<[T, string]>; value: T; onChange: (v: T) => void; label: string }) {
  return (
    <span role="radiogroup" aria-label={label} className="hub-seg" style={{ display: 'inline-flex', border: '1px solid var(--hub-hair)', borderRadius: 8, overflow: 'hidden', flexWrap: 'wrap', background: 'var(--hub-canvas)' }}>
      {options.map(([v, text]) => (
        <button key={v} type="button" role="radio" aria-checked={v === value} tabIndex={v === value ? 0 : -1} onClick={() => onChange(v)} onKeyDown={e => {
          // Arrow keys move and select, like native radios; only the checked option is in the tab order.
          const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
          if (!step) return
          e.preventDefault()
          const j = (options.findIndex(o => o[0] === v) + step + options.length) % options.length
          onChange(options[j][0]); (e.currentTarget.parentElement?.children[j] as HTMLElement | undefined)?.focus()
        }}
          style={{ border: 0, padding: '6px 10px', cursor: 'pointer', font: '500 12px/1 var(--hub-sans)', background: v === value ? 'var(--hub-card)' : 'transparent', color: v === value ? 'var(--hub-ink)' : 'var(--hub-mute)', boxShadow: v === value ? 'inset 0 0 0 1px var(--hub-hair-strong)' : 'none', borderRadius: 7 }}>
          {text}
        </button>
      ))}
    </span>
  )
}

const MODELS: Array<[string, string]> = [['default', 'Default'], ['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']]
const ROLE_MODELS: Array<[RoleModel, string]> = [['fable', 'Fable'], ['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku']]
type RoleModel = Extract<HubCommand, { type: 'hub-role-model' }>['model']
const EFFORTS: Array<[string, string]> = [['default', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'Extra'], ['max', 'Max']]

const IDLE: Array<[string, string]> = [['5', '5 min'], ['15', '15 min'], ['30', '30 min'], ['60', '1 h'], ['never', 'Never']]

// match: the row did its own search (the installed lists).
type Row = { label: string; control: ReactNode; hint?: string; group: string; match?: boolean }
const GROUPS = ['Chats', 'Switchboard', 'Claude Code', 'Role models', 'More']

export function Gear({ hub, send, onSignIns }: { hub: HubState; send: (c: HubCommand) => void; onSignIns: () => void }) {
  const [q, setQ] = useState('')
  const c = hub.controls.claude
  const set = (key: SettingKey, value: boolean | string | null) => send({ type: 'hub-setting', key, value })
  const onOff = (key: SettingKey, on: boolean, label: string) => <Switch label={label} on={on} onChange={next => set(key, next)} />
  const query = q.trim().toLowerCase()
  const sb = hub.controls.switchboard
  const own = (key: SwitchboardKey, value: boolean | number | null) => send({ type: 'hub-switchboard', key, value })
  const signedIn = hub.aws.filter(a => a.status === 'signed-in').length
  const saved = (hub.signIns?.apps ?? []).reduce((n, a) => n + a.logins.length, 0)
  const rows: Row[] = [
    { group: 'Chats', label: 'Hide idle chats', hint: 'A chat that stopped and stayed quiet this long leaves the list; Find still has it.',
      control: <Seg label="Hide idle chats after" options={IDLE} value={sb.idleMinutes === null ? 'never' : String(sb.idleMinutes)} onChange={v => own('idleMinutes', v === 'never' ? null : Number(v))} /> },
    { group: 'Chats', label: 'Continue at usage limit', hint: 'When a usage limit resets, Claude picks the chat up again by itself.',
      control: <Switch label="Continue at usage limit" on={hub.keep.autoContinue} onChange={next => set('autoContinueAtUsageLimit', next)} /> },
    { group: 'Chats', label: 'Fresh branch for new chats', hint: 'A chat that continues from a full one starts on its own git branch.',
      control: <Switch label="Fresh branch for new chats" on={hub.keep.freshBranch} onChange={next => send({ type: 'hub-keep', freshBranch: next })} /> },
    { group: 'Chats', label: 'Brief for new chats', hint: 'New chats first read what other chats in the project are doing.',
      control: <Switch label="Brief for new chats" on={sb.brief} onChange={next => own('brief', next)} /> },
    { group: 'Switchboard', label: 'Hooks', hint: 'Claude Code reports each chat\'s progress to Switchboard. Off removes the hooks from ~/.claude/settings.json.',
      control: <Switch label="Hooks" on={sb.hooks} onChange={next => own('hooks', next)} /> },
    { group: 'Switchboard', label: 'Status bar button', hint: 'The Switchboard button in VS Code\'s status bar.',
      control: <Switch label="Status bar button" on={sb.statusBar} onChange={next => own('statusBar', next)} /> },
    { group: 'Switchboard', label: 'Sync rules and roles', hint: `${hub.controls.rulesNote ?? 'Rules and roles: not synced yet'}. Writes the working rules to ~/.claude/CLAUDE.md and ~/.codex/AGENTS.md and the role agents to ~/.claude/agents; files you edited are kept.`,
      control: <Switch label="Sync rules and roles" on={sb.syncRules} onChange={next => own('syncRules', next)} /> },
    { group: 'Switchboard', label: 'Re-sync rules and roles',
      control: <button type="button" className="hub-btn" onClick={() => send({ type: 'hub-rules-sync' })}>Re-sync now</button> },
    { group: 'Switchboard', label: 'Sign-ins', hint: `AWS: ${hub.aws.length} profile${hub.aws.length === 1 ? '' : 's'}, ${signedIn} signed in. Web apps: ${saved} saved login${saved === 1 ? '' : 's'}, each opened in its own Chrome profile.`,
      control: <button type="button" className="hub-btn" onClick={onSignIns}>Open sign-ins</button> },
    { group: 'Claude Code', label: 'Lead model (main chat)', hint: 'Applies to the main chat, and to roles set to Inherit lead.',
      control: <Seg label="Lead model" options={MODELS} value={c.model ?? 'default'} onChange={v => set('model', v === 'default' ? null : v)} /> },
    { group: 'Claude Code', label: 'Lead effort', hint: 'Applies to the main chat, and to roles set to Inherit lead.',
      control: <Seg label="Lead effort" options={EFFORTS} value={c.effortLevel ?? 'default'} onChange={v => set('effortLevel', v === 'default' ? null : v)} /> },
    ...hub.installed.filter(i => i.kind === 'role').map(r => {
      const value = r.model ?? 'inherit'
      const options: Array<[string, string]> = [['inherit', `Inherit lead (${c.model ?? 'default'})`], ...ROLE_MODELS]
      // A full model id in the file shows as its own option, so the row still has a checked one.
      if (!options.some(o => o[0] === value)) options.push([value, value])
      return { group: 'Role models', label: r.name, hint: `model: in ~/.claude/agents/${r.name}.md`,
        control: <Seg label={`${r.name} model`} options={options} value={value} onChange={v => { if (v !== value) send({ type: 'hub-role-model', role: r.name, model: v as RoleModel }) }} /> }
    }),
    { group: 'Claude Code', label: 'Remote Control at startup', control: <Switch label="Remote Control at startup" on={hub.rc.atStartup} onChange={on => send({ type: 'hub-rc', on })} /> },
    { group: 'Claude Code', label: 'Push notifications to your phone', control: onOff('agentPushNotifEnabled', c.push, 'Push notifications') },
    { group: 'Claude Code', label: 'Notify when a chat needs input', control: onOff('inputNeededNotifEnabled', c.needInput, 'Input needed notifications') },
    { group: 'Claude Code', label: 'Status line', control: hub.controls.statusLineReady ? onOff('statusLine', c.statusLine, 'Status line') : <span style={{ color: 'var(--hub-ash)' }}>needs claude-mods/kit/statusline.mjs</span> },
    ...hub.rcServers.map(r => ({ group: 'Claude Code', label: `Remote Control for all repos (${r.name})`, hint: `Chats you start from the Claude app begin in ${r.folder.replace(/^\/Users\/[^/]+/, '~')} and can work in any repo under it.`,
      control: <Switch label={`Remote Control for all repos (${r.name})`} on={r.on} onChange={on => send({ type: 'hub-rc-server', folder: r.folder, on })} /> })),
    { group: 'More', label: 'Export kit', control: <button type="button" className="hub-btn" onClick={() => send({ type: 'hub-kit-export' })}>Export now</button> },
    ...gearRows(hub, query).map(r => ({ group: 'More', label: r.label, hint: r.hint, match: r.match,
      control: <span style={{ color: 'var(--hub-mute)', fontSize: 12, lineHeight: 1.5, flex: '1 1 100%', minWidth: 0, overflowWrap: 'anywhere' }}>{r.names.join(', ') || 'none'}</span> })),
  ]
  const shown = rows.filter(row => row.match ?? `${row.label} ${row.hint ?? ''}`.toLowerCase().includes(query))
  return (
    <section aria-label="Settings" style={{ padding: 16, borderBottom: '1px solid var(--hub-hair)', background: 'var(--hub-surface)' }}>
      <input type="search" aria-label="Find a setting" placeholder="Find a setting" value={q} onChange={e => setQ(e.target.value)}
        style={{ font: 'inherit', padding: '8px 12px', borderRadius: 8, width: '100%', maxWidth: 360, boxSizing: 'border-box', marginBottom: 8, background: 'var(--hub-canvas)', color: 'var(--hub-ink)', border: '1px solid var(--hub-hair)' }} />
      {GROUPS.map(g => {
        const list = shown.filter(row => row.group === g)
        if (!list.length) return null
        return (
          <div key={g} role="group" aria-label={g} style={{ marginTop: 12 }}>
            <h3 style={{ font: '600 13px/1.4 var(--hub-sans)', color: 'var(--hub-ink)', margin: '0 0 2px' }}>{g}</h3>
            {list.map(row => (
              <div key={row.label} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '8px 0', borderTop: '1px solid var(--hub-hair)', color: 'var(--hub-body)', flexWrap: 'wrap' }}>
                <span style={{ display: 'grid', gap: 2, minWidth: 0, flex: '1 1 220px' }}>
                  <span>{row.label}</span>
                  {row.hint && <span style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--hub-ash)' }}>{row.hint}</span>}
                </span>
                {row.control}
              </div>
            ))}
          </div>
        )
      })}
      {!shown.length && <p style={{ color: 'var(--hub-ash)' }}>Nothing matches.</p>}
    </section>
  )
}
