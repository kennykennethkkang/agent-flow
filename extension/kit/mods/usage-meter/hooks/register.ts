// Usage feed for Switchboard: posts this chat's context, limits, token diet and Jev runs
// to every open Switchboard window, and carries back what was typed in any of them (a
// message, Remote Control, a compaction). Draws nothing in the terminal.
import type { EngineInterface, Register, SessionContextBreakdown, SessionUsage } from 'claude-code'

type Target = { port: number; token: string; workspace: string }
type Discovery = { port?: unknown; hubToken?: unknown; workspace?: unknown }
type InboxItem = { id: string; kind: 'prompt'; text: string } | { id: string; kind: 'rc' } | { id: string; kind: 'compact' } | { id: string; kind: 'close' } | { id: string; kind: 'handoff' }

const POST_EVERY_MS = 5_000
const POLL_MS = 2_000
const REDISCOVER_MS = 30_000

export const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')

/** Every Switchboard window (Agent Flow alone writes no hub token): any of them can show and talk to this chat. */
export function targetsOf(files: Discovery[]): Target[] {
  return files.flatMap(f => typeof f.port === 'number' && typeof f.hubToken === 'string' && typeof f.workspace === 'string'
    ? [{ port: f.port, token: f.hubToken, workspace: norm(f.workspace) }]
    : [])
}

/** A Jev run from jev.py's one-line summary on stderr. */
export function jevRun(command: string, output: string) {
  const m = /\[jev\] (\d+) items · ([\d.]+)s wall · .*? · \$([\d.]+) · (\d+) errors(?: · sure (\d+) \/ unsure (\d+))?/.exec(output)
  if (!m) return undefined
  const preset = /--preset[ =](\S+)/.exec(command)?.[1]
  const split = m[5] === undefined ? {} : { sure: Number(m[5]), unsure: Number(m[6]) }
  return { preset, items: Number(m[1]), seconds: Number(m[2]), costUsd: Number(m[3]), errors: Number(m[4]), ...split }
}

/** OpenRouter credits left, from jev.py status or the get-credits tool; the feed never asks for them itself. */
export function creditsIn(text: string): number | undefined {
  const printed = /credits:\s+\$([\d.]+) left/.exec(text)
  if (printed) return Number(printed[1])
  const bought = /"total_credits"\s*:\s*([\d.]+)/.exec(text)
  const used = /"total_usage"\s*:\s*([\d.]+)/.exec(text)
  return bought && used ? Number(bought[1]) - Number(used[1]) : undefined
}

// mcp__plugin_bland_bland__x -> bland; mcp__openrouter__x -> openrouter.
export const ownerOf = (tool: string) => {
  const server = tool.split('__')[1] ?? tool
  return /^plugin_([^_]+)_/.exec(server)?.[1] ?? server
}

const add = (map: Map<string, number>, key: string, n: number) => map.set(key, (map.get(key) ?? 0) + n)

/** What loads on every call, biggest first, and the plugins never used since counting began. */
export function dietOf(b: SessionContextBreakdown, uses: Record<string, number>) {
  const rows = b.categories.filter(c => c.kind === 'used' && c.tokens > 0).map(c => ({ label: c.name, tokens: c.tokens }))
  const owners = new Map<string, number>()
  const plugins = new Set<string>()
  for (const s of b.skills?.skillFrontmatter ?? []) {
    add(owners, s.pluginName ? `skills: ${s.pluginName}` : 'skills: yours', s.tokens)
    if (s.pluginName) plugins.add(s.pluginName)
  }
  for (const t of b.mcpTools) {
    const owner = ownerOf(t.name)
    // A deferred tool costs its name in the listing, not its schema.
    add(owners, `mcp: ${owner}`, t.isLoaded ? t.tokens : Math.round(t.name.length / 3.5))
    if (/^plugin_/.test(t.serverName)) plugins.add(owner)
  }
  const detail = [...owners].map(([label, tokens]) => ({ label, tokens })).sort((x, y) => y.tokens - x.tokens).slice(0, 8)
  const memory = b.memoryFiles.map(f => ({ label: `memory: ${f.path.split(/[\\/]/).pop() ?? f.path}`, tokens: f.tokens }))
  return {
    total: b.totalTokens,
    rows: [...rows.sort((x, y) => y.tokens - x.tokens), ...detail, ...memory],
    unused: [...plugins].filter(p => !uses[p]).sort(),
  }
}

/** Hands the panel's queued items to this chat: a message as the user's own, Remote Control, close, a handoff, or a compaction. */
export async function deliver($: EngineInterface, items: InboxItem[]) {
  for (const item of items) {
    if (item.kind === 'prompt') {
      await $.prompt.submit({ text: item.text, asUser: true })
      // The window holding this chat's terminal brings it up.
      await post($, { kind: 'prompted', sessionId: await $.session.id() })
    }
    else if (item.kind === 'rc') await $.command.run({ command: 'remote-control' })
    else if (item.kind === 'close') await $.command.run({ command: 'exit' }).catch(async () => post($, { kind: 'close-failed', sessionId: await $.session.id() }))
    else if (item.kind === 'handoff') await maybeHandoff($, true)
    else {
      // Runs only between turns (it rejects mid-turn), so a chat with open tasks would sit idle after it.
      const { skip } = await $.session.compact({}).catch(() => ({ skip: true }))
      if (skip) continue
      await restoreFeed($).catch(() => undefined)
      feed.nudge = undefined
      await keepGoing($, lastAnswer)
    }
  }
}

// Roles: model and daily budget per role.

const ROLE_MODEL: Record<string, string> = { engineer: 'opus', designer: 'opus', qa: 'opus', 'general-purpose': 'opus', researcher: 'haiku', Explore: 'haiku', ops: 'sonnet', growth: 'sonnet' }
export const roleModel = (subagentType: string): string | undefined => ROLE_MODEL[subagentType]

export function budgetDenial(role: string, used: Record<string, number>, budgets: Record<string, number>): string | undefined {
  const cap = budgets[role]
  return cap !== undefined && (used[role] ?? 0) >= cap ? `Switchboard: ${role} has used its ${cap} starts for today. Raise the budget on the Company card, or do this yourself.` : undefined
}

const READS = new Set(['Read', 'Grep', 'Glob'])
export const pausedDenial = (tool: string, paused: boolean) => (paused && !READS.has(tool) ? 'Switchboard is paused from the Company card: reading only until it is resumed.' : undefined)

const COMPANY_MS = 10_000
const company: { at: number; paused: boolean; budgets: Record<string, number> } = { at: -Infinity, paused: false, budgets: {} }

/** The hub's company.json, read at most every 10 seconds; missing or broken means not paused, no budgets. */
async function readCompany($: EngineInterface) {
  const now = await $.clock.now()
  if (now - company.at < COMPANY_MS) return company
  company.at = now
  const home = norm((await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '')
  try {
    const f = JSON.parse(String(await $.fs.read(`${home}/.claude/switchboard/company.json`)))
    company.paused = f.paused === true
    company.budgets = f.budgets && typeof f.budgets === 'object' ? f.budgets : {}
  } catch { company.paused = false; company.budgets = {} }
  return company
}

async function startsToday($: EngineInterface) {
  const day = new Date(await $.clock.now()).toISOString().slice(0, 10)
  const kept = ((await $.store.get('starts')) ?? {}) as { day?: string; used?: Record<string, number> }
  return { day, used: kept.day === day ? kept.used ?? {} : {} }
}

// Env style names (OPENAI_API_KEY) and the snake names that hold keys (api_key); sort_key or next_token hold none.
const NAMED = String.raw`\b(?:[A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)|(?:api|access|secret|private|auth|client|refresh|session)_(?:key|token|secret))\b`
// A SECRET or PASSWORD name holds a secret whatever its value looks like.
const NAMED_ANY = String.raw`\b[A-Z0-9_]*(?:PASSWORD|SECRET)\b`
// Shapes keys and tokens take; a match becomes [removed] before a note is written or summarized.
const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // AWS secret keys: after their name, or next to an access key id (so before the AKIA rule).
  /(?<=aws_secret_access_key\s*[:=]\s*["']?)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/gi,
  /(?<=AKIA[0-9A-Z]{16}[\s,:;="'|]+)[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  // Passwords (DB_PASSWORD, PGPASSWORD, passwd, pwd): a quoted value whole, any bare value right after '=',
  // and after ':' or a spaced '=' only a token with a digit or symbol, so 'password: done' stays prose.
  /(?<=(?:password|passwd|pwd)["']?\s*[:=]\s*")[^"\n]+(?=")/gi,
  /(?<=(?:password|passwd|pwd)["']?\s*[:=]\s*')[^'\n]+(?=')/gi,
  /(?<=(?:password|passwd|pwd)=)[^\s"']+/gi,
  /(?<=(?:password|passwd|pwd)["']?\s*[:=]\s*)(?=[^\s"',]*[0-9!@#$%^&*_.+\/~-])[^\s"',]+/gi,
  // A bearer token has a digit or symbol; 'Bearer authentication' is prose.
  /(?<=\bBearer\s+)(?=[A-Za-z]*[0-9_.~+/=-])[A-Za-z0-9_.~+/=-]{16,}(?![A-Za-z0-9_.~+/=-])/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  // --password x, --pass=x.
  /(?<=--pass(?:word)?[= ]["']?)[^\s"']+/gi,
  // A named value after = or :, quoted always, bare when it looks like a secret (a digit or symbol, or 12+ characters).
  new RegExp(`(?<=${NAMED}["']?\\s*[:=]\\s*")[^"\\n]+(?=")`, 'g'),
  new RegExp(`(?<=${NAMED}["']?\\s*[:=]\\s*')[^'\\n]+(?=')`, 'g'),
  new RegExp(`(?<=${NAMED_ANY}["']?\\s*[:=]\\s*)[^\\s"',;]+`, 'g'),
  new RegExp(`(?<=${NAMED}["']?\\s*[:=]\\s*)(?=[^\\s"',;}]*[0-9!@#$%^&*_.+/~-]|[^\\s"',;}]{12})[^\\s"',;}]+`, 'g'),
  // mysql -pSECRET.
  /(?<=\bmysql(?:dump)?\b[^\n]*\s-p)[^\s"']+/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bnpm_[A-Za-z0-9]{30,}/g,
  // The password in scheme://user:password@host.
  /(?<=\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@/]+(?=@)/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[0-9a-fA-F]{32,}\b/g,
]
export const redact = (text: string) => SECRETS.reduce((s, re) => s.replace(re, '[removed]'), text)

/** The plan's tasks with steps still unticked. */
export function openTasks(plan: string) {
  const out: Array<{ n: string; title: string; done: number; total: number }> = []
  let cur: (typeof out)[number] | undefined
  for (const line of plan.split('\n')) {
    const head = /^### Task (\d+): (.+)$/.exec(line)
    if (head) {
      const task = { n: head[1] ?? '', title: (head[2] ?? '').trim(), done: 0, total: 0 }
      out.push(task)
      cur = task
      continue
    }
    if (/^#{1,3} /.test(line)) { cur = undefined; continue }
    const step = /^- \[( |x)\] \*\*Step/.exec(line)
    if (step && cur) { cur.total++; if (step[1] === 'x') cur.done++ }
  }
  return out.filter(t => t.total > 0 && t.done < t.total)
}

function decisions(plan: string, last = 5): string[] {
  const at = plan.indexOf('## Decisions')
  if (at < 0) return []
  const rows: string[] = []
  for (const line of plan.slice(at).split('\n').slice(1)) {
    if (/^#{1,3} /.test(line)) break
    if (line.startsWith('|') && !/^\|\s*-/.test(line) && !/^\|\s*Question\s*\|/.test(line)) rows.push(line.trim())
  }
  return rows.slice(-last)
}

type Task = { subject: string; status: string }

// Bullets under a plan's "## Dead ends", newest last.
function deadEnds(plan: string): string[] {
  const at = plan.indexOf('## Dead ends')
  if (at < 0) return []
  const rows: string[] = []
  for (const line of plan.slice(at).split('\n').slice(1)) {
    if (/^#{1,3} /.test(line)) break
    if (line.startsWith('- ')) rows.push(line.trim())
  }
  return rows
}

// ~1,250 tokens, plus what is never cut: the last request, open tasks, running work and errors.
const NOTE_BUDGET = 5_000
// [dead ends, files touched, earlier requests, subagent results] kept at each step.
const TRIMS: Array<[number, number, number, number]> = [[5, 40, 5, 8], [3, 15, 3, 4], [1, 5, 1, 2], [0, 0, 0, 0]]
const REQUEST_MAX = 300
const openLine = (t: Task) => `- [ ] ${t.subject} (${t.status.replace('_', ' ')})`

export type Summary = { goal?: string; tests?: string; decisions?: string[]; next?: string }

/** The fixed lines the wrap-up turn ends with; undefined when it wrote none. */
export function summaryOf(answer: string): Summary | undefined {
  const one = (k: string) => new RegExp(`^${k}:[ \\t]*(\\S.*)$`, 'mi').exec(answer)?.[1]?.trim()
  const block = /^Decisions:[ \t]*\n((?:[ \t]*- .*(?:\n|$))+)/mi.exec(answer)?.[1]
  const decisions = block?.split('\n').map(l => l.trim().replace(/^- /, '')).filter(Boolean)
  const s: Summary = { goal: one('Goal'), tests: one('Tests'), next: one('Next'), ...(decisions?.length ? { decisions } : {}) }
  const set = Object.entries(s).filter(([, v]) => v !== undefined)
  return set.length ? Object.fromEntries(set) : undefined
}

export function handoffNote(o: {
  project: string; cwd: string; branch?: string; planPath?: string; planText?: string; session: string; now: number
  tasks?: Task[]; ask?: string; requests?: string[]; errors?: string[]; running?: string[]; changed?: string[]; transcript?: string
  summary?: Summary; results?: string[]
}): string {
  const stamp = new Date(o.now).toISOString().slice(0, 16).replace('T', ' ')
  const plan = o.planText ? openTasks(o.planText) : []
  const picked = o.planText ? decisions(o.planText) : []
  const dead = o.planText ? deadEnds(o.planText) : []
  const tasks = o.tasks ?? []
  // git status lines to paths: the new chat runs git diff itself.
  const files = (o.changed ?? []).map(l => l.slice(3).trim()).filter(Boolean)
  const results = o.results ?? []
  const quote = (t: string) => t.split('\n').map(l => `> ${l}`)
  const cut = (t: string) => (t.length > REQUEST_MAX ? `${t.slice(0, REQUEST_MAX)} (cut, see transcript)` : t)
  // The last request has its own section; the list does not repeat it.
  const asked = o.ask !== undefined && o.requests?.at(-1) === o.ask ? o.requests.slice(0, -1) : o.requests ?? []
  const open = [...tasks.filter(t => t.status !== 'completed').map(openLine), ...plan.map(t => `- Task ${t.n}: ${t.title} (${t.done} of ${t.total} steps done)`)]
  const done = tasks.filter(t => t.status === 'completed').length
  const s = o.summary ?? {}
  const firstAsk = (o.requests?.[0] ?? o.ask ?? '').split('\n')[0]?.slice(0, 200)
  const build = ([deadCap, filesCap, asksCap, resultsCap]: [number, number, number, number]) => {
    const lines = [
      `# Handoff: ${o.project}, ${stamp} UTC`,
      '',
      'Read this note fully before acting. Recreate every open task below with the task tools before any other work, then take the next action. A task counts as done only with the check that proved it.',
    ]
    if (o.ask) lines.push('', '## Last request, verbatim', '', ...quote(o.ask))
    lines.push('', '## Goal', '', s.goal ?? (firstAsk || 'see the last request'))
    lines.push('', '## State', '', `- Folder: ${o.cwd}`, `- Branch: ${o.branch ?? 'unknown'}`, `- Plan: ${o.planPath ?? 'none'}`, `- Tests last run: ${s.tests ?? 'unknown, run them first'}`)
    const why = [...(s.decisions ?? []).map(d => `- ${d}`), ...picked]
    if (why.length) lines.push('', '## Decisions', '', ...why)
    lines.push('', '## Open tasks', '', ...(open.length ? open : ['- none']))
    if (o.running?.length) lines.push('', '## Running work', '', 'Background shells and subagents do not carry over: check each output, rerun what is cut off.', '', ...o.running.map(r => `- ${r}`))
    if (o.errors?.length) lines.push('', '## Errors', '', '```', ...o.errors, '```')
    if (results.length && resultsCap) lines.push('', '## Subagent results', '', ...results.slice(-resultsCap).map(r => `- ${r}`))
    if (files.length) {
      const shown = files.slice(0, filesCap)
      lines.push('', '## Files touched', '', ...shown, ...(files.length > shown.length ? [`and ${files.length - shown.length} more (git status)`] : []))
    }
    lines.push('', '## Next action', '', s.next ?? (open.length ? 'Take the first open task.' : 'Carry on with the last request.'))
    if (done) lines.push('', `${done} task${done === 1 ? '' : 's'} done in the old chat.`)
    const shown = asked.length > asksCap ? asked.slice(-asksCap) : asked
    if (shown.length) lines.push('', '## Earlier requests', '', ...(asked.length > shown.length ? [`${asked.length - shown.length} older, see transcript`, ''] : []), ...shown.flatMap((r, i) => [...(i ? [''] : []), ...quote(cut(r))]))
    const deadShown = dead.slice(dead.length - Math.min(deadCap, dead.length))
    if (deadShown.length) lines.push('', '## Dead ends', '', ...deadShown, ...(dead.length > deadShown.length ? [`(${dead.length - deadShown.length} older in the plan)`] : []))
    lines.push(
      '',
      `- Old transcript: ${o.transcript ?? 'unknown'} (grep it for detail, do not paste it)`,
      `- Old session: ${o.session}`,
      '',
      'Keys, tokens and passwords are never written here; anything shaped like one was removed.',
    )
    return redact(lines.join('\n'))
  }
  const kept = (o.ask?.length ?? 0) + (o.errors ?? []).join('\n').length + open.join('\n').length + (o.running ?? []).join('\n').length
  let note = ''
  for (const caps of TRIMS) {
    note = build(caps)
    if (note.length <= NOTE_BUDGET + kept) break
  }
  return note
}

/** Last check before the note goes out: every unfinished task in the store is under Open tasks. */
export function ensureOpenTasks(note: string, tasks: Task[]): string {
  const at = note.indexOf('## Open tasks')
  const end = at < 0 ? -1 : note.indexOf('\n## ', at + 1)
  const section = at < 0 ? '' : note.slice(at, end < 0 ? undefined : end)
  // The note is redacted, so subjects are too, to compare and to insert.
  const missing = tasks.map(t => ({ ...t, subject: redact(t.subject) })).filter(t => t.status !== 'completed' && !section.includes(`] ${t.subject} (`)).map(openLine)
  if (!missing.length) return note
  if (at < 0) {
    // Where it belongs: before the first section that follows Open tasks.
    const where = Math.min(...['\n## Running work', '\n## Errors', '\n## Subagent results', '\n## Files touched', '\n## Next action'].map(h => note.indexOf(h)).filter(i => i >= 0), note.length)
    return `${note.slice(0, where)}\n\n## Open tasks\n\n${missing.join('\n')}${note.slice(where)}`
  }
  const cut = end < 0 ? note.length : end
  return `${note.slice(0, cut).replace(/\n+$/, '').replace(/\n- none$/, '')}\n${missing.join('\n')}\n${note.slice(cut)}`
}

const STOP = new Set(['the', 'a', 'an', 'on', 'in', 'of', 'to', 'for', 'and', 'with', 'my', 'me', 'please', 'can', 'you', 'could', 'i', 'it', 'is', 'this', 'that', 'now'])
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(' ').filter(w => w && !STOP.has(w))

/** A plan's filename without its date prefix and .md, as words. */
const planWords = (planPath?: string) => words((planPath ? (planPath.split('/').pop() ?? '').replace(/\.md$/, '').replace(/^\d{4}-\d{2}-\d{2}-/, '') : '').replace(/-/g, ' '))

/** claude/<plan>-<task>, or claude/continue-MMDD when neither is known. */
export function branchFor(planPath?: string, task?: string, now = new Date()): string {
  const all = [...planWords(planPath), ...words(task ?? '')].slice(0, 6)
  if (!all.length) return `claude/continue-${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
  return `claude/${all.join('-').slice(0, 40).replace(/-+$/, '')}`
}

/** The window whose folder holds the chat, deepest first: the one that opens the fresh chat. */
export function homeOf(targets: Target[], cwd: string): Target | undefined {
  const c = norm(cwd)
  return targets.filter(t => c === t.workspace || c.startsWith(`${t.workspace}/`)).sort((a, b) => b.workspace.length - a.workspace.length)[0]
}

// Past 90% of the compaction point, a turn's end is the last clean break before it compacts.
export const nearFull = (tokens: number, compactAt?: number) => !!compactAt && tokens >= compactAt * 0.9
// Past this the wrap-up has run long: hand off with whatever still runs listed.
const hardFull = (tokens: number, compactAt?: number) => !!compactAt && tokens >= compactAt * 0.97

const KEEP = 'Keep the handoff below in the summary word for word: it is the plan, the open tasks, the latest decisions and the branch of the work in progress. Never copy keys, tokens or passwords into the summary.'

type Shell = { id: string; command: string; output?: string }
type Result = { id: string; line: string }
// What the feed remembers between hooks; the chat's own part is saved to the store (saveFeed) so a reload keeps it.
const feed: {
  targets: Target[]; foundAt: number; lastLive: number; compactAt?: number; handedOff?: string; prompt?: string; ask?: string; requests: string[]; errors: string[]
  file?: string; plan?: string; brief?: string; tasks: Map<string, Task>; shells: Map<string, Shell>; results: Result[]; summary?: Summary
  restored?: string; pausing?: number; freshNote?: string; nudge?: { n: number; tasks: string }
} = { targets: [], foundAt: -Infinity, lastLive: -Infinity, tasks: new Map(), requests: [], errors: [], shells: new Map(), results: [] }

type Kept = { tasks?: Array<[string, Task]>; ask?: string; requests?: string[]; errors?: string[]; shells?: Shell[]; results?: Result[]; summary?: Summary; pausing?: number; at: number }
const FEEDS_KEPT = 20
const REQUESTS_KEPT = 10

/** This session's saved feed, once per session: a reloaded mod picks up where it was. */
export async function restoreFeed($: EngineInterface) {
  const id = await $.session.id()
  if (feed.restored === id) return
  // Another session in this process (a /clear): nothing of the last one carries over.
  const fresh = feed.restored !== undefined
  feed.restored = id
  const k = ((await Promise.resolve().then(() => $.store.get('feeds')).catch(() => undefined)) as Record<string, Kept> | undefined)?.[id]
  if (!k && !fresh) return
  feed.tasks = new Map(k?.tasks ?? [])
  feed.ask = k?.ask
  feed.requests = k?.requests ?? []
  feed.errors = k?.errors ?? []
  feed.shells = new Map((k?.shells ?? []).map(x => [x.id, x]))
  feed.results = k?.results ?? []
  feed.summary = k?.summary
  feed.pausing = k?.pausing
  feed.freshNote = undefined
  feed.nudge = undefined
  if (fresh) feed.plan = feed.file = feed.prompt = undefined
}

async function saveFeed($: EngineInterface) {
  const id = await $.session.id()
  const all = ((await $.store.get('feeds')) ?? {}) as Record<string, Kept>
  const mine: Kept = {
    tasks: [...feed.tasks], ask: feed.ask, requests: feed.requests.slice(-REQUESTS_KEPT), errors: feed.errors,
    shells: [...feed.shells.values()], results: feed.results, summary: feed.summary, pausing: feed.pausing, at: await $.clock.now(),
  }
  await $.store.set('feeds', Object.fromEntries(Object.entries({ ...all, [id]: mine }).sort((a, b) => b[1].at - a[1].at).slice(0, FEEDS_KEPT)))
}

/** Background shells this chat started and has not seen end: Bash run_in_background, ended by TaskStop or its notification. */
export function noteShell(tool: string, e: Record<string, unknown>, result: unknown, text: string) {
  if (tool === 'Bash' && e.run_in_background === true) {
    const r = (result ?? {}) as { backgroundTaskId?: unknown; backgroundOutputPath?: unknown }
    const id = typeof r.backgroundTaskId === 'string' ? r.backgroundTaskId : /background with ID: (\S+?)\.?(?:\s|$)/.exec(text)?.[1]
    if (!id) return
    const output = typeof r.backgroundOutputPath === 'string' ? r.backgroundOutputPath : /Output is being written to: (\S+)/.exec(text)?.[1]
    feed.shells.set(id, { id, command: String(e.command ?? '').slice(0, 200), ...(output ? { output } : {}) })
  } else if (tool === 'TaskStop' || tool === 'KillShell') {
    // Stopped or already gone; either way nothing runs under that id now.
    const id = e.task_id ?? e.shell_id
    if (typeof id === 'string') feed.shells.delete(id)
  }
}

export function shellsDone(text: string) {
  for (const m of text.matchAll(/<task-id>([^<]+)<\/task-id>[\s\S]*?<status>(?:completed|failed|killed|stopped)<\/status>/g)) feed.shells.delete(m[1] ?? '')
}

export const liveShells = () => [...feed.shells.values()]

// After the handoff: running work finishes here, new work starts in the next chat.

export const handoffDenial = (note?: string) => `Context is nearly full: no new tasks here. Running tasks finish, then this work continues in the next chat. ${note ? `Add new tasks to the handoff note instead (${note}).` : 'Add new tasks to the task list instead; they move to the next chat.'}`

/** The denial for new work once this chat wraps up or has handed off. */
async function heldBack($: EngineInterface) {
  const note = await handedOff($).catch(() => undefined)
  if (note) return handoffDenial(note)
  await restoreFeed($).catch(() => undefined)
  return feed.pausing !== undefined ? handoffDenial() : undefined
}
const freshStart = (note: string) => `Read ${note} fully before acting. Recreate each open task in it with the task tools first; in your first reply, restate the goal and tick each open task against the note, then carry on.`
// The hub's first prompt for a fresh chat names its note.
const FRESH = /^Continue from (.+?\.md): read it first/

const ERRORS_KEPT = 3
const ERROR_MAX = 500
export const errorEntry = (tool: string, text: string) => `${tool}: ${redact(text).slice(0, ERROR_MAX)}${text.length > ERROR_MAX ? ' (truncated, see transcript)' : ''}`

// This mod's own prompts start so; they are no requests of the user's.
const OWN = 'Switchboard: '
const PAUSE_MARK = `${OWN}context is nearly full`
const pausePrompt = (shells: Shell[]) => [
  `${PAUSE_MARK} and a fresh chat takes over after a clean pause. Finish the step you are on and start no new tasks or subagents.`,
  'Wait for running subagents to finish, or stop them with TaskStop.',
  shells.length ? `Stop these background shells with TaskStop before you end: ${shells.map(x => `${x.id} (${x.command})`).join(', ')}.` : 'Stop any background shell you started with TaskStop before you end.',
  'Update the task list so every open task has its real status; mark one completed only if a check proved it.',
  'Then end your reply with these lines and nothing after them:',
  'Goal: <the goal in one line>', 'Tests: <last test command and its result, or not run>', 'Decisions:', '- <pick>: <why>', 'Next: <the next action>',
].join('\n')

const ASK_RULE = 'When you need the user to answer or act, ask with the AskUserQuestion tool so it pops up in the terminal and Switchboard. Never end a turn with open tasks you can do yourself.'
// Same rule as Switchboard's progress.ts askedQuestion: the last paragraph, past a trailing fenced block, ends in '?'.
// Both test suites hold the same table of cases (agent-flow extension/test/progress.test.ts).
export const endsAsking = (text: string) => (text.replace(/\n*```[^\n]*\n(?:(?!```)[\s\S])*```\s*$/, '').trim().split(/\n\s*\n/).pop() ?? '').trim().endsWith('?')
// ponytail: a chat that keeps stopping without touching its tasks gets this many nudges, then waits for the user.
const NUDGES = 3
// The main chat's last answer, so a later compaction does not push past a question; a reload forgets it.
let lastAnswer = ''

/** A turn that ended with open tasks and nothing running is asked to carry on, unless it asked the user something or wrapped up. */
async function keepGoing($: EngineInterface, answer: string) {
  const tasks = JSON.stringify([...feed.tasks])
  if (feed.nudge?.tasks !== tasks) feed.nudge = undefined
  const open = [...feed.tasks.values()].filter(t => t.status !== 'completed')
  const n = feed.nudge?.n ?? 0
  if (!open.length || n >= NUDGES || endsAsking(answer) || /commit message[^\n]*\n+```/i.test(answer) || feed.shells.size || (await liveAgents($)).length) return
  feed.nudge = { n: n + 1, tasks }
  await $.prompt.submit({ text: `${OWN}you ended your turn with open tasks: ${open.slice(0, 10).map(t => t.subject.slice(0, 80)).join('; ')}. Keep working on them. ${ASK_RULE}` })
}

const wrapUp = (note: string) => `Context is nearly full and a fresh chat takes over. Start no new tasks or subagents. Wait for running tasks to finish, then append to ${note}: open tasks, decisions, dead ends (one line each with why), results of finished tasks and next steps. Then stop.`

type Handoffs = Record<string, { note: string; at: number }>
const HANDOFFS_KEPT = 20

/** The note this session handed off to, kept in the store so a reload still holds new work. */
async function handedOff($: EngineInterface): Promise<string | undefined> {
  const id = await $.session.id()
  return ((await $.store.get('handoffs')) as Handoffs | undefined)?.[id]?.note
}

async function rememberHandoff($: EngineInterface, id: string, note: string, at: number) {
  const all = { ...((await $.store.get('handoffs')) as Handoffs | undefined), [id]: { note, at } }
  await $.store.set('handoffs', Object.fromEntries(Object.entries(all).sort((a, b) => b[1].at - a[1].at).slice(0, HANDOFFS_KEPT)))
}

/** Tracks the lead's task list from its own tool calls; TodoWrite replaces it whole. */
export function noteTasks(tool: string, e: Record<string, unknown>, result: unknown) {
  if (tool === 'TodoWrite' && Array.isArray(e.todos)) {
    feed.tasks = new Map((e.todos as Array<{ content: string; status: string }>).map((t, i) => [`todo-${i}`, { subject: t.content, status: t.status }]))
  } else if (tool === 'TaskCreate') {
    const t = (result as { task?: { id?: string; subject?: string } } | undefined)?.task
    if (t?.id) feed.tasks.set(t.id, { subject: t.subject ?? String(e.subject), status: 'pending' })
  } else if (tool === 'TaskUpdate' && typeof e.taskId === 'string') {
    const t = feed.tasks.get(e.taskId)
    if (!t) return
    if (e.status === 'deleted') feed.tasks.delete(e.taskId)
    else feed.tasks.set(e.taskId, { subject: typeof e.subject === 'string' ? e.subject : t.subject, status: typeof e.status === 'string' ? e.status : t.status })
  }
}

const LIVE = new Set(['pending', 'running', 'waiting'])
const KEPT_TOOLS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskStop', 'KillShell'])
const RESULTS_KEPT = 8

/** Once, after the fresh chat's first turn: the note's open tasks it has not recreated, by subject. */
async function checkFresh($: EngineInterface) {
  const path = feed.freshNote
  if (!path) return
  feed.freshNote = undefined
  const note = String(await $.fs.read(path).catch(() => ''))
  const at = note.indexOf('## Open tasks')
  const end = note.indexOf('\n## ', at + 1)
  const want = [...note.slice(at, end < 0 ? undefined : end).matchAll(/^- \[ \] (.+) \([a-z ]+\)$/gm)].map(m => m[1] ?? '')
  const have = new Set([...feed.tasks.values()].filter(t => t.status !== 'completed').map(t => t.subject))
  const missing = at < 0 ? [] : want.filter(t => !have.has(t))
  if (!missing.length) return
  await $.ui.toast(`Fresh chat is missing ${missing.length} open task(s) from its note`)
  await $.prompt.submit({ text: `Switchboard: these open tasks from ${path} are not in your task list yet. Recreate each with the task tools now: ${missing.join('; ')}` })
}

const liveAgents = ($: EngineInterface) => Promise.resolve().then(() => $.agent.list()).then(list => list.filter(a => LIVE.has(a.status))).catch(() => [])

/** Subagents and shells still at work, each with where its output is, and the working tree's changes; either may be out of reach (a test, no git). */
async function whatIsLive($: EngineInterface, cwd: string, subagents: string) {
  const running = [
    ...(await liveAgents($)).map(a => `agent ${a.id} (${a.type}: ${a.description}), output ${subagents}/agent-${a.id}.jsonl`),
    ...liveShells().map(x => `shell ${x.id}: ${x.command}${x.output ? `, output ${x.output}` : ''}`),
  ]
  const changed = await Promise.resolve().then(() => $.process.run(['git', 'status', '--short'], { cwd, timeoutMs: 5_000 }))
    .then(r => (r.exitCode === 0 ? r.stdout.split('\n').filter(Boolean) : [])).catch(() => [])
  return { running, changed }
}

/** Remembers a plan this chat read or wrote, so its handoff names that plan and not one another chat touched last. */
export function notePlan(file: unknown) {
  if (typeof file === 'string' && /\/docs\/superpowers\/plans\/[^/]+\.md$/.test(norm(file))) feed.plan = norm(file)
}

const ASK = 'hub_ask'
const EDITS = new Set(['Edit', 'Write', 'NotebookEdit'])

async function discover($: EngineInterface) {
  const now = await $.clock.now()
  if (now - feed.foundAt < REDISCOVER_MS) return feed.targets
  feed.foundAt = now
  const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
  const dir = `${norm(home)}/.claude/switchboard`
  const files: Discovery[] = []
  for (const e of await $.fs.list(dir).catch(() => [])) {
    if (e.kind !== 'file' || !e.name.endsWith('.json') || e.name === 'workspaces.json') continue
    try { files.push(JSON.parse(String(await $.fs.read(`${dir}/${e.name}`)))) } catch { /* a file mid-write */ }
  }
  feed.targets = targetsOf(files)
  return feed.targets
}

async function post($: EngineInterface, body: Record<string, unknown>) {
  for (const t of await discover($)) {
    const sent = await $.http.fetch(`http://127.0.0.1:${t.port}/hub`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: t.token, ...body }),
    }).catch(() => undefined)
    // A closed window or a new token: look again next time.
    if (!sent || sent.status === 403) feed.foundAt = -Infinity
  }
}

async function postLive($: EngineInterface, usage: Pick<SessionUsage, 'context' | 'rateLimits' | 'cost'>) {
  const now = await $.clock.now()
  if (now - feed.lastLive < POST_EVERY_MS) return
  feed.lastLive = now
  await post($, {
    kind: 'live', sessionId: await $.session.id(), cwd: await $.session.cwd(), model: await $.session.model(),
    tokens: usage.context.tokens, compactAt: feed.compactAt, costUsd: usage.cost?.usd, prompt: feed.prompt, file: feed.file,
    limits: usage.rateLimits.map(({ kind, percentUsed, resetsAt }) => ({ kind, percentUsed, resetsAt })),
  })
}

async function count($: EngineInterface, owner: string) {
  const uses = ((await $.store.get('uses')) ?? {}) as Record<string, number>
  await $.store.set('uses', { ...uses, [owner]: (uses[owner] ?? 0) + 1 })
}

async function poll($: EngineInterface) {
  const id = await $.session.id()
  for (const t of await discover($)) {
    const got = await $.http.fetch(`http://127.0.0.1:${t.port}/hub/inbox?session=${encodeURIComponent(id)}&token=${t.token}`).catch(() => undefined)
    if (!got?.ok) continue
    try { await deliver($, JSON.parse(got.text) as InboxItem[]) } catch { /* not a list */ }
  }
}

/** The window holding this chat's folder, asked for its brief or an answer; this project only. */
async function askHome($: EngineInterface, route: 'brief' | 'ask', q?: string) {
  const cwd = norm(await $.session.cwd())
  const home = homeOf(await discover($), cwd)
  if (!home) return undefined
  const query = `cwd=${encodeURIComponent(cwd)}&session=${encodeURIComponent(await $.session.id())}${q ? `&q=${encodeURIComponent(q)}` : ''}&token=${home.token}`
  const got = await $.http.fetch(`http://127.0.0.1:${home.port}/hub/${route}?${query}`).catch(() => undefined)
  return got?.ok ? got.text : undefined
}

async function start($: EngineInterface) {
  if ((await $.store.get('since')) === undefined) await $.store.set('since', new Date(await $.clock.now()).toISOString().slice(0, 10))
  const usage = await $.session.usage({ breakdown: 'summary' })
  feed.compactAt = usage.context.breakdown?.autoCompactThreshold
  await postLive($, usage)
  const b = usage.context.breakdown
  if (b) await post($, { kind: 'diet', ...dietOf(b, ((await $.store.get('uses')) ?? {}) as Record<string, number>) })
}

async function readNote($: EngineInterface) {
  await restoreFeed($)
  const cwd = norm(await $.session.cwd())
  const dir = `${cwd}/docs/superpowers/plans`
  // The plan changed last, as the Hub's Plan card picks it; by name, an undated file outsorts every dated one.
  // The plan this chat opened wins; any other chat may have touched a newer one.
  const plan = feed.plan?.startsWith(`${dir}/`) ? undefined : (await $.fs.list(dir).catch(() => [])).filter(e => e.kind === 'file' && e.name.endsWith('.md')).sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
  const planPath = feed.plan?.startsWith(`${dir}/`) ? feed.plan : plan ? `${dir}/${plan.name}` : undefined
  const planText = planPath ? String(await $.fs.read(planPath).catch(() => '')) : undefined
  const head = String(await $.fs.read(`${cwd}/.git/HEAD`).catch(() => ''))
  const branch = /^ref: refs\/heads\/(.+)$/m.exec(head)?.[1]
  const id = await $.session.id()
  const home = norm((await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '')
  // Claude Code's own layout: the project root with every non-alphanumeric as '-'; a chat's subagents under <id>/subagents.
  const root = norm(await Promise.resolve().then(() => $.session.root()).catch(() => cwd))
  const transcript = `${home}/.claude/projects/${root.replace(/[^a-zA-Z0-9]/g, '-')}/${id}.jsonl`
  const subagents = `${transcript.slice(0, -'.jsonl'.length)}/subagents`
  const { running, changed } = await whatIsLive($, cwd, subagents)
  const tasks = [...feed.tasks.values()]
  const note = ensureOpenTasks(handoffNote({
    project: cwd.split('/').pop() ?? cwd, cwd, branch, planPath, planText, session: id, now: await $.clock.now(),
    tasks, ask: feed.ask, requests: feed.requests, errors: feed.errors, running, changed, transcript,
    summary: feed.summary, results: feed.results.map(r => `${r.line} (${subagents}/agent-${r.id}.jsonl)`),
  }), tasks)
  return { note, planPath, firstTask: planText ? openTasks(planText)[0]?.title : undefined }
}

/** The window that opens the fresh chat and its keep settings; undefined when none holds this folder. */
async function keepOf($: EngineInterface) {
  const home = homeOf(await discover($), norm(await $.session.cwd()))
  if (!home) return undefined
  const got = await $.http.fetch(`http://127.0.0.1:${home.port}/hub/keep?token=${home.token}`).catch(() => undefined)
  if (!got?.ok) return undefined
  return { home, keep: JSON.parse(got.text) as { onFull?: string; freshBranch?: boolean } }
}

/**
 * The end of a main turn. Near full in fresh chat mode, the chat is first asked to reach a clean pause;
 * a later turn hands off once no subagent runs and the shells were asked to stop once, or at once past the hard limit.
 */
async function settle($: EngineInterface, answer: string) {
  const id = await $.session.id()
  if (feed.handedOff === id || (await handedOff($).catch(() => undefined))) return
  await restoreFeed($)
  const usage = await $.session.usage({ breakdown: 'summary' })
  // A reloaded mod missed session.start.
  feed.compactAt ??= usage.context.breakdown?.autoCompactThreshold
  const tokens = usage.context.tokens ?? 0
  const near = nearFull(tokens, feed.compactAt)
  if (!near && feed.pausing === undefined) await keepGoing($, answer)
  // undefined: no window answered, which says nothing about the mode.
  const kept = near ? await keepOf($) : undefined
  if (feed.pausing === undefined) {
    if (kept?.keep.onFull !== 'fresh') return
    feed.pausing = 0
    await saveFeed($).catch(() => undefined)
    await $.prompt.submit({ text: pausePrompt(liveShells()) })
    return
  }
  // Compact mode, or a compaction freed the context: the pause is off and new work may start.
  if (!near || (kept && kept.keep.onFull !== 'fresh')) {
    feed.pausing = undefined
    await saveFeed($).catch(() => undefined)
    return
  }
  // No answer from the window: hold the pause and look again next turn.
  if (!kept) return
  feed.summary = summaryOf(answer) ?? feed.summary
  const agents = (await liveAgents($)).length
  // Only shells left, which send no turn of their own (a dev server never ends): ask once, then go and list them.
  if (!agents && feed.shells.size && !feed.pausing && !hardFull(tokens, feed.compactAt)) {
    feed.pausing = 1
    await saveFeed($).catch(() => undefined)
    await $.prompt.submit({ text: `${OWN}stop these background shells with TaskStop now, then end your reply: ${liveShells().map(x => `${x.id} (${x.command})`).join(', ')}.` })
    return
  }
  await saveFeed($).catch(() => undefined)
  if (!agents || hardFull(tokens, feed.compactAt)) await maybeHandoff($)
}

// One handoff at a time: the hub's inbox and settle can both ask before the first has written its note.
let handingOff: Promise<void> | undefined
/** Writes the note and has this chat's window open the next one: from settle in fresh chat mode, or whenever the hub asks (force). */
const maybeHandoff = ($: EngineInterface, force = false) => (handingOff ??= handoff($, force).finally(() => { handingOff = undefined }))

async function handoff($: EngineInterface, force: boolean) {
  const id = await $.session.id()
  const cwd = norm(await $.session.cwd())
  // A reload forgets feed; the store still knows.
  const done = await handedOff($).catch(() => undefined)
  if (feed.handedOff === id || done) {
    // Asked again by hand: the window may have lost the first post or still be waiting on subagents.
    const kept = force && done ? await keepOf($) : undefined
    if (kept) await $.http.fetch(`http://127.0.0.1:${kept.home.port}/hub`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: kept.home.token, kind: 'handoff', sessionId: id, cwd, note: done, force: true }),
    }).catch(() => undefined)
    return
  }
  const kept = await keepOf($)
  if (!kept || (!force && kept.keep.onFull !== 'fresh')) return
  const { home, keep } = kept
  feed.handedOff = id
  const { note, planPath, firstTask } = await readNote($)
  const now = await $.clock.now()
  const home_ = norm((await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '')
  const iso = new Date(now).toISOString()
  const label = (planWords(planPath).slice(0, 3).join('-') || words(firstTask ?? '').slice(0, 3).join('-') || 'continued').slice(0, 40).replace(/-+$/, '')
  const base = cwd.split('/').pop() ?? ''
  const project = base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
  // A folder like '/', '..' or 'C:' gets a safe one, so the note stays one level under handoffs/.
  const dir = /^\.{0,2}$|:/.test(base) ? project || 'root' : base
  // Outside every repo, so a note is never committed. The hub matches a note by its -<id8>.md ending.
  const path = `${home_}/.claude/handoffs/${dir}/${[iso.slice(0, 10), iso.slice(11, 16).replace(':', ''), project, label, id.slice(0, 8)].filter(Boolean).join('-')}.md`
  await $.fs.write(path, note)
  await rememberHandoff($, id, path, now).catch(() => undefined)
  await $.http.fetch(`http://127.0.0.1:${home.port}/hub`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: home.token, kind: 'handoff', sessionId: id, cwd, note: path, plan: planPath, task: firstTask, branch: keep.freshBranch ? branchFor(planPath, firstTask, new Date(now)) : undefined, ...(force ? { force: true } : {}) }),
  }).catch(() => undefined)
  await $.ui.toast(`Context nearly full: a fresh chat continues from ${path}`)
}

async function afterTool($: EngineInterface, command: string, output: string) {
  const run = jevRun(command, output)
  const credits = creditsIn(output)
  if (run || credits !== undefined) await post($, { kind: 'jev', ...(run ?? { run: false }), creditsLeftUsd: credits, sessionId: await $.session.id(), cwd: norm(await $.session.cwd()) })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await start($)
    feed.brief = (await askHome($, 'brief').catch(() => undefined)) || undefined
    await $.tool.register({
      name: ASK,
      description: "Ask Switchboard's brain about this project's other live chats: who is on what, which files they are editing, what to pick up next. One short paid Haiku call per question; it knows nothing outside this project.",
      inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    })
    $.clock.every(POLL_MS, () => poll($))
    return started
  })

  on('session.measure', async ($, e, next) => {
    await postLive($, e)
    return next(e)
  })

  // Answers without next, so the generic hook's pause check below never sees it.
  on('tool.call', { tool: `mcp__usage-meter__${ASK}` }, async ($, e) => {
    const held = pausedDenial(String(e.tool), (await readCompany($).catch(() => company)).paused)
    if (held) return { deny: held }
    const q = (e as { question?: unknown }).question
    if (typeof q !== 'string' || !q.trim()) return { deny: 'Give a question.' }
    const answer = await askHome($, 'ask', q.slice(0, 500)).catch(() => undefined)
    return { result: answer ?? 'No Switchboard window holds this folder, so the brain cannot answer.' }
  })

  on('prompt.submit', async ($, e, next) => {
    shellsDone(e.text)
    // Notifications and this mod's own wrap-up are no requests of the user's.
    if (e.isMeta || e.command || e.origin?.kind === 'task-notification' || e.text.startsWith(OWN) || e.text.startsWith('<task-notification>')) return next(e)
    await restoreFeed($).catch(() => undefined)
    feed.nudge = undefined
    feed.prompt = redact(e.text).replace(/\s+/g, ' ').slice(0, 200)
    feed.ask = redact(e.text)
    feed.requests.push(feed.ask)
    const fresh = FRESH.exec(e.text)?.[1]
    if (fresh) feed.freshNote = fresh
    await saveFeed($).catch(() => undefined)
    const note = await handedOff($).catch(() => undefined)
    const told = note ? wrapUp(note) : fresh ? freshStart(fresh) : undefined
    return next(told ? { ...e, context: [...(e.context ?? []), told] } : e)
  })

  // The brief, read once at session start, goes last so the cached prompt before it stays whole.
  // Who to delegate to comes from ~/.claude/CLAUDE.md (kit/rules.md), not from here.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const sections = [...composed.sections, { id: 'usage-meter:asks', text: ASK_RULE, scope: 'session' as const }]
    return { sections: feed.brief ? [...sections, { id: 'usage-meter:brief', text: feed.brief, scope: 'session' as const }] : sections }
  })

  // Each role runs on its own model, within its daily budget; counts go to the hub.
  // A resumed agent is no new start, and its model is fixed.
  on('agent.spawn', async ($, e, next) => {
    if (e.resume) return next(e)
    const held = await heldBack($)
    if (held) return { deny: held }
    const role = e.subagentType
    const { budgets } = await readCompany($)
    const { day, used } = await startsToday($)
    const denial = budgetDenial(role, used, budgets)
    if (denial) return { deny: denial }
    const model = roleModel(role)
    const started = await next(model ? { ...e, model } : e)
    if (started.deny !== undefined) return started
    // ponytail: read-modify-write, parallel spawns can undercount; use an atomic increment if the store gains one.
    const counted = { ...used, [role]: (used[role] ?? 0) + 1 }
    await $.store.set('starts', { day, used: counted })
    await post($, { kind: 'agent', sessionId: await $.session.id(), day, used: counted }).catch(() => undefined)
    return started
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    const held = pausedDenial(tool, (await readCompany($).catch(() => company)).paused)
    if (held) return { deny: held }
    if (tool === 'Bash' && (e as { run_in_background?: unknown }).run_in_background === true) {
      const held = await heldBack($)
      if (held) return { deny: held }
    }
    const file = (e as { file_path?: unknown; notebook_path?: unknown }).file_path ?? (e as { notebook_path?: unknown }).notebook_path
    if (EDITS.has(tool) && typeof file === 'string') feed.file = norm(file)
    notePlan(file)
    if (tool.startsWith('mcp__')) await count($, ownerOf(tool)).catch(() => undefined)
    await restoreFeed($).catch(() => undefined)
    const ran = await next(e)
    if (ran.deny === undefined) {
      noteTasks(tool, e as Record<string, unknown>, ran.result)
      noteShell(tool, e as Record<string, unknown>, ran.result, ran.text ?? '')
    }
    if (ran.isError && ran.text) feed.errors = [...feed.errors, errorEntry(tool, ran.text)].slice(-ERRORS_KEPT)
    if (KEPT_TOOLS.has(tool) || (tool === 'Bash' && (e as { run_in_background?: unknown }).run_in_background === true) || ran.isError) await saveFeed($).catch(() => undefined)
    const command = (e as { command?: unknown }).command
    if (tool === 'Bash' && typeof command === 'string' && command.includes('jev.py') && ran.deny === undefined) {
      await afterTool($, command, ran.text ?? '')
    }
    if (tool === 'mcp__openrouter__get-credits' && ran.deny === undefined) await afterTool($, '', ran.text ?? '')
    return ran
  })

  // Every compaction of the main chat keeps the handoff, whatever started it.
  on('session.compact', async ($, e, next) => {
    if (e.agentId) return next(e)
    const handoff = await readNote($).catch(() => undefined)
    if (!handoff) return next(e)
    return next({ ...e, instructions: [e.instructions, `${KEEP}\n\n${handoff.note}`].filter(Boolean).join('\n\n') })
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    if (e.agentId) {
      // A subagent's report, one line; its whole transcript stays on disk.
      const line = redact(e.answer.split('\n').find(l => l.trim()) ?? '').trim().slice(0, 160)
      if (line) feed.results = [...feed.results.filter(r => r.id !== e.agentId), { id: e.agentId, line }].slice(-RESULTS_KEPT)
    } else if (e.reason === 'answer') {
      lastAnswer = e.answer
      await checkFresh($).catch(() => undefined)
      await settle($, e.answer).catch(() => undefined)
    }
    return done
  })

  on('skill.prompt', async ($, e, next) => {
    await count($, e.pluginName ?? e.skill).catch(() => undefined)
    return next(e)
  })
}
