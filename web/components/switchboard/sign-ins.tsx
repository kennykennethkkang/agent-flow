'use client'

/**
 * Accounts. First what this window's project uses (AWS profile, the login per web app), then other projects,
 * then the saved accounts themselves. The extension checks names, regions and URLs again; this panel only
 * keeps obvious typos from being sent.
 */
import { useEffect, useState } from 'react'
import type { AwsProfile, AwsStatus, ChatRow, HubState, WebApp, WebLogin } from '@/lib/hub-types'
import type { HubCommand } from '@/lib/vscode-bridge'
import { projectName } from '@/lib/archive'
import { caps, panel, repoOf } from './look'
import { Pick } from './gear'

type Send = (c: HubCommand) => void
type Problem = { text: string; at: number } | null

const NAME = /^[A-Za-z0-9._@+-]{1,64}$/
const REGION = /^[a-z]{2}(-[a-z]+)+-\d{1,2}$/
const STATUS: Record<AwsStatus, { label: string; color: string; soft: string }> = {
  'signed-in': { label: 'Signed in', color: 'var(--hub-green)', soft: 'var(--hub-green-soft)' },
  expired: { label: 'Expired', color: 'var(--hub-yellow)', soft: 'var(--hub-yellow-soft)' },
  never: { label: 'Not signed in', color: 'var(--hub-ash)', soft: 'transparent' },
}
const field = { font: '400 13px/1.2 var(--hub-sans)', padding: '7px 10px', borderRadius: 8, border: '1px solid var(--hub-hair)', background: 'var(--hub-canvas)', color: 'var(--hub-ink)', minWidth: 0, boxSizing: 'border-box' } as const
const small = { padding: '6px 10px', fontSize: 12 } as const
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const home = (p: string) => p.replace(/^\/Users\/[^/]+/, '~')
const URL_OK = /^https?:\/\/[^\s/@]+(\/\S*)?$/
const head = { font: '600 13px/1.4 var(--hub-sans)', color: 'var(--hub-ink)', margin: 0, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const
const sub = { ...caps, fontSize: 11, margin: '4px 0 0' } as const
// One row: what it is on the left, its actions on the right; they stack when the panel is narrow.
const row = { display: 'flex', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: '8px 16px', padding: '10px 0', borderTop: '1px solid var(--hub-hair)', minWidth: 0 } as const
const left = { display: 'grid', gap: 2, flex: '1 1 220px', minWidth: 0 } as const
const actions = { display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', justifyContent: 'flex-end', minWidth: 0, marginLeft: 'auto' } as const
const mono = { font: '400 12px/1.5 var(--hub-mono)', color: 'var(--hub-mute)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } as const
const quiet = { margin: 0, fontSize: 12, lineHeight: 1.45, color: 'var(--hub-ash)' } as const
const list = { listStyle: 'none', margin: 0, padding: 0 } as const
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`
const named = (a: AwsProfile) => (a.label ? `${a.label} (${a.name})` : a.name)

// An older extension sends no stale flag.
const stale = (p: AwsProfile) => p.stale ?? p.name.startsWith('previous-default-')

/** The profile picked for the deepest project folder holding cwd; the extension's profileFor in aws.ts. */
export function profileFor(projects: Record<string, string>, cwd: string): string | undefined {
  const c = norm(cwd)
  const hit = Object.keys(projects).filter(k => c === norm(k) || c.startsWith(`${norm(k)}/`)).sort((a, b) => b.length - a.length)[0]
  return hit ? projects[hit] : undefined
}

function Status({ s }: { s: AwsStatus }) {
  const st = STATUS[s]
  return <span className="hub-chip" style={{ color: st.color, background: st.soft, boxShadow: s === 'never' ? 'inset 0 0 0 1px var(--hub-hair)' : 'none' }}><i aria-hidden />{st.label}</span>
}

const chromeName = (hub: HubState, dir?: string) => {
  const c = dir ? hub.signIns?.chrome.find(x => x.dir === dir) : undefined
  return c ? `Chrome: ${c.name}` : 'System browser'
}

/** Where a sign-in opens, as text with a Change control; the select only shows while changing. */
function Browser({ hub, value, onChange, label }: { hub: HubState; value: string; onChange: (v: string) => void; label: string }) {
  const [open, setOpen] = useState(false)
  const chrome = hub.signIns?.chrome ?? []
  if (!chrome.length) return null
  const now = chrome.find(c => c.dir === value)
  if (open) return (
    <select className="hub-select" autoFocus aria-label={label} value={value} onBlur={() => setOpen(false)} onChange={e => { onChange(e.target.value); setOpen(false) }} style={{ fontSize: 12, maxWidth: '100%' }}>
      <option value="">System browser</option>
      {chrome.map(c => <option key={c.dir} value={c.dir}>Chrome: {c.name}{c.email ? ` (${c.email})` : ''}</option>)}
    </select>
  )
  const text = chromeName(hub, value)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, minWidth: 0, maxWidth: '100%', fontSize: 12, color: 'var(--hub-ash)' }}>
      <span title={now?.email ? `${text} (${now.email})` : text} style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>Opens in {text}</span>
      <button type="button" className="hub-link" aria-label={label} onClick={() => setOpen(true)}>Change</button>
    </span>
  )
}

/** Delete, asked once more inline before it is sent. */
function Delete({ what, note, onDelete, text = 'Delete' }: { what: string; note: string; onDelete: () => void; text?: string }) {
  const [asking, setAsking] = useState(false)
  if (!asking) return <button type="button" className="hub-btn" style={small} onClick={() => setAsking(true)}>{text}</button>
  return (
    <span role="group" aria-label={`Delete ${what}?`} style={{ ...actions, flexBasis: '100%' }}>
      <span style={{ fontSize: 12, color: 'var(--hub-red)', overflowWrap: 'anywhere', flex: '1 1 160px' }}>Delete {what}? {note}</span>
      <button type="button" className="hub-btn" style={{ ...small, color: 'var(--hub-red)' }} onClick={() => { setAsking(false); onDelete() }}>Yes, delete</button>
      <button type="button" className="hub-btn" style={small} autoFocus onClick={() => setAsking(false)}>Cancel</button>
    </span>
  )
}

/** A name edited in place: Enter saves, Escape puts it back. */
function Rename({ value, label, onSave, onDone }: { value: string; label: string; onSave: (v: string) => void; onDone: () => void }) {
  const [v, setV] = useState(value)
  return (
    <form onSubmit={e => { e.preventDefault(); onSave(v); onDone() }} style={{ display: 'flex', gap: 6, flex: '1 1 200px', minWidth: 0 }}>
      <input autoFocus aria-label={label} value={v} maxLength={80} onChange={e => setV(e.target.value)} placeholder="Display name" style={{ ...field, flex: '1 1 140px' }}
        onKeyDown={e => { if (e.key === 'Escape') onDone() }} />
      <button type="submit" className="hub-btn" style={small}>Save</button>
    </form>
  )
}

/** Picks for one folder: its AWS profile (only this window's can change) and the login per web app. */
function Uses({ hub, send, folder, here }: { hub: HubState; send: Send; folder: string; here: boolean }) {
  const si = hub.signIns
  const uses = si?.links?.[folder] ?? {}
  const repo = repoOf(folder)
  const profile = profileFor(si?.projects ?? {}, folder)
  const p = hub.aws.find(a => a.name === (profile ?? 'default'))
  // The browser picked here, for the profile it was picked for.
  const [pick, setPick] = useState<{ name: string; dir: string }>()
  const chrome = pick && pick.name === p?.name ? pick.dir : p?.chrome ?? ''
  const setChrome = (dir: string) => p && setPick({ name: p.name, dir })
  const awsOptions: Array<[string, string]> = [['', 'Default profile'], ...hub.aws.filter(a => a.name === profile || (!stale(a) && !(a.isDefault && a.name === 'default'))).map((a): [string, string] => [a.name, named(a)])]
  const link = (app: string, v: string) => send({ type: 'hub-login-link', folder, app, login: v === 'off' ? 'off' : v || null })
  // undefined: not set; '' the system browser.
  const browser = profileFor(si?.browsers ?? {}, folder)
  const browserOptions: Array<[string, string]> = [['unset', 'Not set'], ['', 'System browser'], ...(si?.chrome ?? []).map((c): [string, string] => [c.dir, `Chrome: ${c.name}`])]
  return (
    <>
      <div className="hub-set-row" style={{ borderTop: 0 }}>
        <span style={left}>
          <span style={{ color: 'var(--hub-ink)' }}>Browser</span>
          <span style={quiet}>{browser === undefined ? 'Each login opens where it was saved.' : `Logins without their own pick${here ? ' and terminal sign-ins (aws login, gh auth login)' : ''} open here.`}</span>
        </span>
        <span style={actions}>
          <Pick label={`Browser for ${repo}`} options={browserOptions} value={browser ?? 'unset'} muted={browser === undefined}
            onChange={v => send({ type: 'hub-browser', folder, chrome: v === 'unset' ? null : v })} />
        </span>
      </div>
      <div className="hub-set-row">
        <span style={left}>
          <span style={{ color: 'var(--hub-ink)' }}>AWS</span>
          <span style={quiet}>{here ? `New terminals get ${profile ? `AWS_PROFILE=${profile}` : 'no AWS_PROFILE'}.` : `Open ${repo} in VS Code to change.`}</span>
          {here && p && p.status !== 'signed-in' && <Browser hub={hub} value={chrome} onChange={setChrome} label={`Browser for signing in to ${p.name}`} />}
        </span>
        <span style={actions}>
          {p && <Status s={p.status} />}
          {here
            ? <Pick label={`AWS profile for ${repo}`} options={awsOptions} value={profile ?? ''} muted={!profile} onChange={v => send({ type: 'hub-aws-window', profile: v || null })} />
            : <span title={profile ?? 'Default profile'} style={{ ...mono, color: 'var(--hub-body)' }}>{profile ?? 'Default profile'}</span>}
          {here && p && p.status !== 'signed-in' && <button type="button" className="hub-btn primary" style={small} onClick={() => send({ type: 'hub-aws-login', profile: p.name, chrome })}>Sign in</button>}
        </span>
      </div>
      {(si?.apps ?? []).map(app => {
        const on = app.id in uses
        const chosen = uses[app.id] ?? null
        const def = app.logins.find(l => l.id === app.active)
        const l = app.logins.find(x => x.id === (chosen ?? app.active))
        return (
          <div key={app.id} className="hub-set-row">
            <span style={left}>
              <span style={{ color: 'var(--hub-ink)' }}>{app.name}</span>
              <span style={quiet}>{!on ? 'Not used here' : l ? `Opens in ${chromeName(hub, l.chrome ?? browser)}` : 'No saved logins yet'}</span>
            </span>
            <span style={actions}>
              <Pick label={`${app.name} login for ${repo}`} muted={!on} value={on ? chosen ?? '' : 'off'} onChange={v => link(app.id, v)}
                options={[['off', 'Not used'], ['', `Default${def ? ` (${def.label})` : ''}`], ...app.logins.map((x): [string, string] => [x.id, x.label])]} />
              {on && l && <button type="button" className="hub-btn" style={small} onClick={() => send({ type: 'hub-login-open', app: app.id, id: l.id, folder })}>Sign in</button>}
            </span>
          </div>
        )
      })}
    </>
  )
}

function Projects({ hub, send }: { hub: HubState; send: Send }) {
  const si = hub.signIns
  const here = si?.window ?? hub.thisWindow
  const seen = new Set<string>()
  // Only folders hub-login-link accepts: this window's and the project list.
  const others = hub.projects.map(p => p.path)
    .filter(f => norm(f) !== norm(here ?? '') && !seen.has(norm(f)) && !!seen.add(norm(f)))
  const sum = (f: string) => {
    const uses = si?.links?.[f] ?? {}
    const apps = (si?.apps ?? []).filter(a => a.id in uses).map(a => {
      const id = uses[a.id] ?? a.active
      return `${a.name}: ${a.logins.find(l => l.id === id)?.label ?? 'default'}`
    })
    return [profileFor(si?.projects ?? {}, f) ?? 'default', ...apps].join(', ')
  }
  return (
    <>
      <section aria-labelledby="sb-this" style={{ display: 'grid', gap: 8, minWidth: 0 }}>
        <h3 id="sb-this" style={caps}>This project</h3>
        {here
          ? <div style={{ ...panel, gap: 0, padding: '4px 14px' }}>
              <div style={{ ...row, borderTop: 0, paddingBottom: 4 }}>
                <strong style={head} title={here}>{repoOf(here)}</strong>
                <span title={here} style={{ ...mono, marginLeft: 'auto' }}>{home(here)}</span>
              </div>
              <Uses hub={hub} send={send} folder={here} here={!!si?.window && norm(si.window) === norm(here)} />
            </div>
          : <p style={quiet}>Open a project folder in this window to pick its accounts.</p>}
      </section>
      {others.length > 0 && (
        <section aria-labelledby="sb-others" style={{ display: 'grid', minWidth: 0 }}>
          <h3 id="sb-others" style={{ ...caps, marginBottom: 4 }}>Other projects</h3>
          {others.map(f => (
            <details key={f} className="hub-fold-list">
              <summary>
                <b aria-hidden>›</b>
                <span style={{ color: 'var(--hub-ink)', flex: '0 0 auto' }}>{repoOf(f)}</span>
                <span style={{ ...mono, flex: 1, textAlign: 'right' }}>{sum(f)}</span>
              </summary>
              <div style={{ marginLeft: 22 }}><Uses hub={hub} send={send} folder={f} here={false} /></div>
            </details>
          ))}
        </section>
      )}
    </>
  )
}

function Profile({ p, hub, send, users, askedAt, onDelete, problem }: { p: AwsProfile; hub: HubState; send: Send; users: ChatRow[]; askedAt?: number; onDelete: () => void; problem: Problem }) {
  const [renaming, setRenaming] = useState(false)
  const [chrome, setChrome] = useState(p.chrome ?? '')
  const [late, setLate] = useState(false)
  // A delete that worked drops this row; one still here after a moment was refused.
  useEffect(() => {
    setLate(false)
    if (!askedAt) return
    const t = setTimeout(() => setLate(true), 2500)
    return () => clearTimeout(t)
  }, [askedAt])
  const why = askedAt && problem && problem.at >= askedAt && problem.text.startsWith('aws-delete failed') && problem.text.includes(p.name)
    ? problem.text.replace(/^aws-delete failed: /, '') : undefined
  const refused = why ?? (late ? 'Not deleted. VS Code shows why in its notifications.' : undefined)
  const old = stale(p)
  const detail = [p.label ? p.name : '', p.account, p.region].filter(Boolean).join('  ')
  return (
    <li style={row}>
      <span style={left}>
        <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', minWidth: 0 }}>
          {renaming
            ? <Rename value={p.label ?? ''} label={`Name for ${p.name}`} onSave={label => send({ type: 'hub-aws-label', profile: p.name, label })} onDone={() => setRenaming(false)} />
            : <strong title={p.label || p.name} style={{ ...head, fontWeight: 500 }}>{p.label || p.name}</strong>}
          {p.isDefault && <span className="hub-chip" style={{ color: 'var(--hub-blue)', background: 'var(--hub-blue-soft)' }}>Default</span>}
          {p.root && <span className="hub-chip ver" title="Signs in as the account root">Root</span>}
          {!old && <Status s={p.status} />}
        </span>
        {detail && <span title={detail} style={mono}>{detail}</span>}
        {users.length > 0 && <span style={quiet}>Used by {users.map(c => c.name || projectName(c)).join(', ')}</span>}
        {!old && p.status !== 'signed-in' && <Browser hub={hub} value={chrome} onChange={setChrome} label={`Browser for signing in to ${p.name}`} />}
        {refused && <span role="alert" style={{ fontSize: 12, color: 'var(--hub-red)', overflowWrap: 'anywhere' }}>{refused}</span>}
      </span>
      <span style={actions}>
        {!old && <button type="button" className={`hub-btn${p.status === 'signed-in' ? '' : ' primary'}`} style={small} onClick={() => send({ type: 'hub-aws-login', profile: p.name, chrome })}>
          {p.status === 'never' ? 'Sign in' : 'Sign in again'}
        </button>}
        {!old && !p.isDefault && <button type="button" className="hub-btn" style={small} onClick={() => send({ type: 'hub-aws-default', profile: p.name })}
          title="[default] takes this profile's settings; the old default is kept as a backup">Make default</button>}
        {!old && !renaming && <button type="button" className="hub-btn" style={small} onClick={() => setRenaming(true)}>Rename</button>}
        {!p.isDefault && <Delete what={p.name} note="~/.aws/config is backed up first." onDelete={onDelete} />}
      </span>
    </li>
  )
}

function Aws({ hub, send, problem }: { hub: HubState; send: Send; problem: Problem }) {
  const [name, setName] = useState('')
  const [region, setRegion] = useState('us-west-1')
  const [chrome, setChrome] = useState('')
  const [asked, setAsked] = useState<Record<string, number>>({})
  const projects = hub.signIns?.projects ?? {}
  const bad = (name && !NAME.test(name)) || (region && !REGION.test(region))
  const taken = hub.aws.some(a => a.name === name)
  const live = hub.chats.filter(c => c.live)
  const del = (names: string[]) => {
    const at = Date.now()
    setAsked(a => ({ ...a, ...Object.fromEntries(names.map(n => [n, at])) }))
    for (const n of names) send({ type: 'hub-aws-delete', profile: n })
  }
  const item = (p: AwsProfile) => <Profile key={`${p.name}:${p.label ?? ''}:${p.chrome ?? ''}`} p={p} hub={hub} send={send} problem={problem}
    askedAt={asked[p.name]} onDelete={() => del([p.name])}
    users={live.filter(c => (profileFor(projects, c.cwd) ?? 'default') === p.name)} />
  const old = hub.aws.filter(stale)
  return (
    <section aria-labelledby="sb-aws" style={{ display: 'grid', minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
        <h4 id="sb-aws" style={head}>AWS profiles</h4>
        <button type="button" className="hub-link" onClick={() => send({ type: 'hub-aws-check' })}>Check now</button>
      </div>
      {hub.aws.some(p => p.root) && <p style={{ ...quiet, margin: '2px 0 6px' }}>Root sign-ins end when AWS says so. An IAM user with SignInLocalDevelopmentAccess stays signed in up to 12 hours.</p>}
      {hub.aws.length
        ? <ul role="list" style={list}>{hub.aws.filter(p => !stale(p)).map(item)}</ul>
        : <p style={quiet}>No profiles in ~/.aws/config yet.</p>}
      {old.length > 0 && (
        <details className="hub-fold-list">
          <summary><b aria-hidden>›</b><span style={{ flex: 1, minWidth: 0, color: 'var(--hub-ink)' }}>Backups of old defaults</span><span style={{ font: '400 12px/1 var(--hub-mono)', color: 'var(--hub-ash)' }}>{old.length}</span></summary>
          <div style={{ marginLeft: 22, display: 'grid' }}>
            <div style={{ ...row, borderTop: 0, paddingTop: 0 }}>
              <p style={{ ...quiet, flex: '1 1 200px' }}>Kept when another account became [default].</p>
              <span style={actions}><Delete what={plural(old.length, 'backup')} text="Delete all backups" note="~/.aws/config is backed up first." onDelete={() => del(old.map(p => p.name))} /></span>
            </div>
            <ul role="list" style={list}>{old.map(item)}</ul>
          </div>
        </details>
      )}
      <details className="hub-fold-list">
        <summary><b aria-hidden>›</b><span style={{ flex: 1, color: 'var(--hub-ink)' }}>Add profile</span></summary>
        <form onSubmit={e => { e.preventDefault(); if (name && !bad && !taken) { send({ type: 'hub-aws-add', profile: name, region, chrome }); setName('') } }} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', margin: '0 0 10px 22px' }}>
          <input aria-label="New profile name" placeholder="Profile name" value={name} maxLength={64} onChange={e => setName(e.target.value.trim())} style={{ ...field, flex: '2 1 140px' }} />
          <input aria-label="Region" placeholder="us-west-1" value={region} onChange={e => setRegion(e.target.value.trim())} style={{ ...field, flex: '1 1 100px' }} />
          <button type="submit" className="hub-btn primary" style={small} disabled={!name || !!bad || taken}>Add and sign in</button>
          <span style={{ flexBasis: '100%', minWidth: 0 }}><Browser hub={hub} value={chrome} onChange={setChrome} label="Browser for the new profile's sign-in" /></span>
          {(bad || taken) && <span role="alert" style={{ flexBasis: '100%', fontSize: 12, color: 'var(--hub-red)' }}>
            {taken ? `${name} already exists.` : 'Names use letters, digits and . _ @ + - (up to 64). Regions look like us-west-1.'}
          </span>}
        </form>
      </details>
    </section>
  )
}

function Login({ app, l, hub, send }: { app: WebApp; l: WebLogin; hub: HubState; send: Send }) {
  const [renaming, setRenaming] = useState(false)
  const [chrome, setChrome] = useState(l.chrome ?? '')
  const ids = { app: app.id, id: l.id }
  const active = app.active === l.id
  return (
    <li style={row}>
      <span style={left}>
        <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 8px', minWidth: 0 }}>
          {renaming
            ? <Rename value={l.label} label={`Name for ${l.label}`} onSave={label => send({ type: 'hub-login-rename', ...ids, label })} onDone={() => setRenaming(false)} />
            : <strong title={l.label} style={{ ...head, fontWeight: 500 }}>{l.label}</strong>}
          {active && <span className="hub-chip" style={{ color: 'var(--hub-blue)', background: 'var(--hub-blue-soft)' }}>Default</span>}
        </span>
        <span title={l.url} style={mono}>{l.url}</span>
        <Browser hub={hub} value={chrome} onChange={setChrome} label={`Browser for ${l.label}`} />
      </span>
      <span style={actions}>
        <button type="button" className="hub-btn" style={small} onClick={() => send({ type: 'hub-login-open', ...ids, chrome })}>Sign in</button>
        {!active && <button type="button" className="hub-btn" style={small} title={`Projects that use ${app.name} without a pick get this login`} onClick={() => send({ type: 'hub-login-active', ...ids })}>Make default</button>}
        {!renaming && <button type="button" className="hub-btn" style={small} onClick={() => setRenaming(true)}>Rename</button>}
        <Delete what={l.label} note="Only the saved entry goes." onDelete={() => send({ type: 'hub-login-delete', ...ids })} />
      </span>
    </li>
  )
}

/** One web app: its saved logins and a folded form for another. */
function App({ app, hub, send }: { app: WebApp; hub: HubState; send: Send }) {
  const [label, setLabel] = useState('')
  const [url, setUrl] = useState(app.url)
  const [chrome, setChrome] = useState('')
  const bad = !!url && !URL_OK.test(url)
  const n = app.logins.length
  return (
    <div role="group" aria-label={app.name} style={{ display: 'grid', minWidth: 0, marginTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minWidth: 0 }}>
        <h5 style={head} title={app.name}>{app.name} <span style={{ fontWeight: 400, color: 'var(--hub-ash)' }}>{n}</span></h5>
        <Delete what={app.name} text="Delete app" note={n ? `Its ${plural(n, 'saved login')} ${n === 1 ? 'goes' : 'go'} too.` : ''} onDelete={() => send({ type: 'hub-login-app-delete', app: app.id })} />
      </div>
      {n
        ? <ul role="list" style={list}>{app.logins.map(l => <Login key={`${l.id}:${l.label}:${l.chrome ?? ''}`} app={app} l={l} hub={hub} send={send} />)}</ul>
        : <p style={{ ...quiet, padding: '6px 0' }}>No saved logins yet.</p>}
      <details className="hub-fold-list">
        <summary><b aria-hidden>›</b><span style={{ flex: 1, color: 'var(--hub-ink)' }}>Add {app.name} login</span></summary>
        <form onSubmit={e => { e.preventDefault(); if (label.trim() && url && !bad) { send({ type: 'hub-login-add', app: app.id, label, url, chrome }); setLabel('') } }} style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', margin: '0 0 10px 22px' }}>
          <input aria-label={`New ${app.name} login name`} placeholder="Name, like Work tenant" value={label} maxLength={80} onChange={e => setLabel(e.target.value)} style={{ ...field, flex: '1 1 140px' }} />
          <input aria-label={`${app.name} login URL`} placeholder={app.url} value={url} onChange={e => setUrl(e.target.value.trim())} style={{ ...field, flex: '2 1 200px' }} />
          <button type="submit" className="hub-btn" style={small} disabled={!label.trim() || !url || bad}>Add login</button>
          <span style={{ flexBasis: '100%', minWidth: 0 }}><Browser hub={hub} value={chrome} onChange={setChrome} label={`Browser for the new ${app.name} login`} /></span>
          {bad && <span role="alert" style={{ flexBasis: '100%', fontSize: 12, color: 'var(--hub-red)' }}>Login URLs start with https:// or http://.</span>}
        </form>
      </details>
    </div>
  )
}

function AddApp({ apps, send }: { apps: WebApp[]; send: Send }) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const taken = apps.some(a => a.name.toLowerCase() === name.trim().toLowerCase())
  const bad = !!url && !URL_OK.test(url)
  return (
    <details className="hub-fold-list">
      <summary><b aria-hidden>›</b><span style={{ flex: 1, color: 'var(--hub-ink)' }}>Add app</span></summary>
      <form onSubmit={e => { e.preventDefault(); if (name.trim() && url && !bad && !taken) { send({ type: 'hub-login-app-add', name, url }); setName(''); setUrl('') } }}
        style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center', margin: '0 0 10px 22px' }}>
        <input aria-label="App name" placeholder="App name, like Vercel" value={name} maxLength={40} onChange={e => setName(e.target.value)} style={{ ...field, flex: '1 1 140px' }} />
        <input aria-label="App login URL" placeholder="https://vercel.com/login" value={url} onChange={e => setUrl(e.target.value.trim())} style={{ ...field, flex: '2 1 200px' }} />
        <button type="submit" className="hub-btn" style={small} disabled={!name.trim() || !url || bad || taken}>Add app</button>
        {(bad || taken) && <span role="alert" style={{ flexBasis: '100%', fontSize: 12, color: 'var(--hub-red)' }}>{taken ? `${name.trim()} is already listed.` : 'Login URLs start with https:// or http://.'}</span>}
      </form>
    </details>
  )
}

/** Accounts, inside Settings; onClose when shown on its own. problem: the standalone app's last refused command. */
export function SignIns({ hub, send, onClose, problem = null }: { hub: HubState; send: Send; onClose?: () => void; problem?: Problem }) {
  const apps = hub.signIns?.apps ?? []
  const body = (
    <div style={{ display: 'grid', gap: 20, minWidth: 0 }}>
      <Projects hub={hub} send={send} />
      <section aria-labelledby="sb-accounts" style={{ display: 'grid', gap: 16, minWidth: 0 }}>
        <h3 id="sb-accounts" style={caps}>Accounts</h3>
        <Aws hub={hub} send={send} problem={problem} />
        <section aria-labelledby="sb-apps" style={{ display: 'grid', minWidth: 0 }}>
          <h4 id="sb-apps" style={head}>Web apps</h4>
          {apps.map(a => <App key={a.id} app={a} hub={hub} send={send} />)}
          {hub.signIns?.apps ? <AddApp apps={apps} send={send} /> : <p style={quiet}>Update the Switchboard extension to save web logins.</p>}
        </section>
      </section>
    </div>
  )
  if (!onClose) return body
  return (
    <section aria-label="Accounts" style={{ padding: 16, borderBottom: '1px solid var(--hub-hair)', background: 'var(--hub-surface)', display: 'grid', gap: 12, minWidth: 0 }}>
      <h2 style={caps}>
        <span>Accounts</span>
        <button type="button" className="hub-link" onClick={onClose} style={{ font: 'inherit', textTransform: 'none' }}>Back to settings</button>
      </h2>
      {body}
    </section>
  )
}
