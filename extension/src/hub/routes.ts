/**
 * The hook server's /hub routes, as a pure function so tests need no socket.
 *
 * POST /hub         a usage mod's feed post (token in the body)
 * GET  /hub/inbox   a chat collects what the panel queued for it (token in the query)
 * GET  /hub/keep    what a full chat does: always continue in a fresh chat (token in the query)
 * GET  /hub/brief   the brief for a new chat in ?cwd= (token in the query); its own project only
 * GET  /hub/ask     ?cwd=&q=: one paid Haiku answer from that project's board (token in the query)
 * GET  /hub/state   the whole HubState, for the standalone web app's proxy (token in the query)
 * POST /hub/command a hub-* command, run as the panel's (token in the query)
 * Anything outside /hub answers undefined and stays with the hook handler.
 */
import { askBrain, askContext, brief } from './brain'
import type { HubService } from './hub-service'
import type { WebviewToExtensionMessage } from '../protocol'
import type { SettingKey, SwitchboardKey } from './types'
import { isAi } from './ais'
import { ROLE_MODELS } from './roles'

export type HubReply = { status: number; body: string; contentType?: string }

const text = (body: string): HubReply => ({ status: 200, body, contentType: 'text/plain; charset=utf-8' })

type Check = (v: unknown) => boolean
type HubCommand = Extract<WebviewToExtensionMessage, { type: `hub-${string}` }>
const str: Check = v => typeof v === 'string'
const bool: Check = v => typeof v === 'boolean'
const num: Check = v => typeof v === 'number' && Number.isFinite(v)
const opt = (f: Check): Check => v => v === undefined || f(v)
const oneOf = (...xs: unknown[]): Check => v => xs.includes(v)
const any = (...fs: Check[]): Check => v => fs.some(f => f(v))
const obj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const flags = (v: unknown) => obj(v) && Object.values(v).every(bool)
const profile: Check = v => obj(v) && flags(v.plugins) && flags(v.skills)
const SETTING_KEYS: SettingKey[] = ['autoCompactEnabled', 'autoCompactWindow', 'autoContinueAtUsageLimit', 'remoteControlAtStartup', 'agentPushNotifEnabled', 'inputNeededNotifEnabled', 'model', 'effortLevel', 'tui', 'statusLine']
const SWITCHBOARD_KEYS: SwitchboardKey[] = ['hooks', 'statusBar', 'idleMinutes', 'brief', 'askBrain', 'syncRules']

/** Every field of every hub command, as protocol.ts declares it; the runner trusts these types. */
const SHAPES: { [T in HubCommand['type']]: { [K in Exclude<keyof Extract<HubCommand, { type: T }>, 'type'>]-?: Check } } = {
  'hub-refresh': {},
  'hub-send': { sessionId: str, text: str },
  'hub-rc': { on: bool, sessionId: opt(str) },
  'hub-open-url': { url: str },
  'hub-web': { phone: bool },
  'hub-stop-server': { pid: num, confirmed: opt(bool) },
  'hub-toggle': { kind: oneOf('mod', 'plugin', 'skill'), name: str, enabled: bool },
  'hub-setting': { key: oneOf(...SETTING_KEYS), value: any(bool, num, str, oneOf(null)) },
  'hub-switchboard': { key: oneOf(...SWITCHBOARD_KEYS), value: any(bool, num, str, oneOf(null)) },
  'hub-vscode': { action: oneOf('reload', 'restart') },
  'hub-compact': { sessionId: str },
  'hub-open-project': { path: str, newWindow: bool },
  'hub-clone': { repo: str, newWindow: bool },
  'hub-new-chat': { path: str, text: opt(str), remote: bool, branch: opt(str), ai: opt(isAi), tools: opt(profile) },
  'hub-pick-tools': { text: str },
  'hub-chat-tools': { sessionId: str, tools: profile },
  'hub-star': { sessionId: str, ai: isAi, on: bool },
  'hub-resume': { sessionId: str, ai: isAi },
  'hub-open-note': { sessionId: str },
  'hub-focus-chat': { sessionId: str },
  'hub-keep': { onFull: opt(oneOf('compact', 'fresh')), freshBranch: opt(bool) },
  'hub-aws-login': { profile: str, chrome: opt(str) },
  'hub-aws-default': { profile: str },
  'hub-aws-label': { profile: str, label: str },
  'hub-aws-add': { profile: str, region: str, chrome: opt(str) },
  'hub-aws-window': { profile: any(str, oneOf(null)) },
  'hub-aws-check': {},
  'hub-aws-delete': { profile: str },
  'hub-login-app-add': { name: str, url: str },
  'hub-login-add': { app: str, label: str, url: str, chrome: opt(str) },
  'hub-login-open': { app: str, id: str, chrome: opt(str) },
  'hub-login-active': { app: str, id: str },
  'hub-login-rename': { app: str, id: str, label: str },
  'hub-login-delete': { app: str, id: str },
  'hub-login-app-delete': { app: str },
  'hub-kit-export': {},
  'hub-rules-sync': {},
  'hub-role-model': { role: str, model: oneOf(...ROLE_MODELS) },
  'hub-rc-server': { folder: str, on: bool },
  'hub-handoff': { sessionId: str },
  'hub-changes': { sessionId: str },
  'hub-open-diff': { sessionId: str, file: str },
  'hub-search': { q: str },
  'hub-dev-start': { folder: str },
  'hub-dev-stop': { folder: str },
  'hub-awake': { on: bool },
}

/** Why a command is refused, or undefined when every field has its declared type. */
export function commandProblem(c: unknown): string | undefined {
  if (!obj(c) || typeof c.type !== 'string') return 'no type'
  const shape = Object.hasOwn(SHAPES, c.type) ? (SHAPES as Record<string, Record<string, Check>>)[c.type] : undefined
  if (!shape) return `unknown command ${c.type}`
  const bad = Object.entries(shape).find(([k, ok]) => !ok(c[k]))
  return bad ? `${c.type}: ${bad[0]} is missing or the wrong type` : undefined
}

/** The runner's answer as a reply: a string is the reason it refused. */
export const ranReply = (r: boolean | string): HubReply => (typeof r === 'string' ? { status: 400, body: r } : { status: r ? 204 : 400, body: '' })

/** Only /hub/ask answers later; `ask` is swapped in tests so none spends. */
export function handleHub(hub: HubService, method: string | undefined, url: string | undefined, body: string, ask = askBrain): HubReply | Promise<HubReply> | undefined {
  const u = new URL(url ?? '/', 'http://127.0.0.1')
  if (u.pathname !== '/hub' && !u.pathname.startsWith('/hub/')) return undefined

  if (method === 'POST' && u.pathname === '/hub') {
    let parsed: unknown
    try {
      parsed = JSON.parse(body)
    } catch {
      return { status: 400, body: '' }
    }
    return { status: hub.ingest(parsed) ? 204 : 403, body: '' }
  }

  if (method === 'GET' && u.pathname === '/hub/inbox') {
    if (!hub.isToken(u.searchParams.get('token'))) return { status: 403, body: '' }
    const items = hub.take(u.searchParams.get('session') ?? '')
    return { status: 200, body: JSON.stringify(items), contentType: 'application/json' }
  }

  if (method === 'GET' && u.pathname === '/hub/keep') {
    if (!hub.isToken(u.searchParams.get('token'))) return { status: 403, body: '' }
    const { onFull, freshBranch } = hub.get().keep
    return { status: 200, body: JSON.stringify({ onFull, freshBranch }), contentType: 'application/json' }
  }

  if (method === 'GET' && (u.pathname === '/hub/brief' || u.pathname === '/hub/ask')) {
    if (!hub.isToken(u.searchParams.get('token'))) return { status: 403, body: '' }
    const cwd = u.searchParams.get('cwd') ?? ''
    if (!cwd) return { status: 400, body: '' }
    const { brief: on, askBrain: asks } = hub.get().controls.switchboard
    if (u.pathname === '/hub/brief') return text(on ? brief(hub.get(), cwd, u.searchParams.get('session') ?? '') : '')
    const q = u.searchParams.get('q')?.trim()
    if (!asks) return text('Ask the brain is off in Switchboard, Controls.')
    if (!q) return { status: 400, body: '' }
    return ask(q, askContext(hub.get(), cwd, hub.stopped())).then(text)
  }

  if (method === 'GET' && u.pathname === '/hub/state') {
    if (!hub.isToken(u.searchParams.get('token'))) return { status: 403, body: '' }
    hub.stateReadAt = Date.now()
    return { status: 200, body: JSON.stringify({ ...hub.get(), phoneUrl: null }), contentType: 'application/json' }
  }

  if (method === 'POST' && u.pathname === '/hub/command') {
    if (!hub.isToken(u.searchParams.get('token'))) return { status: 403, body: '' }
    if (!hub.runner) return { status: 503, body: '' }
    let c: unknown
    try { c = JSON.parse(body) } catch { return { status: 400, body: '' } }
    const problem = commandProblem(c)
    if (problem) return { status: 400, body: problem }
    try {
      const r = hub.runner(c as { type: string })
      return r instanceof Promise ? r.then(ranReply, err => ({ status: 500, body: (err as Error).message })) : ranReply(r)
    } catch (err) {
      return { status: 500, body: (err as Error).message }
    }
  }

  return { status: 404, body: '' }
}
