/**
 * Saved web logins, grouped by app, in ~/.claude/switchboard/logins.json: a label, the
 * sign-in URL and the Chrome profile to open it in. No passwords or tokens are ever kept.
 */
import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { writeJsonAtomic } from '../hook-entries'
import type { WebviewToExtensionMessage } from '../protocol'
import type { ChromeProfile, Links, WebApp, WebLogin } from './types'

export const LOGINS = path.join(os.homedir(), '.claude', 'switchboard', 'logins.json')
export const AUTH0: WebApp = { id: 'auth0', name: 'Auth0', url: 'https://manage.auth0.com/', logins: [] }

const SECRET_PARAM = /token|secret|pass|key|code|session|auth/i

/** The URL as given when it is http(s) and carries no credentials; undefined otherwise. */
export function loginUrl(s: string): string | undefined {
  let u: URL
  try { u = new URL(s.trim()) } catch { return undefined }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
  if (u.username || u.password || [...u.searchParams.keys()].some(k => SECRET_PARAM.test(k))) return undefined
  return u.href
}

const clean = (s: string, max: number) => s.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, max)
const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0

function login(v: unknown): WebLogin | undefined {
  const o = v as Record<string, unknown> | null
  if (!o || !str(o.id) || !str(o.label) || !str(o.url) || loginUrl(o.url) !== o.url) return undefined
  return { id: o.id, label: o.label, url: o.url, ...(typeof o.chrome === 'string' ? { chrome: o.chrome } : {}) }
}

/** The saved apps; Auth0 alone when there is no file yet. Entries a hand edit broke are dropped. */
export function readLogins(file = LOGINS): WebApp[] {
  let raw: unknown
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return [AUTH0] }
  const apps = (raw as { apps?: unknown })?.apps
  if (!Array.isArray(apps)) return [AUTH0]
  return apps.flatMap(a => {
    if (!a || !str(a.id) || !str(a.name) || !str(a.url) || loginUrl(a.url) !== a.url) return []
    const logins = (Array.isArray(a.logins) ? a.logins : []).flatMap((l: unknown) => login(l) ?? [])
    const active = logins.some((l: WebLogin) => l.id === a.active) ? a.active as string : undefined
    return [{ id: a.id, name: a.name, url: a.url, logins, ...(active ? { active } : {}) }]
  })
}

/** Links to apps and logins that still exist; a gone login falls back to the app default (null). */
export function pruneLinks(links: unknown, apps: WebApp[]): Links {
  const out: Links = {}
  if (!links || typeof links !== 'object') return out
  for (const [folder, row] of Object.entries(links)) {
    if (!row || typeof row !== 'object') continue
    const kept: Record<string, string | null> = {}
    for (const [id, login] of Object.entries(row)) {
      const app = apps.find(a => a.id === id)
      if (app) kept[id] = typeof login === 'string' && app.logins.some(l => l.id === login) ? login : null
    }
    if (Object.keys(kept).length) out[folder] = kept
  }
  return out
}

export function readLinks(file = LOGINS, apps = readLogins(file)): Links {
  try { return pruneLinks(JSON.parse(fs.readFileSync(file, 'utf8')).links, apps) } catch { return {} }
}

/** Keeps the saved links unless given new ones, pruned to what apps still holds. */
export function writeLogins(apps: WebApp[], file = LOGINS, links: Links = readLinks(file)): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  writeJsonAtomic(file, { apps, links: pruneLinks(links, apps) })
}

export type LinkCommand = Extract<WebviewToExtensionMessage, { type: 'hub-login-link' }>
export type LoginCommand = Exclude<Extract<WebviewToExtensionMessage, { type: `hub-login-${string}` }>, LinkCommand>

/** The links after one command, or why it was refused. folders: the project folders Switchboard knows. */
export function applyLink(apps: WebApp[], links: Links, c: LinkCommand, folders: string[]): Links | string {
  if (!folders.includes(c.folder)) return 'that folder is not in the project list'
  const app = apps.find(a => a.id === c.app)
  if (!app) return 'no such app'
  if (c.login !== null && c.login !== 'off' && !app.logins.some(l => l.id === c.login)) return 'no such login'
  const { [app.id]: _was, ...rest } = links[c.folder] ?? {}
  const row = c.login === 'off' ? rest : { ...rest, [app.id]: c.login }
  const { [c.folder]: _old, ...others } = links
  return Object.keys(row).length ? { ...others, [c.folder]: row } : others
}

/** The login Sign in opens with no id: the project's pick, else the app's active one. */
export const loginFor = (app: WebApp, links: Links, folder: string | undefined): string | undefined =>
  (folder ? links[folder]?.[app.id] : undefined) ?? app.active

/** One line for a new chat's system note naming the project's accounts; labels and Chrome profile names only. */
export function accountsNote(apps: WebApp[], links: Links, folder: string, chrome: ChromeProfile[]): string | undefined {
  const parts = Object.keys(links[folder] ?? {}).flatMap(id => {
    const app = apps.find(a => a.id === id)
    if (!app) return []
    const row = app.logins.find(l => l.id === loginFor(app, links, folder))
    if (!row) return [`${app.name} has no saved login`]
    const browser = row.chrome ? `Chrome ${chrome.find(c => c.dir === row.chrome)?.name ?? row.chrome}` : 'system browser'
    return [`${app.name} uses ${row.label} (${browser})`]
  })
  return parts.length ? `Web accounts for this project: ${parts.join('; ')}.` : undefined
}

/**
 * The apps after one command, or why it was refused. Opening a login only saves its browser here; the caller opens it.
 * chromes: Chrome's profile folders; a command naming another one is refused before anything is saved.
 */
export function applyLogin(apps: WebApp[], c: LoginCommand, newId = () => randomUUID().slice(0, 8), chromes?: string[]): WebApp[] | string {
  if ('chrome' in c && c.chrome && chromes && !chromes.includes(c.chrome)) return 'That Chrome profile is not in Chrome\'s list'
  if (c.type === 'hub-login-app-add') {
    const name = clean(c.name, 40), url = loginUrl(c.url)
    if (!name) return 'give the app a name'
    if (!url) return 'the login URL must start with https:// or http:// and hold no password or token'
    if (apps.some(a => a.name.toLowerCase() === name.toLowerCase() || a.id === name.toLowerCase())) return `${name} is already in the list`
    return [...apps, { id: newId(), name, url, logins: [] }]
  }
  const app = apps.find(a => a.id === c.app)
  if (!app) return 'no such app'
  if (c.type === 'hub-login-app-delete') return apps.filter(a => a.id !== app.id)
  const put = (next: WebApp) => apps.map(a => (a.id === app.id ? next : a))
  if (c.type === 'hub-login-add') {
    const label = clean(c.label, 80), url = loginUrl(c.url)
    if (!label) return 'give the login a name'
    if (!url) return 'the login URL must start with https:// or http:// and hold no password or token'
    const fresh: WebLogin = { id: newId(), label, url, ...(c.chrome !== undefined ? { chrome: c.chrome } : {}) }
    return put({ ...app, logins: [...app.logins, fresh], active: app.active ?? fresh.id })
  }
  const row = app.logins.find(l => l.id === c.id)
  if (!row) return 'no such login'
  const edit = (l: Partial<WebLogin>) => put({ ...app, logins: app.logins.map(x => (x.id === row.id ? { ...x, ...l } : x)) })
  switch (c.type) {
    case 'hub-login-open': return c.chrome === undefined ? apps : edit({ chrome: c.chrome })
    case 'hub-login-active': return put({ ...app, active: row.id })
    case 'hub-login-rename': {
      const label = clean(c.label, 80)
      return label ? edit({ label }) : 'give the login a name'
    }
    case 'hub-login-delete': {
      const logins = app.logins.filter(l => l.id !== row.id)
      const { active: _a, ...rest } = app
      const active = app.active === row.id ? logins[0]?.id : app.active
      return put({ ...rest, logins, ...(active ? { active } : {}) })
    }
  }
}
