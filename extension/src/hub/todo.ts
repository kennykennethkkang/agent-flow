/**
 * Per-project to-do list of future work: Kenneth's items, what finished chats left, and prerequisites chats add. A repo keeps it as todo.json in a commit on refs/switchboard/todo,
 * synced through origin by fetch, merge and a plain push; branches, the index, the working tree and HEAD
 * are never touched. A folder with no git keeps them in ~/.claude/switchboard/todo/<sha>.json, unsynced.
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { execFile } from 'child_process'
import { ghPath, git, repoRoot } from './git'
import { cloneTarget, repoTop } from './projects'
import { plainText } from './progress'
import { writeJsonAtomic } from '../hook-entries'
import { foldPathCase } from '../fs-utils'
import { createLogger } from '../logger'
import { hub } from './hub-service'
import { quickAsk } from './brain'
import type { ChatProgress, TickedItem, TodoDoc, TodoItem, TodoSync } from './types'

export const TODO_REF = 'refs/switchboard/todo'
const REMOTE_REF = 'refs/switchboard/todo-remote'
const FILE = 'todo.json'
const log = createLogger('Todo')
const NO_REF = '0'.repeat(40)
const UNREADABLE = 'remote list unreadable'
const TEXT_MAX = 300
const ID = () => crypto.randomBytes(4).toString('hex')
const ID_OK = /^[A-Za-z0-9_-]{1,64}$/
const okId = (id: unknown): id is string => typeof id === 'string' && ID_OK.test(id) && id !== '__proto__'
// A ticked item put back: its own tombstone, so a merge never shows it as ticked again.
const BACK = (id: string) => `${id}.back`
const okKey = (k: string) => okId(k.endsWith('.back') ? k.slice(0, -5) : k)
const TICKED_MAX = 10
// Past these a change that grows the list is refused; git's output buffer is 8 MB.
const MAX_ITEMS = 500, MAX_BYTES = 1 << 20
let host: string | undefined
/**
 * This machine, on the items it starts, so another device's chats are never judged gone here. A random id
 * made once in ~/.claude/switchboard/host-id: the hostname changes between networks on macOS.
 */
export function hostId(): string {
  if (host) return host
  const file = path.join(os.homedir(), '.claude', 'switchboard', 'host-id')
  const read = () => { try { const t = fs.readFileSync(file, 'utf8').trim(); return /^[0-9a-f]{16}$/.test(t) ? t : undefined } catch { return undefined } }
  host = read()
  if (!host) {
    const made = crypto.randomBytes(8).toString('hex')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    // wx: another window that wrote first wins, and both use its id.
    try { fs.writeFileSync(file, `${made}\n`, { flag: 'wx' }); host = made } catch { host = read() ?? made }
  }
  return host
}
// Commits on the ref are Switchboard's, never signed (no 1Password prompt on a list change).
const AS = ['-c', 'user.name=Switchboard', '-c', 'user.email=switchboard@localhost']

export const emptyDoc = (): TodoDoc => ({ version: 1, todo: [], removed: {} })
const clean = (text: string) => plainText(text).replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX)

/** Only well formed rows with plain ids survive; the remote's copy is anyone's. Bad JSON throws, so nothing writes over it. */
export function parseDoc(raw: string): TodoDoc {
  const j = JSON.parse(raw) as Record<string, unknown>
  const rows = <T>(v: unknown, extras: string[]) => (Array.isArray(v) ? v : []).flatMap(x => {
    const o = (x ?? {}) as Record<string, unknown>
    if (!okId(o.id) || typeof o.text !== 'string' || typeof o.at !== 'number') return []
    const more = Object.fromEntries(extras.flatMap(k => (typeof o[k] === 'string' ? [[k, (o[k] as string).slice(0, 64)]] : [])))
    return [{ id: o.id, text: clean(o.text), at: o.at, ...more } as T]
  })
  const removed = Object.fromEntries(Object.entries((j?.removed ?? {}) as object).filter(([id, at]) => okKey(id) && typeof at === 'number'))
  // Older docs keep finished chats' items in left; they are to-do items now, and an older device may still write them.
  const todo = rows<TodoItem>(j?.todo, ['chat', 'host', 'from', 'before'])
  const ids = new Set(todo.map(t => t.id))
  const left = rows<TodoItem>(j?.left, ['from']).filter(l => !ids.has(l.id) && !Object.hasOwn(removed, l.id))
  return withTicked({ version: 1, todo: [...todo, ...left], removed }, rows<TickedItem>(j?.ticked, ['by', 'from', 'before']))
}

/** d with ticked set to xs, newest first and capped; no field when empty. */
function withTicked(d: TodoDoc, xs: TickedItem[]): TodoDoc {
  const { ticked: _t, ...rest } = d
  const keep = [...xs].sort((a, b) => b.at - a.at).slice(0, TICKED_MAX)
  return keep.length ? { ...rest, ticked: keep } : rest
}

// Both devices have synced long before a tombstone is this old.
const TOMBSTONE_MS = 90 * 24 * 60 * 60 * 1000

/** Union by id; an id removed on either side is gone; the same id on both sides keeps the newer at. */
export function mergeDocs(a: TodoDoc, b: TodoDoc, now = Date.now()): TodoDoc {
  const removed = new Map<string, number>()
  for (const [id, at] of [...Object.entries(a.removed), ...Object.entries(b.removed)]) if (now - at < TOMBSTONE_MS) removed.set(id, Math.max(at, removed.get(id) ?? 0))
  const pick = <T extends { id: string; at: number }>(xs: T[], ys: T[]) => {
    const m = new Map<string, T>()
    for (const x of [...xs, ...ys]) { const o = m.get(x.id); if (!o || x.at > o.at) m.set(x.id, x) }
    return [...m.values()].filter(x => !removed.has(x.id))
  }
  // Ticked ids are tombstoned as items, so only the put-back tombstone drops one.
  const ticked = new Map<string, TickedItem>()
  for (const x of [...a.ticked ?? [], ...b.ticked ?? []]) {
    const o = ticked.get(x.id)
    if (!removed.has(BACK(x.id)) && now - x.at < TOMBSTONE_MS && (!o || x.at > o.at)) ticked.set(x.id, x)
  }
  return withTicked({ version: 1, todo: pick(a.todo, b.todo), removed: Object.fromEntries(removed) }, [...ticked.values()])
}

/** The Put back link: the item is open again under a new id (its old one stays tombstoned on every device). */
export function restoreTicked(d: TodoDoc, id: string, now = Date.now(), newId = ID()): TodoDoc {
  const t = d.ticked?.find(x => x.id === id)
  if (!t) return d
  const { id: _i, at: _a, by: _b, text, ...more } = t
  const out = withTicked({ ...d, removed: { ...d.removed, [BACK(id)]: now } }, d.ticked!.filter(x => x !== t))
  return addTodo(out, text, now, newId, more)
}

export function addTodo(d: TodoDoc, text: string, now = Date.now(), id = ID(), more: Partial<TodoItem> = {}): TodoDoc {
  const t = clean(text)
  return t ? { ...d, todo: [...d.todo, { id, text: t, at: now, ...more }] } : d
}
export function editTodo(d: TodoDoc, id: string, text: string, now = Date.now()): TodoDoc {
  const t = clean(text)
  return t ? { ...d, todo: d.todo.map(x => x.id === id ? { ...x, text: t, at: now } : x) } : d
}
export function removeItem(d: TodoDoc, id: string, now = Date.now()): TodoDoc {
  if (!okId(id)) return d
  return { ...d, todo: d.todo.filter(x => x.id !== id), removed: { ...d.removed, [id]: now } }
}
/** Done: off the list and into the finished archive; by is the chat that did it, none for the user. */
export function finishItem(d: TodoDoc, id: string, by?: string, now = Date.now()): TodoDoc {
  const t = d.todo.find(x => x.id === id)
  if (!t) return d
  const done: TickedItem = { id, text: t.text, at: now, ...(by ? { by } : {}), ...(t.from ? { from: t.from } : {}), ...(t.before ? { before: t.before } : {}) }
  return removeItem(withTicked(d, [done, ...d.ticked ?? []]), id, now)
}
export function startTodo(d: TodoDoc, id: string, chat: string | undefined, now = Date.now()): TodoDoc {
  return { ...d, todo: d.todo.map(x => { if (x.id !== id) return x; const { chat: _c, host: _h, ...rest } = x; return { ...rest, at: now, ...(chat ? { chat, host: hostId() } : {}) } }) }
}

/** A handoff: the item follows its chat to the fresh one. */
export function moveChat(d: TodoDoc, from: string, to: string, now = Date.now()): TodoDoc {
  const hit = d.todo.filter(x => x.chat === from)
  return hit.reduce((out, x) => startTodo(out, x.id, to, now), d)
}

// A chat started from an item takes a while to show in the chat list.
const START_GRACE_MS = 2 * 60_000
/** Items this machine started whose chat is no longer live here go back to not started. */
export function clearGone(d: TodoDoc, live: Set<string>, now = Date.now()): TodoDoc {
  const gone = d.todo.filter(x => x.chat && x.host === hostId() && !live.has(x.chat) && now - x.at > START_GRACE_MS)
  return gone.reduce((out, x) => startTodo(out, x.id, undefined, now), d)
}

/** The ids of known items an answer names, each as a whole word. */
export function parseDoneIds(answer: string, ids: string[]): string[] {
  const words = new Set(answer.toLowerCase().split(/[^a-z0-9_-]+/))
  return ids.filter(id => words.has(id.toLowerCase()))
}

export function finishPrompt(left: TodoItem[], p: ChatProgress): string {
  const said = [...(p.report?.done ?? []), ...(p.asked ?? [])].map(s => `- ${s}`).join('\n')
  return `Open to-do items for a project, one per line as "id: text":\n${left.map(l => `${l.id}: ${l.text}`).join('\n')}\n\n`
    + `A coding chat in the project just finished. What it did and what it was asked:\n${said}\n\n`
    + 'Which open items are now done? Answer with their ids only, comma separated, or "none".'
}

/** A chat's standup Left items, cleaned, once each. Its open tasks stay on its card: the to-do is for later work. */
const leftTexts = (p: ChatProgress) => [...new Set((p.report?.left ?? []).map(clean).filter(Boolean))]

const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
/** Whether a Left line and an item say the same thing: one holds the other, or most of the shorter one's longer words are in both. */
export function mentions(a: string, b: string): boolean {
  const x = words(a), y = words(b)
  if (!x || !y) return false
  if (x.includes(y) || y.includes(x)) return true
  const [short, long] = x.length < y.length ? [x, y] : [y, x]
  const key = short.split(' ').filter(w => w.length > 3), has = new Set(long.split(' '))
  // ponytail: word overlap, not meaning; the quick model call in todoFinished covers the rest.
  return key.length >= 2 && key.filter(w => has.has(w)).length / key.length >= 0.7
}

/** This chat's lines as new items, skipping a tombstone, a known id and text an open item already says. */
function addLeft(d: TodoDoc, p: ChatProgress, texts: string[], now: number): TodoDoc {
  const add: TodoItem[] = []
  for (const text of texts) {
    const id = leftId(p.sessionId, text)
    if (Object.hasOwn(d.removed, id) || [...d.todo, ...add].some(l => l.id === id || mentions(l.text, text))) continue
    add.push({ id, text, at: now, from: p.sessionId })
  }
  return add.length ? { ...d, todo: [...d.todo, ...add] } : d
}

/**
 * A chat ended (SessionEnd) without reaching Done: its standup Left lines join the to-do;
 * its items go back to not started. A handoff never comes here.
 */
export function afterEnd(d: TodoDoc, p: ChatProgress, now = Date.now()): TodoDoc {
  if (p.state === 'done') return d
  let out = d
  for (const t of d.todo.filter(x => x.chat === p.sessionId)) out = startTodo(out, t.id, undefined, now)
  return addLeft(out, p, leftTexts(p), now)
}

const leftId = (chat: string, text: string) => crypto.createHash('sha1').update(`${chat}\n${text}`).digest('hex').slice(0, 8)

/**
 * A chat reached Done: the ids the model named are done; items it worked on are done unless its Left
 * mentions them (then open again, not started); its Left lines replace the ones it listed before.
 */
export function afterFinish(d: TodoDoc, p: ChatProgress, doneIds: string[], now = Date.now()): TodoDoc {
  const texts = leftTexts(p)
  const fresh = new Set(texts.map(t => leftId(p.sessionId, t)))
  // Only the model's guesses can be put back; the user's Done and the chat's own items cannot.
  const hit = d.todo.filter(x => doneIds.includes(x.id))
  let out = hit.length ? withTicked(d, [...hit.map(x => ({ id: x.id, text: x.text, at: now, by: p.sessionId, ...(x.from ? { from: x.from } : {}), ...(x.before ? { before: x.before } : {}) })), ...d.ticked ?? []]) : d
  for (const id of doneIds) out = removeItem(out, id, now)
  for (const l of out.todo) if (l.from === p.sessionId && !l.chat && l.id === leftId(p.sessionId, l.text) && !fresh.has(l.id)) out = removeItem(out, l.id, now)
  for (const t of out.todo.filter(x => x.chat === p.sessionId)) out = texts.some(l => mentions(l, t.text)) ? startTodo(out, t.id, undefined, now) : removeItem(out, t.id, now)
  return addLeft(out, p, texts, now)
}

/** The picked items with their open prerequisites first, each once, in list order. */
export function runOrder(todo: TodoItem[], ids: string[]): TodoItem[] {
  const out: TodoItem[] = [], seen = new Set<string>()
  const visit = (t: TodoItem) => {
    if (seen.has(t.id)) return
    seen.add(t.id)
    for (const pre of todo.filter(x => x.before === t.id)) visit(pre)
    out.push(t)
  }
  for (const t of todo) if (ids.includes(t.id)) visit(t)
  return out
}

/** The prompt a run sends: the items numbered, then how to handle prerequisites and closing. */
export function runMessage(items: TodoItem[]): string {
  const lines = items.map((t, i) => {
    const n = t.before ? items.findIndex(x => x.id === t.before) : -1
    return `${i + 1}. ${t.text} (id ${t.id}${n >= 0 ? `, needed first for ${n + 1}` : ''})`
  })
  return ['Switchboard to-do, in this order:', ...lines, '',
    "Do prerequisites first. When you find something that must be done before an item, add it to the to-do with the switchboard todo_add tool (before_id: that item's id) as a prerequisite, do it, then continue. Mark each item done with todo_done (its id) when it is finished."].join('\n')
}

/** An open item by id, else by its text (exact, else the one item holding it); throws when none or several. */
export function findItem(d: TodoDoc, key: string): TodoItem {
  const k = key.trim().toLowerCase()
  const hit = d.todo.find(t => t.id === key.trim()) ?? d.todo.find(t => t.text.toLowerCase() === k)
  if (hit) return hit
  const some = k ? d.todo.filter(t => t.text.toLowerCase().includes(k)) : []
  if (some.length === 1) return some[0]
  throw new Error(some.length ? `"${key}" matches ${some.length} items; use the id` : `no open to-do item matches "${key}"`)
}

/** A todo_add or todo_done call from a chat (the ask server's MCP tools). session: the calling chat. */
export type TodoCall = { op: 'add' | 'done'; text?: string; id?: string; before?: string; session?: string }

/** What the call makes of the doc, and the line the tool answers with. A prerequisite is in progress where its item is. */
export function toolStep(d: TodoDoc, c: TodoCall, now = Date.now(), id = ID()): { doc: TodoDoc; said: string } {
  if (c.op === 'done') {
    const t = findItem(d, c.id ?? c.text ?? '')
    return { doc: finishItem(d, t.id, c.session, now), said: `Done: ${t.text}` }
  }
  const text = clean(c.text ?? '')
  if (!text) throw new Error('text is empty')
  const to = c.before ? findItem(d, c.before) : undefined
  const more: Partial<TodoItem> = { ...(to ? { before: to.id } : {}), ...(to?.chat ? { chat: to.chat, host: to.host } : {}), ...(c.session ? { from: c.session.slice(0, 64) } : {}) }
  return { doc: addTodo(d, text, now, id, more), said: `Added ${id}: ${text}${to ? ` (needed first for ${to.id})` : ''}` }
}

/** Where a folder's lists live: its repo's ref, else a file. */
export type TodoStore = { root?: string; file?: string }

export async function storeFor(folder: string, dir = path.join(os.homedir(), '.claude', 'switchboard', 'todo')): Promise<TodoStore> {
  const root = fs.existsSync(folder) ? await repoRoot(folder) : undefined
  return root ? { root } : { file: path.join(dir, `${crypto.createHash('sha1').update(folder).digest('hex')}.json`) }
}

const revParse = async (root: string, ref: string) => { const r = await git(root, ['rev-parse', '--verify', '-q', `${ref}^{commit}`]); return r.ok ? r.out.trim() : undefined }
/** No ref yet is an empty list; a ref that cannot be read throws, so no write replaces it with an empty one. */
const docAt = async (root: string, commit: string | undefined) => {
  if (!commit) return emptyDoc()
  const r = await git(root, ['cat-file', 'blob', `${commit}:${FILE}`])
  if (!r.ok) throw new Error(`could not read the to-do list (${r.err.trim().split('\n')[0]})`)
  return parseDoc(r.out)
}

const size = (d: TodoDoc) => JSON.stringify(d).length
const tooBig = (d: TodoDoc) => d.todo.length > MAX_ITEMS || size(d) > MAX_BYTES
/** What fn makes of was; a change that grows a list past the cap is refused. */
function grown(was: TodoDoc, fn: (d: TodoDoc) => TodoDoc): TodoDoc {
  const next = fn(was)
  if (tooBig(next) && size(next) > size(was)) throw new Error(`the to-do list is full (${MAX_ITEMS} items)`)
  return next
}

/** A commit holding only todo.json, on the given parents; undefined when git refused. */
async function commitDoc(root: string, d: TodoDoc, parents: string[]): Promise<string | undefined> {
  const blob = await git(root, ['hash-object', '-w', '--stdin'], undefined, `${JSON.stringify(d, null, 1)}\n`)
  if (!blob.ok) return undefined
  const tree = await git(root, ['mktree'], undefined, `100644 blob ${blob.out.trim()}\t${FILE}\n`)
  if (!tree.ok) return undefined
  const c = await git(root, [...AS, 'commit-tree', '--no-gpg-sign', tree.out.trim(), ...parents.flatMap(p => ['-p', p]), '-m', 'Switchboard to-do'])
  return c.ok ? c.out.trim() : undefined
}

/** Moves the ref only if it still points at old, so two windows never lose each other's change. */
const setRef = async (root: string, next: string, old: string | undefined) => (await git(root, ['update-ref', TODO_REF, next, old ?? NO_REF])).ok

export async function readDoc(s: TodoStore): Promise<TodoDoc> {
  if (s.root) return docAt(s.root, await revParse(s.root, TODO_REF))
  let raw: string
  try { raw = await fs.promises.readFile(s.file!, 'utf8') } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyDoc(); throw err }
  return parseDoc(raw)
}

/** Applies fn to the latest doc and writes it; with git, again on a lost race (another window wrote first). */
export async function updateDoc(s: TodoStore, fn: (d: TodoDoc) => TodoDoc): Promise<TodoDoc> {
  if (!s.root) {
    const was = await readDoc(s), next = grown(was, fn)
    if (JSON.stringify(next) !== JSON.stringify(was)) writeJsonAtomic(s.file!, next)
    return next
  }
  for (let i = 0; i < 3; i++) {
    const old = await revParse(s.root, TODO_REF)
    const was = await docAt(s.root, old), next = grown(was, fn)
    if (JSON.stringify(next) === JSON.stringify(was)) return was
    const c = await commitDoc(s.root, next, old ? [old] : [])
    if (!c) throw new Error('git could not write the to-do list')
    if (await setRef(s.root, c, old)) return next
  }
  throw new Error('the to-do list kept changing under us')
}

const hasOrigin = async (root: string) => !!(await git(root, ['config', '--get', 'remote.origin.url'])).out.trim()
const isAncestor = async (root: string, a: string, b: string) => (await git(root, ['merge-base', '--is-ancestor', a, b])).ok

/** Pushes the ref to origin; never forced, no pre-push hooks. A string says why it did not go. */
export async function pushTodo(root: string): Promise<string | undefined> {
  if (!(await hasOrigin(root))) return undefined
  const r = await git(root, ['push', '--no-verify', '-q', 'origin', `${TODO_REF}:${TODO_REF}`], 60_000)
  return r.ok ? undefined : r.err.trim().split('\n')[0] || 'push failed'
}

const OPT_IN = path.join(os.homedir(), '.claude', 'switchboard', 'todo-sync.json')

/** Folders the user chose to sync even though their repo is not known to be private. */
export function readOptIn(file = OPT_IN): Record<string, true> {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
    return Object.fromEntries(Object.entries(j).filter(([k, v]) => v === true && k !== '__proto__')) as Record<string, true>
  } catch { return {} }
}

export function setOptIn(folder: string, on: boolean, file = OPT_IN): void {
  const o = new Map(Object.entries(readOptIn(file)))
  if (on) o.set(folder, true); else o.delete(folder)
  writeJsonAtomic(file, Object.fromEntries(o))
}

/** owner/repo of a GitHub remote, by cloneTarget's rules. */
export const ownerRepo = (url: string) => { const t = cloneTarget(url); return t ? /github\.com[:/](.+)\.git$/.exec(t.url)?.[1] : undefined }

const ghApi = async (args: string[]): Promise<string | undefined> => {
  const gh = await ghPath()
  if (!gh) return undefined
  return new Promise(resolve => execFile(gh, args, { timeout: 15_000, windowsHide: true, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (err, out) => resolve(err ? undefined : String(out))))
}
// gh's yes or no per repo, for the session; a failure is asked again next time.
const privates = new Map<string, boolean>()

/** Only a private GitHub repo syncs by itself; public, other hosts or no answer from gh stay local until opted in. */
export async function syncMode(folder: string, url: string, optIn = readOptIn(), gh = ghApi): Promise<TodoSync> {
  if (!url) return { state: 'local', why: 'no origin remote' }
  if (Object.hasOwn(optIn, folder)) return { state: 'synced', canSync: true, optIn: true }
  const repo = ownerRepo(url)
  if (!repo) return { state: 'local', why: 'origin is not on GitHub', canSync: true }
  if (!privates.has(repo)) {
    const a = await gh(['api', `repos/${repo}`, '--jq', '.private']).then(x => x?.trim(), () => undefined)
    if (a === 'true' || a === 'false') privates.set(repo, a === 'true')
  }
  const priv = privates.get(repo)
  return priv ? { state: 'synced', canSync: true } : { state: 'local', why: priv === false ? 'public repo' : 'could not check the repo with gh', canSync: true }
}

/** Fetch origin's ref, merge it in (both parents when both moved), push what origin lacks. Offline or no origin: local only. */
export async function syncDoc(s: TodoStore): Promise<string | undefined> {
  const root = s.root
  if (!root || !(await hasOrigin(root))) return undefined
  const f = await git(root, ['fetch', '-q', '--no-tags', '--no-write-fetch-head', 'origin', `+${TODO_REF}:${REMOTE_REF}`], 60_000)
  const local = await revParse(root, TODO_REF), remote = f.ok ? await revParse(root, REMOTE_REF) : undefined
  if (remote && remote !== local) {
    // Read before adopting or merging: a list that cannot be read would lock this one, and is never pushed over.
    const theirs = await docAt(root, remote).catch(() => undefined)
    if (!theirs) return UNREADABLE
    if (!local || await isAncestor(root, local, remote)) await setRef(root, remote, local)
    else if (!(await isAncestor(root, remote, local))) {
      const c = await commitDoc(root, mergeDocs(await docAt(root, local), theirs), [local, remote])
      if (c) await setRef(root, c, local)
    }
  }
  const tip = await revParse(root, TODO_REF)
  return tip && tip !== remote ? pushTodo(root) : undefined
}

/** The remote list's commit the last fetch saw. */
export const remoteSeen = (root: string) => revParse(root, REMOTE_REF)

/**
 * The user chose to replace an unreadable remote list with this one: only refs/switchboard/todo goes, and only
 * while origin still has the commit they saw. A string says why it did not go.
 */
export async function replaceRemote(root: string, seen: string): Promise<string | undefined> {
  if (!/^[0-9a-f]{40}$/.test(seen)) return 'not a commit id'
  if (!(await revParse(root, TODO_REF))) {
    const c = await commitDoc(root, emptyDoc(), [])
    if (!c || !(await setRef(root, c, undefined))) return 'git could not write the to-do list'
  }
  const r = await git(root, ['push', '--no-verify', '-q', `--force-with-lease=${TODO_REF}:${seen}`, 'origin', `${TODO_REF}:${TODO_REF}`], 60_000)
  return r.ok ? undefined : r.err.trim().split('\n')[0] || 'push failed'
}

/** A chat reached Done: one quick model call ticks the open items its work covers, wherever they came from, then afterFinish. */
export async function todoFinished(s: TodoStore, p: ChatProgress, ask: (prompt: string, ms: number) => Promise<string>): Promise<TodoDoc> {
  const left = leftTexts(p)
  const older = (await readDoc(s)).todo.filter(l => !l.chat && !left.some(t => mentions(t, l.text)))
  const said = !!(p.report?.done.length || p.asked?.length)
  const answer = older.length && said ? await ask(finishPrompt(older, p), 60_000).catch(() => '') : ''
  const done = parseDoneIds(answer, older.map(l => l.id))
  return updateDoc(s, d => afterFinish(d, p, done))
}

// The hub side: lists by project folder in hub.todos, synced at most every SYNC_MS and a few seconds after a change.
const SYNC_MS = 5 * 60_000
const PUSH_WAIT_MS = 3000
const stores = new Map<string, Promise<TodoStore>>()
const syncedAt = new Map<string, number>()
const syncState = new Map<string, TodoSync>()
const pushes = new Map<string, NodeJS.Timeout>()
const storeOf = (folder: string) => { let s = stores.get(folder); if (!s) stores.set(folder, s = storeFor(folder)); return s }
const show = (folder: string, d?: TodoDoc) => {
  const was = hub.get().todos?.[folder]
  const src = d ?? was
  hub.set({ todos: { ...hub.get().todos, [folder]: { todo: src?.todo ?? [], ticked: src?.ticked, sync: syncState.get(folder) } } })
}

/** Syncs when the repo may (syncMode) and keeps how it went for the panel. */
async function syncNow(folder: string, s: TodoStore): Promise<void> {
  if (!s.root) { syncState.set(folder, { state: 'local', why: 'not a git repo' }); return }
  const mode = await syncMode(folder, (await git(s.root, ['config', '--get', 'remote.origin.url'])).out.trim())
  const why = mode.state === 'synced' ? await syncDoc(s).catch(err => (err as Error).message) : undefined
  if (why) log.warn(`To-do sync for ${folder}: ${why}`)
  // Unreadable: the panel offers to replace it, under a lease on this commit.
  const remote = why === UNREADABLE ? await remoteSeen(s.root) : undefined
  syncState.set(folder, why ? { ...mode, state: 'failing', why: why.slice(0, 120), ...(remote ? { remote } : {}) } : mode)
}

/** The git repo holding a folder, else the listed project holding it (the longest), else the folder itself. */
export function projectOf(cwd: string): string {
  const top = repoTop(cwd)
  if (top) return top
  // Drive letters differ in case on Windows (c:\ from VS Code, C:\ from Claude Code).
  const c = foldPathCase(cwd)
  const inside = (p: string) => { const q = foldPathCase(p); return c === q || c.startsWith(q.endsWith(path.sep) ? q : q + path.sep) }
  return hub.get().projects.filter(p => inside(p.path)).sort((a, b) => b.path.length - a.path.length)[0]?.path ?? cwd
}

/** This window's project and every chat's, shown in the panel. */
export const todoFolders = (workspace: string | undefined) => [...new Set([...(workspace ? [workspace] : []), ...hub.get().chats.map(c => c.cwd)].filter(Boolean).map(projectOf))]

function laterSync(folder: string, s: TodoStore): void {
  if (!s.root) return
  clearTimeout(pushes.get(folder))
  pushes.set(folder, setTimeout(() => {
    pushes.delete(folder)
    // A failed push is retried by the next change or refresh sync.
    syncNow(folder, s).then(() => readDoc(s)).then(d => show(folder, d), err => { log.warn('To-do sync failed:', err); show(folder) })
  }, PUSH_WAIT_MS))
}

/** Reads each folder's lists; fetches and merges when due (or forced by Refresh). */
export async function loadTodos(folders: string[], force = false): Promise<void> {
  await Promise.all(folders.map(async folder => {
    const s = await storeOf(folder)
    if (force || Date.now() - (syncedAt.get(folder) ?? 0) >= SYNC_MS) {
      syncedAt.set(folder, Date.now())
      await syncNow(folder, s)
    }
    try { show(folder, await readDoc(s)) } catch (err) {
      syncState.set(folder, { ...syncState.get(folder), state: 'failing', why: (err as Error).message.slice(0, 120) })
      show(folder)
    }
  }))
}

export async function changeTodo(folder: string, fn: (d: TodoDoc) => TodoDoc): Promise<void> {
  const s = await storeOf(folder)
  show(folder, await updateDoc(s, fn))
  laterSync(folder, s)
}

/** The ask server's todo_add and todo_done, on the project holding cwd. */
export async function todoTool(c: TodoCall & { cwd: string }): Promise<string> {
  let said = ''
  await changeTodo(projectOf(c.cwd), d => { const r = toolStep(d, c); said = r.said; return r.doc })
  return said
}

/** claude-runtime.ts calls this when a chat this window owns reaches Done. */
export async function chatFinished(p: ChatProgress): Promise<void> {
  const folder = projectOf(p.cwd), s = await storeOf(folder)
  show(folder, await todoFinished(s, p, quickAsk))
  laterSync(folder, s)
}

/** claude-runtime.ts calls this when a chat this window owns ends without Done (hub.onEnded). */
export async function chatEnded(p: ChatProgress): Promise<void> {
  if (p.state === 'done') return
  await changeTodo(projectOf(p.cwd), d => afterEnd(d, p))
}

/** hub-todo-sync: the user's choice for a folder, then a sync at once. */
export async function setTodoSync(folder: string, on: boolean): Promise<void> {
  setOptIn(folder, on)
  await loadTodos([folder], true)
}

/** hub-todo-replace: the panel's Replace button, then a sync at once. A string says why it did not go. */
export async function replaceRemoteTodo(folder: string, seen: string): Promise<string | undefined> {
  const s = await storeOf(folder)
  const why = s.root ? await replaceRemote(s.root, seen) : 'not a git repo'
  await loadTodos([folder], true)
  return why
}

/** A handoff to a fresh Claude chat: an item in progress on the old one follows it. */
export async function moveTodoChat(cwd: string, from: string, to: string): Promise<void> {
  const folder = projectOf(cwd)
  if (hub.get().todos?.[folder]?.todo.some(t => t.chat === from)) await changeTodo(folder, d => moveChat(d, from, to))
}

/** After the chat list loads: items whose chat is gone from this machine stop showing in progress. */
export async function clearGoneChats(now = Date.now()): Promise<void> {
  const live = new Set(hub.get().chats.filter(c => c.live).map(c => c.sessionId))
  for (const [folder, l] of Object.entries(hub.get().todos ?? {})) {
    const doc: TodoDoc = { version: 1, todo: l.todo, removed: {} }
    if (clearGone(doc, live, now) !== doc) await changeTodo(folder, d => clearGone(d, live, now))
  }
}
