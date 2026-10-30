'use client'
import type { ChatProfile, Connection, Installed } from '@/lib/hub-types'
import { caps, panel } from './look'
import { ToolChips, chip } from './tool-chips'
import { plural } from './chat-cards'

const short = (n: string) => n.split('@')[0]
const hint = { margin: 0, color: 'var(--hub-ash)', fontSize: 13, lineHeight: 1.5 } as const
const DOT = { on: 'var(--hub-green)', off: 'var(--hub-ash)', error: 'var(--hub-red)' } as const
const KIND = { plugin: 'Plugin', skill: 'Skill', asset: 'Design reference' } as const

/**
 * The chat's plugins, skills and design references, what each does, and the MCP servers and apps it can reach.
 * With a saved profile the chips toggle it; without one the chat runs on the defaults, listed read only.
 * onInstalled opens Settings at Installed.
 */
export function ToolsCard({ profile, flagged = [], installed = [], connections = [], open, onProfile, onInstalled }: {
  profile?: ChatProfile; flagged?: string[]; installed?: Installed[]; connections?: Connection[]; open?: boolean
  onProfile?: (p: ChatProfile) => void; onInstalled?: () => void
}) {
  const tips = Object.fromEntries(installed.flatMap(i => i.description ? [[i.name, i.description], ...(i.path ? [[i.path, i.description]] : [])] : []))
  const on = profile
    ? (['plugins', 'skills', 'assets'] as const).flatMap(k => Object.entries(profile[k] ?? {}).filter(([, v]) => v).map(([n]) => ({ kind: k === 'plugins' ? 'plugin' : k === 'skills' ? 'skill' : 'asset', name: n })))
    : installed.filter(i => i.enabled && (i.kind === 'plugin' || i.kind === 'skill')).map(i => ({ kind: i.kind, name: i.name }))
  const count = (k: string) => on.filter(o => o.kind === k).length
  const said = [plural(count('plugin'), 'plugin'), plural(count('skill'), 'skill'), count('asset') ? plural(count('asset'), 'design reference') : ''].filter(Boolean).join(', ')
  const links = connections.filter(c => c.kind === 'mcp' || c.kind === 'app')
  const described = on.filter(o => tips[o.name])
  return (
    <details className="hub-fold-list hub-tools" open={open} style={{ ...panel, display: 'block' }}>
      <summary style={{ ...caps, alignItems: 'center', padding: 0, borderTop: 0 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><b aria-hidden>›</b>Tools</span>
        <span>{profile ? `${said} on` : `Your defaults: ${said}`}</span>
      </summary>
      <div style={{ display: 'grid', gap: 12, marginTop: 12 }}>
        {profile && onProfile
          ? <>
              <p style={hint}>Changes save now and apply when this chat is resumed or restarted. Hover a chip for what it does.</p>
              <ToolChips profile={profile} flagged={flagged} tips={tips} onChange={onProfile} />
            </>
          : <>
              <p style={hint}>This chat runs with your default plugins and skills.</p>
              {on.length > 0 && <ul role="list" aria-label="Default plugins and skills" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {on.map(o => <li key={o.name} title={[o.name, tips[o.name]].filter(Boolean).join('\n')} style={{ ...chip(true), cursor: 'default' }}>{short(o.name)}</li>)}
              </ul>}
            </>}
        {described.length > 0 && (
          <details className="hub-fold-list hub-tools-what">
            <summary style={{ ...caps, alignItems: 'center', padding: '8px 0 0', textTransform: 'none' }}><span style={{ display: 'flex', alignItems: 'center', gap: 6 }}><b aria-hidden>›</b>What each one does</span><span>{described.length}</span></summary>
            <dl style={{ margin: '8px 0 0', display: 'grid', gridTemplateColumns: 'minmax(0, max-content) minmax(0, 1fr)', gap: '6px 14px', fontSize: 13 }}>
              {described.map(o => <div key={o.name} style={{ display: 'contents' }}>
                <dt style={{ color: 'var(--hub-ink)', fontWeight: 500, overflowWrap: 'anywhere' }}>{short(o.name).split(/[/\\]/).slice(-2)[0]}<span className="sr-only"> ({KIND[o.kind as keyof typeof KIND]})</span></dt>
                <dd style={{ margin: 0, color: 'var(--hub-body)' }}>{tips[o.name]}</dd>
              </div>)}
            </dl>
          </details>
        )}
        {links.length > 0 && <div style={{ display: 'grid', gap: 6 }}>
          <h4 style={caps}><span>Connected</span><span>{plural(links.length, 'server')}</span></h4>
          <ul role="list" aria-label="MCP servers and apps" style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {links.map(c => <li key={`${c.kind}:${c.name}`} title={[c.kind === 'mcp' ? 'MCP server' : 'App', c.status, c.detail].filter(Boolean).join(' · ')}
              style={{ ...chip(false), cursor: 'default', color: 'var(--hub-body)' }}>
              <i aria-hidden style={{ width: 6, height: 6, borderRadius: '50%', background: DOT[c.status] }} />{c.name}
              <span className="sr-only">, {c.status === 'on' ? 'connected' : c.status === 'error' ? 'has a problem' : 'off'}</span>
              {c.detail && <span style={{ color: 'var(--hub-ash)' }}>{c.detail}</span>}
            </li>)}
          </ul>
        </div>}
        {onInstalled && <div><button type="button" className="hub-btn" onClick={onInstalled} style={{ padding: '6px 10px', fontSize: 12 }}>Everything installed</button></div>}
      </div>
    </details>
  )
}
