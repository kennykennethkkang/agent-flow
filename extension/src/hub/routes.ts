/**
 * The hook server's /hub routes, as a pure function so tests need no socket.
 *
 * POST /hub         a usage mod's feed post (token in the body)
 * GET  /hub/inbox   a chat collects what the panel queued for it (token in the query)
 * GET  /hub/keep    what a full chat does: always continue in a fresh chat (token in the query)
 * GET  /hub/brief   the brief for a new chat in ?cwd= (token in the query); its own project only
 * GET  /hub/ask     ?cwd=&q=: one paid Haiku answer from that project's board (token in the query)
 * GET  /hub/holds   204 when this window holds the chat's terminal, so the app routes its commands here
 * GET  /hub/state   the whole HubState, for the standalone web app's proxy (token in the query); no thisWindow, it is no window
 * POST /hub/command a hub-* command, run as the panel's (token in the query)
 * POST /hub/device  the standalone app passes on a device asking to sign in, or that it was answered (token in the query)
 * POST /hub/question       the ask tool's question {sessionId, id, questions}; GET ?id= holds 25 s for its answer (204: ask again, 410: gone);
 *      /hub/question/done  ?id=: answered in the terminal (token in the query)
 * POST /hub/todo    the ask server's todo_add or todo_done {op, cwd, text?, id?, before?, session?}; answers a line for the chat (token in the query)
 * POST /hub/tool-on the ask server's tool_on {session, name}: a plugin or skill on for that chat; answers a line for it (token in the query)
 * Anything outside /hub answers undefined and stays with the hook handler.
 */
import { askBrain, askContext, brief } from './brain'
import type { HubService } from './hub-service'
import type { WebviewToExtensionMessage } from '../protocol'
import type { GitOp, SettingKey, SwitchboardKey } from './types'
import { isAi } from './ais'
import { ROLE_MODELS } from './roles'
import { questionAsk } from './progress'
import { closeQuestion, openQuestion, questionOf, waitQuestion } from './questions'
import { todoTool, type TodoCall } from './todo'
import { toolOn } from './tools'

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
// One answer per question, at most four: an option index, several for a multiSelect one, or Other text.
// The text goes into a terminal; askKeys cleans and cuts it, this only stops a huge body.
const index = (x: unknown) => Number.isInteger(x) && (x as number) >= 0 && (x as number) < 10
const indexes = (x: unknown) => Array.isArray(x) && x.length <= 10 && x.every(index)
const other = (x: unknown) => obj(x) && typeof x.other === 'string' && x.other.length <= 500 && (x.picks === undefined || indexes(x.picks))
const picks: Check = v => Array.isArray(v) && v.length > 0 && v.length <= 4 && v.every(x => index(x) || indexes(x) || other(x))
const flags = (v: unknown) => obj(v) && Object.values(v).every(bool)
const profile: Check = v => obj(v) && flags(v.plugins) && flags(v.skills) && (v.assets === undefined || flags(v.assets))
const SETTING_KEYS: SettingKey[] = ['autoCompactEnabled', 'autoCompactWindow', 'autoContinueAtUsageLimit', 'remoteControlAtStartup', 'agentPushNotifEnabled', 'inputNeededNotifEnabled', 'model', 'effortLevel', 'tui', 'statusLine']
const GIT_OPS: GitOp[] = ['sync', 'commit', 'commit-push', 'switch', 'create', 'undo', 'discard', 'pr', 'stash', 'pop', 'delete-branch', 'rerun']
const paths: Check = v => Array.isArray(v) && v.length <= 1000 && v.every(x => typeof x === 'string')
// Typed by Kenneth; todo.ts cuts it to 300 after cleaning, this only stops a huge body.
const todoText: Check = v => typeof v === 'string' && v.length <= 2000
const SWITCHBOARD_KEYS: SwitchboardKey[] = ['hooks', 'statusBar', 'idleMinutes', 'brief', 'askBrain', 'syncRules', 'accessNote', 'name']

/** Every field of every hub command, as protocol.ts declares it; the runner trusts these types. */
const SHAPES: { [T in HubCommand['type']]: { [K in Exclude<keyof Extract<HubCommand, { type: T }>, 'type'>]-?: Check } } = {
  'hub-refresh': {},
  'hub-send': { sessionId: str, text: str },
  'hub-answer': { sessionId: str, askId: str, choice: picks },
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
  'hub-pick-tools': { text: str, path: opt(str) },
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
  'hub-login-open': { app: str, id: opt(str), chrome: opt(str), folder: opt(str) },
  'hub-login-link': { folder: str, app: str, login: any(str, oneOf(null)) },
  'hub-browser': { folder: str, chrome: any(str, oneOf(null)) },
  'hub-login-active': { app: str, id: str },
  'hub-login-rename': { app: str, id: str, label: str },
  'hub-login-delete': { app: str, id: str },
  'hub-login-app-delete': { app: str },
  'hub-kit-export': {},
  'hub-setup': {},
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
  'hub-device': { id: str, allow: bool },
  'hub-git': { sessionId: str, op: oneOf(...GIT_OPS), files: opt(paths), summary: opt(str), description: opt(str), branch: opt(str), stash: opt(bool), confirmed: opt(bool) },
  'hub-todo-add': { path: str, text: todoText },
  'hub-todo-edit': { path: str, id: str, text: todoText },
  'hub-todo-remove': { path: str, id: str },
  'hub-todo-restore': { path: str, id: str },
  'hub-todo-run': { path: str, ids: v => Array.isArray(v) && v.length > 0 && v.length <= 50 && v.every(x => typeof x === 'string'), to: opt(str) },
  'hub-todo-sync': { path: str, on: bool },
  'hub-todo-replace': { path: str, remote: v => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v) },
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

/** Only /hub/ask answers later; `ask` and `todo` are swapped in tests so none spends or writes. */
export function handleHub(hub: HubService, method: string | undefined, url: string | undefined, body: string, ask = askBrain, todo: (c: TodoCall & { cwd: string }) => Promise<string> = todoTool): HubReply | Promise<HubReply> | undefined {
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

  if (method === 'GET' && u.pathname === '/hub/holds') {
    if (!hub.isToken(u.searchParams.get('token'))) return { status: 403, body: '' }
    const id = u.searchParams.get('session') ?? ''
    return Promise.resolve(hub.holds?.(id) ?? false).then(yes => ({ status: yes ? 204 : 404, body: '' }))
  }

  if (method === 'GET' && u.pathname === '/hub/state') {
    if (!hub.isToken(u.searchParams.get('token'))) return { status: 403, body: '' }
    hub.stateReadAt = Date.now()
    return { status: 200, body: JSON.stringify({ ...hub.get(), phoneUrls: null, thisWindow: undefined, devices: undefined }), contentType: 'application/json' }
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

  if (u.pathname === '/hub/question' || u.pathname === '/hub/question/done') {
    if (!hub.isToken(u.searchParams.get('token'))) return { status: 403, body: '' }
    const id = u.searchParams.get('id') ?? ''
    if (method === 'POST' && u.pathname === '/hub/question') {
      let b: unknown
      try { b = JSON.parse(body) } catch { return { status: 400, body: '' } }
      const ask = obj(b) && typeof b.id === 'string' && /^[0-9a-f]{32}$/.test(b.id) && typeof b.sessionId === 'string' ? questionAsk(b.id, b) : undefined
      if (!ask || !obj(b)) return { status: 400, body: '' }
      // sub: the lead's own calls leave it, like a subagent's prompt.
      const hubAsk = { ...ask, tool: 'ask', via: 'hub' as const, sub: true as const }
      openQuestion(hubAsk.id, b.sessionId as string, hubAsk)
      hub.asked(b.sessionId as string, hubAsk)
      return { status: 204, body: '' }
    }
    if (method === 'GET' && u.pathname === '/hub/question') {
      const q = questionOf(id)
      if (!q) return { status: 410, body: '' }
      // Only an unanswered one goes back on the card; one handed over leaves it.
      if (!q.choice) hub.asked(q.sessionId, q.ask)
      return waitQuestion(id, 25_000)!.then(choice => {
        if (!choice) return { status: 204, body: '' }
        hub.answered(q.sessionId, id)
        return { status: 200, body: JSON.stringify({ choice }), contentType: 'application/json' }
      })
    }
    if (method === 'POST' && u.pathname === '/hub/question/done') {
      const sessionId = closeQuestion(id)
      if (sessionId) hub.answered(sessionId, id)
      return { status: 204, body: '' }
    }
  }

  if (method === 'POST' && u.pathname === '/hub/tool-on') {
    if (!hub.isToken(u.searchParams.get('token'))) return { status: 403, body: '' }
    let b: unknown
    try { b = JSON.parse(body) } catch { return { status: 400, body: '' } }
    if (!obj(b) || typeof b.session !== 'string' || typeof b.name !== 'string' || !b.name.trim() || b.name.length > 200) return { status: 400, body: 'session and name only' }
    return toolOn(hub, b.session, b.name).then(text, err => ({ status: 400, body: (err as Error).message }))
  }

  if (method === 'POST' && u.pathname === '/hub/todo') {
    if (!hub.isToken(u.searchParams.get('token'))) return { status: 403, body: '' }
    let b: unknown
    try { b = JSON.parse(body) } catch { return { status: 400, body: '' } }
    const field = (v: unknown) => v === undefined || (typeof v === 'string' && v.length <= 2000)
    if (!obj(b) || (b.op !== 'add' && b.op !== 'done') || typeof b.cwd !== 'string' || !b.cwd || !['text', 'id', 'before', 'session'].every(k => field(b[k]))) return { status: 400, body: 'op, cwd and string fields only' }
    const c = Object.fromEntries(['op', 'cwd', 'text', 'id', 'before', 'session'].filter(k => b[k] !== undefined).map(k => [k, b[k]])) as TodoCall & { cwd: string }
    return todo(c).then(text, err => ({ status: 400, body: (err as Error).message }))
  }

  if (method === 'POST' && u.pathname === '/hub/device') {
    if (!hub.isToken(u.searchParams.get('token'))) return { status: 403, body: '' }
    let d: unknown
    try { d = JSON.parse(body) } catch { return { status: 400, body: '' } }
    if (!deviceShape(d)) return { status: 400, body: '' }
    if (!hub.onDevice) return { status: 503, body: '' }
    hub.onDevice(d)
    return { status: 204, body: '' }
  }

  return { status: 404, body: '' }
}

// Short strings only: they end up in a VS Code prompt.
const short = (v: unknown) => typeof v === 'string' && v.length > 0 && v.length <= 64
function deviceShape(d: unknown): d is Parameters<NonNullable<HubService['onDevice']>>[0] {
  if (!obj(d) || typeof d.id !== 'string' || !/^[0-9a-f]{32}$/.test(d.id)) return false
  if ('done' in d) return d.done === true
  return short(d.ip) && short(d.ua) && (d.network === 'Wi-Fi' || d.network === 'Tailscale') && Number.isInteger(d.port) && (d.port as number) > 0 && (d.port as number) < 65536
}
