/**
 * Holds the Hub tab's state and each chat's inbox.
 *
 * Feed posts from the usage mods come through ingest(); what the extension gathers itself comes through set(). Every
 * change fires onChange, which extension.ts throttles into `hub-state`.
 */
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import { TypedEventEmitter } from '../typed-event-emitter'
import { addAsk, dropAsk, finishedJobs, LIMITS, settle, step, TOOLS_MAX } from './progress'
import { chainVersion } from './projects'
import { FLAGGED } from './tools'
import { createLogger } from '../logger'
import { writeJsonAtomic } from '../hook-entries'
import type { AiId, Ask, ChatProgress, ChatRow, ChatState, DeviceAsk, HandoffWait, HubState, InboxDraft, InboxItem, JevRun, Limit, Server, SessionLive } from './types'

const log = createLogger('Hub')

const LIVE_STALE_MS = 10 * 60 * 1000
// A chat's progress row goes on SessionEnd, or after a day with no hook from it.
const PROGRESS_STALE_MS = 24 * 60 * 60 * 1000
const MAX_INBOX = 20
// A chat's mod polls its inbox every 2 seconds; quiet longer than this, a message would sit unread.
const POLL_GONE_MS = 10_000
// A stopped dev server stays a suggestion this long, or until it is back.
const GONE_MS = 10 * 60 * 1000
// A handoff or close waits on running subagents this long at most; a lost SubagentStop must not keep a full chat forever.
export const WAIT_CAP_MS = 30 * 60 * 1000
// Past this share of the compaction point a held handoff goes anyway, or the auto compaction wins.
const COMPACT_SOON = 0.97
const MAX_JEV = 50
// A jev.py call this recent in a chat is the run the usage mod reports.
const JEV_MATCH_MS = 10 * 60 * 1000
// A limited chat is told to carry on a minute after its reset, or every half hour when none is known.
const RETRY_MS = 30 * 60 * 1000
const CONTINUE = 'Switchboard: the usage limit reset. Continue where you left off; if you need the user, ask with AskUserQuestion.'

export const emptyHub = (): HubState => ({
  live: [], history: [], sessions: [], plan: null,
  servers: [], git: null, aws: [], signIns: { chrome: [], projects: {} }, jev: [], waits: [], installed: [], connections: [], rc: { atStartup: false },
  keep: { autoCompact: true, autoContinue: false, onFull: 'fresh', freshBranch: false },
  projects: [],
  controls: {
    claude: { tui: 'default', statusLine: false, push: false, needInput: false },
    switchboard: { hooks: false, statusBar: true, idleMinutes: 15, brief: true, askBrain: true, syncRules: true, accessNote: true, name: '' },
    statusLineReady: false,
  },
  chats: [], rcServers: [], ais: [], starred: [], progress: [], archive: [],
  changes: null, search: null, webUrl: null, phoneUrls: null,
  tools: { flagged: FLAGGED, pick: null, chats: {} },
})

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)

/** A full chat handing over to a fresh one: its note, written by the usage feed (or by hub-panel.ts for Codex). */
export type Handoff = { sessionId: string; cwd: string; note: string; branch?: string; task?: string; name?: string; plan?: string; ai?: AiId; /** Subagents still running when the wait cap let it go: `<role> <id>`. */ running?: string[] }
// The feed writes notes only here; anything else is refused before a terminal reads it.
const HANDOFFS = `${os.homedir().replace(/\\/g, '/')}/.claude/handoffs/`
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

const limitsOf = (v: unknown): Limit[] =>
  Array.isArray(v)
    ? v.flatMap(l => (l && typeof l === 'object' && str((l as Limit).kind) && num((l as Limit).percentUsed) !== undefined
      ? [{ kind: (l as Limit).kind, percentUsed: (l as Limit).percentUsed, resetsAt: str((l as Limit).resetsAt) }] : []))
    : []

export class HubService {
  /** Shared with the usage mods through the window's discovery file. */
  readonly token = crypto.randomBytes(16).toString('hex')
  private state: HubState = emptyHub()
  private readonly inboxes = new Map<string, InboxItem[]>()
  private readonly polled = new Map<string, number>()
  // When each limited chat gets its continue prompt; kept in retriesFile so a window reload still sends it.
  private readonly retries = new Map<string, number>()
  private readonly changed = new TypedEventEmitter<HubState>()
  readonly onChange = this.changed.event
  private readonly handoffs = new TypedEventEmitter<Handoff>()
  readonly onHandoff = this.handoffs.event
  private gone: { server: Server; at: number }[] = []
  // A chat that handed off: closed once a new chat posts from the same folder.
  private pendingClose: { sessionId: string; cwd: string; at: number }[] = []
  // Old chats whose fresh chat has posted, closed once no subagent of theirs runs.
  private closing: { sessionId: string; at: number }[] = []
  // Handoffs held while the full chat still has subagents running.
  private waiting: { h: Handoff; since: number }[] = []
  // Chats Kenneth handed off by hand: no waiting on subagents.
  private readonly forced = new Set<string>()
  // When each chat last ran jev.py, from its own Bash hook.
  private readonly jevAsked = new Map<string, number>()
  private codexWaits: HandoffWait[] = []
  private readonly closeFailed = new TypedEventEmitter<string>()
  readonly onCloseFailed = this.closeFailed.event
  private readonly closingChat = new TypedEventEmitter<string>()
  /** A handed-off chat was told to exit; hub-panel.ts closes its terminal once it has. */
  readonly onClosing = this.closingChat.event
  private readonly devAsked = new TypedEventEmitter<{ kind: 'start' | 'stop'; folder: string }>()
  /** Another window passed on a Dev start or stop; hub-panel.ts checks the folder and acts. */
  readonly onDev = this.devAsked.event
  private readonly promptedChat = new TypedEventEmitter<string>()
  private readonly endedChat = new TypedEventEmitter<ChatProgress>()
  /** A chat this window owns ended (SessionEnd), with its last progress; never one that handed off to a fresh chat. */
  readonly onEnded = this.endedChat.event
  // Chats that handed off; their open tasks carry over to the fresh chat.
  private readonly handedOff = new Set<string>()
  /** A chat took a message sent from Switchboard; the window holding its terminal shows it. */
  readonly onPrompted = this.promptedChat.event
  /** handleHubMessage, set by startHub; kept as a field so routes.ts needs no vscode. A string is why it was refused. */
  runner?: (c: { type: string }) => boolean | string | Promise<boolean | string>
  /** Whether this window holds the chat's terminal; hub-panel.ts sets it. */
  holds?: (sessionId: string) => Promise<boolean>
  /** A device asking in (or its end, done), from the standalone app; set by startHub. */
  onDevice?: (d: DeviceAsk & { port: number } | { id: string; done: true }) => void
  /** When the standalone app last read /hub/state; hub-panel.ts keeps chats fresh while it is recent. */
  stateReadAt = 0

  private retriesFile?: string
  /** One file per workspace, so only this window's own chats load back and no other window sends them. None: memory only. */
  keepRetries(file: string): void {
    this.retriesFile = file
    try {
      // One overdue by more than a day is for a chat that ended while no window listened.
      for (const [id, due] of Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')))) {
        if (typeof due === 'number' && Date.now() - due < PROGRESS_STALE_MS) this.retries.set(id, due)
      }
    } catch { /* none yet, or broken: start empty */ }
  }

  private saveRetries(): void {
    if (!this.retriesFile) return
    try { writeJsonAtomic(this.retriesFile, Object.fromEntries(this.retries)) } catch (err) { log.warn('Retries not kept:', err) }
  }

  get(): HubState {
    return this.state
  }

  isToken(candidate: unknown): boolean {
    if (typeof candidate !== 'string') return false
    const a = Buffer.from(candidate), b = Buffer.from(this.token)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }

  /** What the extension gathered itself (history, plan, servers, ...). */
  set(part: Partial<HubState>, now = Date.now()): void {
    if (part.servers) {
      const up = new Set(part.servers.map(s => s.port))
      const stopped = this.state.servers.filter(s => !up.has(s.port)).map(server => ({ server, at: now }))
      this.gone = [...this.gone.filter(g => !up.has(g.server.port) && now - g.at < GONE_MS), ...stopped]
    }
    this.state = { ...this.state, ...part }
    this.emit(now)
  }

  /**
   * One raw hook payload; the change of state when there is one, for notify.ts. A new chat that is just working is not one.
   * A mirror (a chat another window owns) only updates progress; that window notifies.
   */
  hook(payload: Record<string, unknown>, now = Date.now(), mirror = false): { from?: ChatState; to: ChatProgress } | undefined {
    const id = typeof payload.session_id === 'string' ? payload.session_id : undefined
    // A `claude -p` from outside a project (cwd /) or a payload with no folder is no chat.
    if (!id || typeof payload.cwd !== 'string' || !payload.cwd || payload.cwd === '/') return undefined
    const was = this.state.progress.find(p => p.sessionId === id)
    const input = payload.tool_input as Record<string, unknown> | undefined
    if (payload.hook_event_name === 'PreToolUse' && payload.tool_name === 'Bash' && String(input?.command ?? '').includes('jev.py')) this.jevAsked.set(id, now)
    const next = step(was, this.withEnded(payload, was), now)
    const rest = this.state.progress.filter(p => p.sessionId !== id)
    // Only the owning window retries, or each window would send it.
    if (payload.hook_event_name === 'StopFailure' && next?.limited && LIMITS.has(next.limited.error)) { if (!mirror) { this.retries.set(id, this.resetAt(now)); this.saveRetries() } }
    else if (!next?.limited && this.retries.delete(id)) this.saveRetries()
    this.state = { ...this.state, progress: next ? [next, ...rest] : rest }
    this.emit(now)
    if (payload.hook_event_name === 'SessionEnd' && was && !this.handedOff.delete(id) && !mirror) this.endedChat.fire(was)
    return !mirror && next && next.state !== (was?.state ?? 'working') ? { from: was?.state, to: next } : undefined
  }

  /** A minute past the latest reset of a used-up limit, else RETRY_MS from now. */
  private resetAt(now: number): number {
    const at = this.state.live.flatMap(s => s.limits).filter(l => l.percentUsed >= 100).map(l => Date.parse(l.resetsAt ?? '')).filter(Number.isFinite)
    return at.length ? Math.max(...at, now) + 60_000 : now + RETRY_MS
  }

  /** On a Stop with background jobs pending, which ones the transcript says ended; no hook fires for that. */
  private withEnded(payload: Record<string, unknown>, was: ChatProgress | undefined): Record<string, unknown> {
    const file = payload.transcript_path
    if (payload.hook_event_name !== 'Stop' || !was?.jobs?.length || typeof file !== 'string') return payload
    // ponytail: reads the whole transcript, only on a Stop with jobs pending; tail it from an offset if that gets slow.
    try { return { ...payload, bg_finished: finishedJobs(fs.readFileSync(file, 'utf8')) } } catch { return payload }
  }

  /** A post from a chat's usage mod; false when it lacks the token or a known kind. */
  ingest(body: unknown, now = Date.now()): boolean {
    if (!body || typeof body !== 'object') return false
    const b = body as Record<string, unknown>
    if (!this.isToken(b.token)) return false
    switch (b.kind) {
      case 'live': {
        const sessionId = str(b.sessionId)
        if (!sessionId) return false
        const was = this.state.live.find(s => s.sessionId === sessionId)
        const file = str(b.file)?.slice(0, 400) ?? was?.file
        const next: SessionLive = {
          sessionId, cwd: str(b.cwd) ?? '', label: str(b.label), model: str(b.model),
          tokens: num(b.tokens), compactAt: num(b.compactAt), limits: limitsOf(b.limits), costUsd: num(b.costUsd),
          prompt: str(b.prompt)?.slice(0, 200) ?? was?.prompt, file, fileAt: file && file === was?.file ? was.fileAt : file ? now : undefined, at: now,
        }
        this.state = { ...this.state, live: [next, ...this.state.live.filter(s => s.sessionId !== sessionId)] }
        // Only a session's first post is the fresh chat; one already open in the folder is not.
        const ready = was ? [] : this.pendingClose.filter(p => p.sessionId !== sessionId && p.cwd === next.cwd.replace(/\\/g, '/') && now > p.at)
        this.closing = [...this.closing, ...ready.map(p => ({ sessionId: p.sessionId, at: now }))]
        if (ready.length) this.pendingClose = this.pendingClose.filter(p => !ready.includes(p))
        break
      }
      // Older mods still post these; taken and dropped, since a refusal makes a mod look for the window again.
      case 'diet':
      case 'guard':
      case 'agent':
        return true
      case 'jev':
        // A credits-only post or a malformed run is taken and dropped, like the old kinds.
        this.jevRun(b, now)
        break
      case 'handoff': {
        const sessionId = str(b.sessionId), cwd = str(b.cwd), note = str(b.note)?.replace(/\\/g, '/')
        if (!sessionId || !cwd || !note || !note.startsWith(HANDOFFS) || note.includes('/../') || !note.endsWith('.md')) return false
        const branch = str(b.branch), task = str(b.task)?.slice(0, 120), plan = str(b.plan)?.replace(/\\/g, '/')
        // Only shown and passed along, but still a plain absolute .md path.
        if (plan !== undefined && (!/^(\/|[A-Za-z]:\/)/.test(plan) || plan.includes('/../') || !plan.endsWith('.md'))) return false
        const name = this.state.chats.find(c => c.sessionId === sessionId)?.name
        // The close is armed by closeAfterFresh once the fresh chat's terminal exists, never here.
        // Held while a subagent of the chat runs; emit passes it on once none does.
        const h: Handoff = { sessionId, cwd, note, ...(branch ? { branch } : {}), ...(task ? { task } : {}), ...(name ? { name } : {}), ...(plan ? { plan } : {}) }
        // force: Kenneth asked for it, maybe in another window.
        if (b.force === true) this.forced.add(sessionId)
        this.waiting = [...this.waiting.filter(w => w.h.sessionId !== sessionId), { h, since: now }]
        break
      }
      case 'prompted': {
        const sessionId = str(b.sessionId)
        if (!sessionId) return false
        this.promptedChat.fire(sessionId)
        return true
      }
      case 'dev-start':
      case 'dev-stop': {
        const folder = str(b.folder)
        if (!folder) return false
        this.devAsked.fire({ kind: b.kind === 'dev-start' ? 'start' : 'stop', folder })
        return true
      }
      case 'close-failed': {
        const sessionId = str(b.sessionId)
        if (!sessionId) return false
        this.closeFailed.fire(sessionId)
        return true
      }
      default:
        return false
    }
    this.emit(now)
    return true
  }

  /** How many subagents of a chat still run. */
  busy(sessionId: string): number {
    return this.state.progress.find(p => p.sessionId === sessionId)?.running?.length ?? 0
  }

  /** Codex waits come from hub-panel.ts (an open turn in the rollout); they replace the Codex ones shown. */
  setCodexWaits(waits: HandoffWait[], now = Date.now()): void {
    this.codexWaits = waits
    this.emit(now)
  }

  /**
   * A run from the usage mod, drawn on the chat that ran it: its session id, else the chat that last ran jev.py, else the newest chat.
   * With a posted folder only chats in it count; none there keeps the run (Today) but draws it on no chat.
   */
  private jevRun(b: Record<string, unknown>, now: number): void {
    const items = num(b.items), costUsd = num(b.costUsd), seconds = num(b.seconds)
    if (items === undefined || costUsd === undefined || seconds === undefined) return
    const preset = str(b.preset) && /^[\w.-]{1,40}$/.test(str(b.preset)!) ? str(b.preset) : undefined
    const progress = this.state.progress
    const asked = [...this.jevAsked].filter(([, at]) => now - at < JEV_MATCH_MS).sort((x, y) => y[1] - x[1])[0]?.[0]
    const cwd = str(b.cwd)?.replace(/\\/g, '/').replace(/\/+$/, '')
    const here = (p: ChatProgress) => !cwd || p.cwd === cwd || cwd.startsWith(`${p.cwd}/`) || p.cwd.startsWith(`${cwd}/`)
    const sessionId = [str(b.sessionId), asked].find(id => id && progress.some(p => p.sessionId === id && here(p)))
      ?? [...progress].filter(here).sort((x, y) => y.at - x.at)[0]?.sessionId
    const run: JevRun = { ...(sessionId ? { sessionId } : {}), ...(preset ? { preset } : {}), items, seconds, costUsd, at: now }
    const cost = `$${costUsd.toFixed(costUsd < 0.01 ? 4 : 2)}`
    this.state = {
      ...this.state,
      jev: [run, ...this.state.jev].slice(0, MAX_JEV),
      progress: progress.map(p => p.sessionId !== sessionId ? p : {
        ...p,
        roles: [...p.roles.filter(r => r.role !== 'jev'), { id: 'jev', role: 'jev', state: 'done', startedAt: now }],
        tools: [...(p.tools ?? []), { tool: preset ?? 'jev', target: `${items} items · ${cost}`, role: 'jev', at: now }].slice(-TOOLS_MAX),
      }),
    }
  }

  /** A question from the ask tool shows on its chat; again after a Stop or a new prompt cleared it. */
  asked(sessionId: string, ask: Ask): void {
    if (this.state.progress.some(p => p.sessionId === sessionId && !(p.asks ?? []).some(a => a.id === ask.id))) this.set({ progress: this.state.progress.map(p => (p.sessionId === sessionId ? addAsk(p, ask) : p)) })
  }

  /** Drops a prompt once answered from here, so a second tap has nothing to send; the next one waiting shows. */
  answered(sessionId: string, askId: string): void {
    this.set({ progress: this.state.progress.map(p => (p.sessionId === sessionId ? dropAsk(p, askId) : p)) })
  }

  /** Passes on held handoffs and closes whose chat has no subagent running, or that waited WAIT_CAP_MS. */
  private flush(now: number): void {
    const due = (id: string, since: number, what: string) => {
      if (!this.busy(id)) return true
      if (what === 'Handing off' && (this.forced.has(id) || this.compactSoon(id))) return true
      if (now - since < WAIT_CAP_MS) return false
      log.warn(`${what} ${id.slice(0, 8)} after 30 minutes with ${this.busy(id)} subagent(s) still marked running`)
      return true
    }
    const closeNow = this.closing.filter(c => due(c.sessionId, c.at, 'Closing'))
    if (closeNow.length) {
      this.closing = this.closing.filter(c => !closeNow.includes(c))
      for (const c of closeNow) { this.queue(c.sessionId, { kind: 'close' }); this.closingChat.fire(c.sessionId) }
    }
    const go = this.waiting.filter(w => due(w.h.sessionId, w.since, 'Handing off'))
    this.waiting = this.waiting.filter(w => !go.includes(w))
    const waits = [...this.waiting.map(w => {
      const name = this.state.chats.find(c => c.sessionId === w.h.sessionId)?.name ?? w.h.name
      return { sessionId: w.h.sessionId, tasks: this.busy(w.h.sessionId), next: `v${chainVersion(name) + 1}`, since: w.since }
    }), ...this.codexWaits]
    if (JSON.stringify(waits) !== JSON.stringify(this.state.waits)) this.state = { ...this.state, waits }
    for (const w of go) {
      this.forced.delete(w.h.sessionId)
      // Past the cap: the fresh chat gets each one still running, to check its output.
      const p = this.state.progress.find(x => x.sessionId === w.h.sessionId)
      const running = p?.running?.map(id => `${p.roles.find(r => r.id === id)?.role ?? 'agent'} ${id}`)
      this.handoffs.fire(running?.length ? { ...w.h, running } : w.h)
    }
  }

  /** A handoff asked for by hand: queued to the chat, and it skips the wait on subagents. */
  handoffNow(sessionId: string, now = Date.now()): void {
    this.queue(sessionId, { kind: 'handoff' })
    this.forced.add(sessionId)
    this.emit(now)
  }

  private compactSoon(sessionId: string): boolean {
    const s = this.state.live.find(x => x.sessionId === sessionId)
    return !!s?.tokens && !!s.compactAt && s.tokens >= s.compactAt * COMPACT_SOON
  }

  /** Called once the fresh chat's terminal is open: the old chat closes when a new chat first posts from its folder. */
  closeAfterFresh(sessionId: string, cwd: string, now = Date.now()): void {
    this.handedOff.add(sessionId)
    this.pendingClose = [...this.pendingClose.filter(p => p.sessionId !== sessionId), { sessionId, cwd: cwd.replace(/\\/g, '/'), at: now }]
  }

  queue(sessionId: string, item: InboxDraft & { id?: string }): InboxItem {
    const full: InboxItem = { ...item, id: item.id ?? crypto.randomBytes(6).toString('hex') }
    const list = this.inboxes.get(sessionId) ?? []
    this.inboxes.set(sessionId, [...list, full].slice(-MAX_INBOX))
    return full
  }

  take(sessionId: string, now = Date.now()): InboxItem[] {
    this.polled.set(sessionId, now)
    const list = this.inboxes.get(sessionId) ?? []
    this.inboxes.delete(sessionId)
    const due = this.retries.get(sessionId)
    if (due === undefined || now < due) return list
    this.retries.delete(sessionId)
    this.saveRetries()
    // Claude Code's own autoContinueAtUsageLimit sends one already; a second would run the turn twice.
    if (this.state.keep.autoContinue) return list
    return [...list, { kind: 'prompt', text: CONTINUE, id: crypto.randomBytes(6).toString('hex') }]
  }

  /** Whether the message box reaches this chat: a Codex chat through its tied terminal, a Claude chat through its polling mod. */
  takes(chat: ChatRow, codexTerminal: boolean, now = Date.now()): boolean {
    if (!chat.live) return false
    if (chat.ai === 'codex') return codexTerminal
    return now - (this.polled.get(chat.sessionId) ?? -Infinity) < POLL_GONE_MS
  }

  /** Dev servers that stopped in the last ten minutes. */
  stopped(now = Date.now()): Server[] {
    return this.gone.filter(g => now - g.at < GONE_MS).map(g => g.server)
  }

  private emit(now: number): void {
    const fresh = this.state.live.filter(s => now - s.at < LIVE_STALE_MS)
    if (fresh.length !== this.state.live.length) this.state = { ...this.state, live: fresh }
    const progress = this.state.progress.filter(p => now - p.at < PROGRESS_STALE_MS).map(p => settle(p, now))
    if (progress.some((p, i) => p !== this.state.progress[i]) || progress.length !== this.state.progress.length) this.state = { ...this.state, progress }
    this.flush(now)
    this.changed.fire(this.state)
  }
}

/** The window's one hub, read by the hook server, the discovery file and the panel. */
export const hub = new HubService()
