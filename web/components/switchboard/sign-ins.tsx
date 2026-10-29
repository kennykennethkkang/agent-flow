'use client'

/**
 * Sign-ins, grouped by app. AWS: every profile in ~/.aws/config with its status, and the profile this
 * window's terminals (and the chats Switchboard starts in its folder) get as AWS_PROFILE. Web apps
 * (Auth0 and any added): saved logins, each opened in its own Chrome profile. The extension checks
 * names, regions and URLs again; this panel only keeps obvious typos from being sent.
 */
import { useState } from 'react'
import type { AwsProfile, AwsStatus, ChatRow, HubState, WebApp, WebLogin } from '@/lib/hub-types'
import type { HubCommand } from '@/lib/vscode-bridge'
import { caps, repoOf } from './look'

const NAME = /^[A-Za-z0-9._@+-]{1,64}$/
const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/
const STATUS: Record<AwsStatus, { label: string; color: string; soft: string }> = {
  'signed-in': { label: 'Signed in', color: 'var(--hub-green)', soft: 'var(--hub-green-soft)' },
  expired: { label: 'Expired', color: 'var(--hub-yellow)', soft: 'var(--hub-yellow-soft)' },
  never: { label: 'Never', color: 'var(--hub-ash)', soft: 'transparent' },
}
const field = { font: '400 13px/1 var(--hub-sans)', padding: '7px 10px', borderRadius: 6, border: '1px solid var(--hub-hair)', background: 'var(--hub-canvas)', color: 'var(--hub-ink)', minWidth: 0 } as const
const small = { padding: '5px 10px', fontSize: 12 } as const
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const URL_OK = /^https?:\/\/[^\s/@]+(\/\S*)?$/
const head = { font: '600 13px/1.4 var(--hub-sans)', color: 'var(--hub-ink)', margin: 0 } as const
const row = { display: 'grid', gap: 6, padding: '10px 0', borderTop: '1px solid var(--hub-hair)' } as const
const actions = { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' } as const

/** The profile picked for the deepest project folder holding cwd; the extension's profileFor in aws.ts. */
export function profileFor(projects: Record<string, string>, cwd: string): string | undefined {
  const c = norm(cwd)
  const hit = Object.keys(projects).filter(k => c === norm(k) || c.startsWith(`${norm(k)}/`)).sort((a, b) => b.length - a.length)[0]
  return hit ? projects[hit] : undefined
}

function ChromePick({ hub, value, onChange, label }: { hub: HubState; value: string; onChange: (v: string) => void; label: string }) {
  if (!hub.signIns?.chrome.length) return null
  return (
    <select aria-label={label} value={value} onChange={e => onChange(e.target.value)} style={{ ...field, padding: '5px 8px', fontSize: 12 }}>
      <option value="">System browser</option>
      {hub.signIns.chrome.map(c => <option key={c.dir} value={c.dir}>Chrome: {c.name}{c.email ? ` (${c.email})` : ''}</option>)}
    </select>
  )
}

/** Delete, asked once more inline before it is sent. */
function Delete({ what, note, onDelete }: { what: string; note: string; onDelete: () => void }) {
  const [asking, setAsking] = useState(false)
  if (!asking) return <button type="button" className="hub-btn" style={small} onClick={() => setAsking(true)}>Delete</button>
  return (
    <span role="group" aria-label={`Delete ${what}?`} style={{ ...actions, flexBasis: '100%' }}>
      <span style={{ fontSize: 12, color: 'var(--hub-red)' }}>Delete {what}? {note}</span>
      <button type="button" className="hub-btn" style={{ ...small, color: 'var(--hub-red)' }} onClick={() => { setAsking(false); onDelete() }}>Yes, delete</button>
      <button type="button" className="hub-btn" style={small} autoFocus onClick={() => setAsking(false)}>Cancel</button>
    </span>
  )
}

/** A name edited in place: Enter saves, Escape puts it back. */
function Rename({ value, label, onSave, onDone }: { value: string; label: string; onSave: (v: string) => void; onDone: () => void }) {
  const [v, setV] = useState(value)
  return (
    <form onSubmit={e => { e.preventDefault(); onSave(v); onDone() }} style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
      <input autoFocus aria-label={label} value={v} maxLength={80} onChange={e => setV(e.target.value)} placeholder="Display name" style={field}
        onKeyDown={e => { if (e.key === 'Escape') onDone() }} />
      <button type="submit" className="hub-btn" style={small}>Save</button>
    </form>
  )
}

function Row({ p, hub, send, users }: { p: AwsProfile; hub: HubState; send: (c: HubCommand) => void; users: ChatRow[] }) {
  const [renaming, setRenaming] = useState(false)
  const [chrome, setChrome] = useState(p.chrome ?? '')
  const s = STATUS[p.status]
  return (
    <li style={row}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px' }}>
        {renaming
          ? <Rename value={p.label ?? ''} label={`Name for ${p.name}`} onSave={label => send({ type: 'hub-aws-label', profile: p.name, label })} onDone={() => setRenaming(false)} />
          : <strong style={{ color: 'var(--hub-ink)', fontWeight: 500 }}>{p.label || p.name}</strong>}
        {p.isDefault && <span className="hub-chip" style={{ color: 'var(--hub-blue)', background: 'var(--hub-blue-soft)' }}>Default</span>}
        <span className="hub-chip" style={{ color: s.color, background: s.soft, boxShadow: p.status === 'never' ? 'inset 0 0 0 1px var(--hub-hair)' : 'none' }}><i aria-hidden />{s.label}</span>
      </div>
      <span style={{ font: '400 12px/1.5 var(--hub-mono)', color: 'var(--hub-mute)', overflowWrap: 'anywhere' }}>
        {p.name}{p.account ? `  ${p.account}` : ''}{p.region ? `  ${p.region}` : ''}
      </span>
      {users.length > 0 && <span style={{ fontSize: 12, color: 'var(--hub-ash)' }}>Used by {users.map(c => c.name || repoOf(c.cwd)).join(', ')}</span>}
      <div style={actions}>
        <ChromePick hub={hub} value={chrome} onChange={setChrome} label={`Browser for signing in to ${p.name}`} />
        <button type="button" className={`hub-btn${p.status === 'signed-in' ? '' : ' primary'}`} style={small} onClick={() => send({ type: 'hub-aws-login', profile: p.name, chrome })}>
          {p.status === 'signed-in' ? 'Sign in again' : 'Sign in'}
        </button>
        {!p.isDefault && <button type="button" className="hub-btn" style={small} onClick={() => send({ type: 'hub-aws-default', profile: p.name })}
          title="[default] takes this profile's settings; the old default is kept as previous-default-<time> when it was another account">Make default</button>}
        {!renaming && <button type="button" className="hub-btn" style={small} onClick={() => setRenaming(true)}>Rename</button>}
        {!p.isDefault && <Delete what={p.name} note="Its [profile] block leaves ~/.aws/config; a backup is saved beside it." onDelete={() => send({ type: 'hub-aws-delete', profile: p.name })} />}
      </div>
    </li>
  )
}

function Login({ app, l, hub, send }: { app: WebApp; l: WebLogin; hub: HubState; send: (c: HubCommand) => void }) {
  const [renaming, setRenaming] = useState(false)
  const [chrome, setChrome] = useState(l.chrome ?? '')
  const ids = { app: app.id, id: l.id }
  const active = app.active === l.id
  return (
    <li style={row}>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '6px 10px' }}>
        {renaming
          ? <Rename value={l.label} label={`Name for ${l.label}`} onSave={label => send({ type: 'hub-login-rename', ...ids, label })} onDone={() => setRenaming(false)} />
          : <strong style={{ color: 'var(--hub-ink)', fontWeight: 500 }}>{l.label}</strong>}
        {active && <span className="hub-chip" style={{ color: 'var(--hub-blue)', background: 'var(--hub-blue-soft)' }}>Active</span>}
      </div>
      <span style={{ font: '400 12px/1.5 var(--hub-mono)', color: 'var(--hub-mute)', overflowWrap: 'anywhere' }}>{l.url}</span>
      <div style={actions}>
        <ChromePick hub={hub} value={chrome} onChange={setChrome} label={`Browser for ${l.label}`} />
        <button type="button" className={`hub-btn${active ? ' primary' : ''}`} style={small} onClick={() => send({ type: 'hub-login-open', ...ids, chrome })}>Sign in</button>
        {!active && <button type="button" className="hub-btn" style={small} onClick={() => send({ type: 'hub-login-active', ...ids })}>Make active</button>}
        {!renaming && <button type="button" className="hub-btn" style={small} onClick={() => setRenaming(true)}>Rename</button>}
        <Delete what={l.label} note="Only the saved entry goes; the account itself is untouched." onDelete={() => send({ type: 'hub-login-delete', ...ids })} />
      </div>
    </li>
  )
}

/** One web app: its saved logins and a form for another. */
function App({ app, hub, send }: { app: WebApp; hub: HubState; send: (c: HubCommand) => void }) {
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState(app.url)
  const [chrome, setChrome] = useState('')
  const bad = !!url && !URL_OK.test(url)
  return (
    <div role="group" aria-label={app.name} style={{ display: 'grid', gap: 4, borderTop: '1px solid var(--hub-hair)', paddingTop: 12 }}>
      <div style={{ ...actions, justifyContent: 'space-between' }}>
        <h3 style={head}>{app.name}</h3>
        <Delete what={app.name} note={`Its ${app.logins.length} saved login${app.logins.length === 1 ? '' : 's'} go too; the accounts are untouched.`} onDelete={() => send({ type: 'hub-login-app-delete', app: app.id })} />
      </div>
      {app.logins.length
        ? <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {app.logins.map(l => <Login key={`${l.id}:${l.label}:${l.chrome ?? ''}`} app={app} l={l} hub={hub} send={send} />)}
          </ul>
        : <p style={{ margin: 0, color: 'var(--hub-ash)', fontSize: 13 }}>No saved logins yet.</p>}
      <form onSubmit={e => { e.preventDefault(); if (label.trim() && url && !bad) { send({ type: 'hub-login-add', app: app.id, label, url, chrome }); setLabel('') } }} style={{ ...actions, paddingTop: 6 }}>
        <input aria-label={`New ${app.name} login name`} placeholder="Login name, like Work tenant" value={label} maxLength={80} onChange={e => setLabel(e.target.value)} style={{ ...field, flex: '1 1 140px' }} />
        <input aria-label={`${app.name} login URL`} placeholder={app.url} value={url} onChange={e => setUrl(e.target.value.trim())} style={{ ...field, flex: '2 1 200px' }} />
        <ChromePick hub={hub} value={chrome} onChange={setChrome} label={`Browser for the new ${app.name} login`} />
        <button type="submit" className="hub-btn" style={small} disabled={!label.trim() || !url || bad}>Add login</button>
        {bad && <span role="alert" style={{ flexBasis: '100%', fontSize: 12, color: 'var(--hub-red)' }}>Login URLs start with https:// or http://.</span>}
      </form>
    </div>
  )
}

function AddApp({ apps, send }: { apps: WebApp[]; send: (c: HubCommand) => void }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const taken = apps.some(a => a.name.toLowerCase() === name.trim().toLowerCase())
  const bad = !!url && !URL_OK.test(url)
  return (
    <form onSubmit={e => { e.preventDefault(); if (name.trim() && url && !bad && !taken) { send({ type: 'hub-login-app-add', name, url }); setName(''); setUrl('') } }}
      style={{ ...actions, borderTop: '1px solid var(--hub-hair)', paddingTop: 12 }}>
      <h3 style={{ ...head, flexBasis: '100%' }}>Add app</h3>
      <input aria-label="App name" placeholder="App name, like Vercel" value={name} maxLength={40} onChange={e => setName(e.target.value)} style={{ ...field, flex: '1 1 140px' }} />
      <input aria-label="App login URL" placeholder="https://vercel.com/login" value={url} onChange={e => setUrl(e.target.value.trim())} style={{ ...field, flex: '2 1 200px' }} />
      <button type="submit" className="hub-btn" style={small} disabled={!name.trim() || !url || bad || taken}>Add app</button>
      {(bad || taken) && <span role="alert" style={{ flexBasis: '100%', fontSize: 12, color: 'var(--hub-red)' }}>{taken ? `${name.trim()} is already listed.` : 'Login URLs start with https:// or http://.'}</span>}
    </form>
  )
}

/** The Sign-ins panel, opened from the gear. */
export function SignIns({ hub, send, onClose }: { hub: HubState; send: (c: HubCommand) => void; onClose: () => void }) {
  const [name, setName] = useState('')
  const [region, setRegion] = useState('us-west-1')
  const [chrome, setChrome] = useState('')
  // An older extension sends no signIns.
  const { projects, window: here, apps = [] } = hub.signIns ?? { projects: {} }
  const using = here ? projects[here] : undefined
  const bad = (name && !NAME.test(name)) || (region && !REGION.test(region))
  const taken = hub.aws.some(a => a.name === name)
  const add = () => { send({ type: 'hub-aws-add', profile: name, region, chrome }); setName('') }
  const live = hub.chats.filter(c => c.live)
  return (
    <section aria-label="Sign-ins" style={{ padding: 16, borderBottom: '1px solid var(--hub-hair)', background: 'var(--hub-surface)', display: 'grid', gap: 12, maxWidth: 720 }}>
      <h2 style={caps}>
        <span>Sign-ins</span>
        <span style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="hub-link" onClick={() => send({ type: 'hub-aws-check' })} style={{ font: 'inherit', textTransform: 'none' }}>Check now</button>
          <button type="button" className="hub-link" onClick={onClose} style={{ font: 'inherit', textTransform: 'none' }}>Back to settings</button>
        </span>
      </h2>
      <h3 style={head}>AWS</h3>
      {here
        ? <label style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8, color: 'var(--hub-body)' }}>
            This window uses
            <select value={using ?? ''} onChange={e => send({ type: 'hub-aws-window', profile: e.target.value || null })} style={field}>
              <option value="">Use default</option>
              {hub.aws.map(a => <option key={a.name} value={a.name}>{a.label ? `${a.label} (${a.name})` : a.name}</option>)}
            </select>
            <span style={{ fontSize: 12, color: 'var(--hub-ash)', flexBasis: '100%' }}>
              New terminals in {repoOf(here)} get AWS_PROFILE{using ? `=${using}` : ' unset'}, so Claude, Codex and tools started there use it. Open terminals keep theirs until restarted.
            </span>
          </label>
        : <p style={{ margin: 0, color: 'var(--hub-ash)' }}>Open a folder in this window to pick its AWS profile.</p>}
      {hub.aws.length
        ? <ul role="list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {hub.aws.map(p => <Row key={`${p.name}:${p.label ?? ''}:${p.chrome ?? ''}`} p={p} hub={hub} send={send}
              users={live.filter(c => (profileFor(projects, c.cwd) ?? 'default') === p.name)} />)}
          </ul>
        : <p style={{ margin: 0, color: 'var(--hub-ash)' }}>No profiles in ~/.aws/config yet. Add one below to sign in.</p>}
      <form onSubmit={e => { e.preventDefault(); if (name && !bad && !taken) add() }} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', borderTop: '1px solid var(--hub-hair)', paddingTop: 12 }}>
        <input aria-label="New profile name" placeholder="Profile name" value={name} maxLength={64} onChange={e => setName(e.target.value.trim())} style={{ ...field, flex: '1 1 140px' }} />
        <input aria-label="Region" placeholder="us-west-1" value={region} onChange={e => setRegion(e.target.value.trim())} style={{ ...field, width: 120 }} />
        <ChromePick hub={hub} value={chrome} onChange={setChrome} label="Browser for the new profile's sign-in" />
        <button type="submit" className="hub-btn primary" style={small} disabled={!name || !!bad || taken}>Add and sign in</button>
        {(bad || taken) && <span role="alert" style={{ flexBasis: '100%', fontSize: 12, color: 'var(--hub-red)' }}>
          {taken ? `${name} already exists.` : 'Names use letters, digits and . _ @ + - (up to 64). Regions look like us-west-1.'}
        </span>}
      </form>
      {apps.map(a => <App key={a.id} app={a} hub={hub} send={send} />)}
      {hub.signIns?.apps && <AddApp apps={apps} send={send} />}
    </section>
  )
}
