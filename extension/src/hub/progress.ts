/**
 * A chat's progress from its own hook events, no model call: the roles it delegated to,
 * its task list, and whether it is working, done, waiting on Kenneth or idle.
 * Pure, so the tests drive it with recorded payloads; hub-service.ts keeps the results.
 */
import { createHash } from 'crypto'
import type { Ask, AskQuestion, BgJob, Choice, ChatProgress, OtherPick, Report, RoleStep, TaskRow, TestRun, ToolCall } from './types'

type Payload = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const STATUS = new Set(['pending', 'in_progress', 'completed'])
const RESET = new Set(['startup', 'clear'])
const ASKS = new Set(['permission_prompt', 'elicitation_dialog'])
// Tools with a dialog of their own: no Yes/No buttons, answer in the terminal.
const OWN_DIALOG = new Set(['AskUserQuestion', 'ExitPlanMode'])
const PREVIEW_MAX = 300
// ponytail: a background subagent that never sends SubagentStop counts as gone after an hour, at the lead's next Stop;
// a real one running longer shows done early. Raise it if that happens. Background shells and monitors share the cap.
export const RUNNING_CAP_MS = 60 * 60 * 1000
const BG_TOOLS = new Set(['Monitor'])
const ENDED = /<status>(completed|failed|killed|stopped)<\/status>/

/** The tool_use_ids a transcript's task-notifications report as ended. Monitor events carry no status, so they never count. */
export function finishedJobs(transcript: string): string[] {
  const ids = transcript.split('<task-notification>').slice(1).flatMap(n => {
    const body = n.split('</task-notification>')[0]
    const id = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(body)?.[1]
    return id && ENDED.test(body) ? [id] : []
  })
  return [...new Set(ids)]
}

/** A lead call that keeps running after it returns: a Monitor, or a Bash sent to the background. */
function bgJob(tool: string, payload: Payload, now: number): BgJob | undefined {
  const id = str(payload.tool_use_id)
  const input = (payload.tool_input ?? {}) as Payload
  const res = payload.tool_response as Payload | undefined
  if (!id || !(BG_TOOLS.has(tool) || (tool === 'Bash' && (str(res?.backgroundTaskId) || input.run_in_background === true)))) return undefined
  const label = cut(input.description, 60), task = str(res?.backgroundTaskId)
  return { id, ...(label ? { label } : {}), ...(task ? { task } : {}), startedAt: now }
}

// One step of a shell chain, past env assignments.
const RUNNER = /^(?:(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+test\b|(?:npx\s+|bunx\s+|pnpm\s+exec\s+)?(?:tsx|node)\s(?:.*\s)?--test\b|(?:npx\s+|bunx\s+|pnpm\s+exec\s+|yarn\s+)?(?:vitest|jest)\b|(?:python3?\s+-m\s+|uv\s+run\s+)?pytest\b|go\s+test\b|cargo\s+test\b|claude\s+plugin\s+test\b)/
/** Whether a Bash command runs tests: a runner as the command word of some step, quoted text dropped first. Not a full shell parse. */
export const isTestCommand = (cmd: string) => cmd.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""').split(/&&|\|\||[;|(\n]/).some(s => RUNNER.test(s.trim().replace(/^(?:\w+=\S*\s+)+/, '')))

// First failing test name, per runner: tap, node spec, vitest, jest, pytest, go, cargo.
const FIRST = [/^\s*not ok \d+ - (.+?)\s*(?:#.*)?$/m, /^\s*✖ (?!failing tests)(.+?)(?:\s+\([\d.]+m?s\))?$/m, /^\s*[×✕✗] (.+?)(?:\s+\d+(?:\.\d+)?m?s)?$/m,
  /^\s*● (.+)$/m, /^FAILED \S*::(\S+)/m, /^\s*--- FAIL: (\S+)/m, /^test (\S+) \.\.\. FAILED$/m]
const num = (re: RegExp, s: string) => { const m = re.exec(s); return m ? Number(m[1]) : undefined }

/** Counts, the first failing name and the last 8 lines of a test run's output, when it says. */
export function testOutcome(out: string): { failed?: number; total?: number; first?: string; tail: string[] } {
  const failed = num(/^[#ℹ]\s*fail (\d+)/m, out) ?? num(/(\d+) (?:failed|failing)\b/, out)
  const passed = num(/(\d+) (?:passed|passing)\b/, out)
  const total = num(/(\d+) total\b/, out) ?? num(/^[#ℹ]\s*tests (\d+)/m, out) ?? num(/^\s*Tests?\s.*\((\d+)\)/m, out) ?? (passed !== undefined ? passed + (failed ?? 0) : undefined)
  const first = FIRST.map(re => re.exec(out)?.[1]).find(Boolean)
  const tail = out.split('\n').map(l => plainText(l).trimEnd().slice(0, 160)).filter(l => l.trim()).slice(-8)
  return { ...(failed !== undefined ? { failed } : {}), ...(total !== undefined ? { total } : {}), ...(first ? { first: cut(first, 120)! } : {}), tail }
}

/** A finished test command; a pipe into tail exits 0, so a failed count counts too. Background and interrupted runs say nothing yet. */
function testRun(event: string, payload: Payload, now: number): TestRun | undefined {
  const command = str((payload.tool_input as Payload | undefined)?.command)
  if (payload.tool_name !== 'Bash' || !command || !isTestCommand(command)) return undefined
  const res = (payload.tool_response ?? {}) as Payload
  if (payload.is_interrupt === true || (event === 'PostToolUse' && (res.interrupted === true || str(res.backgroundTaskId)))) return undefined
  const out = event === 'PostToolUse' ? `${res.stdout ?? ''}\n${res.stderr ?? ''}` : String(payload.error ?? '').replace(/^Exit code \d+\n?/, '')
  const { tail, ...o } = testOutcome(out)
  return { command: cut(command, 160)!, ok: event === 'PostToolUse' && !o.failed, at: now, ...o, ...(tail.length ? { tail } : {}) }
}

/** Nothing runs any more: Done if the lead's last turn finished the work, else idle. */
const settled = (p: ChatProgress, now: number): ChatProgress => p.finishing ? { ...p, state: 'done', finishedAt: now } : { ...p, state: 'idle' }

/** The fenced block after a "Commit message" heading in the chat's last message. */
export function commitMessage(text: string): string | undefined {
  const m = /commit message[^\n]*\n+```[^\n]*\n([\s\S]*?)```/i.exec(text)
  return m?.[1].trim() || undefined
}

/**
 * The question a message ends on: its last paragraph, past any trailing fenced block, when that ends in '?'.
 * claude-mods usage-meter/hooks/register.ts endsAsking is the same rule; both test suites share one table of cases.
 */
export function askedQuestion(text: string): string | undefined {
  const last = text.replace(/\n*```[^\n]*\n(?:(?!```)[\s\S])*```\s*$/, '').trim().split(/\n\s*\n/).pop()?.trim() ?? ''
  if (!last.endsWith('?')) return undefined
  return cut(last.split(/(?<=[.!?])\s+/).pop(), PREVIEW_MAX)
}

const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/
// A whole section that only says so is empty; an item that merely opens with "Nothing" is real.
const NONE = /^\(?(none|nothing|n\/a|no (open |remaining |more )?(items?|tasks?|work))\)?[.!]?$/i
const REPORT_ITEM = 160, REPORT_MAX = 12
const sectionOf = (label: string): keyof Report | null => /^done$/i.test(label) ? 'done' : /^(left|remaining|open|todo)$/i.test(label) ? 'left' : null

/** A standup's Done and Left items: under a heading line ("**Left (needs you)**", "## Done", "Left:") or after an inline "Left: item". Undefined when the message has neither. */
export function standup(text: string): Report | undefined {
  const out: Report = { done: [], left: [] }
  let at: keyof Report | null = null, found = false, fence = false
  const add = (v: string) => {
    const item = cut(v.replace(/\*\*|__/g, ''), REPORT_ITEM)
    // "Three are new from this chat:" heads the items under it.
    if (item?.endsWith(':')) return
    if (at && item && out[at].length < REPORT_MAX) out[at].push(item)
  }
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (t.startsWith('```')) { fence = !fence; at = null; continue }
    if (fence) continue
    // Heading on its own line: "## Left", "**Left (needs you)**", "**Left for you:**", "Left:".
    const own = /^#{1,6}\s+(.+)$/.exec(t)?.[1] ?? /^(?:\*\*|__)([^*_]+?)(?:\*\*|__):?$/.exec(t)?.[1] ?? /^(\w+):$/.exec(t)?.[1]
    if (own !== undefined) {
      at = sectionOf(own.replace(/\*\*|__/g, '').trim().split(/[\s(:]/)[0])
      found ||= !!at
      continue
    }
    // Inline label: "Left: item", "**Left:** item" or "- **Left:** item".
    const bare = t.replace(/^(?:[-*+]|\d+[.)])\s+/, '')
    const inline = /^(?:\*\*|__)?(\w+)(?::(?:\*\*|__)|(?:\*\*|__)?:)\s*(.+)$/.exec(bare)
    if (inline && sectionOf(inline[1])) {
      at = sectionOf(inline[1]); found = true
      add(inline[2])
      continue
    }
    // "- **Risks:** none" next to "- **Left:** ..." is another section, not a Left item.
    if (inline && bare !== t && /^(\*\*|__)/.test(bare)) { at = null; continue }
    const item = ITEM.exec(line)
    if (item) add(item[1])
    else if (t && at && /^\s/.test(line) && out[at].length) out[at][out[at].length - 1] = cut(`${out[at][out[at].length - 1]} ${t}`, REPORT_ITEM)!
    else if (t && !t.endsWith(':')) at = null
  }
  for (const k of ['done', 'left'] as const) if (out[k].length === 1 && NONE.test(out[k][0])) out[k] = []
  return found ? out : undefined
}

function rawTasks(p: ChatProgress, tool: string, input: Payload): TaskRow[] {
  if (tool === 'TodoWrite' && Array.isArray(input.todos)) {
    return input.todos.flatMap((t, i) => {
      const o = t as Payload
      const subject = str(o.content) ?? str(o.subject)
      return subject ? [{ id: String(i + 1), subject, status: STATUS.has(String(o.status)) ? o.status as TaskRow['status'] : 'pending' }] : []
    })
  }
  // ponytail: ids are counted here the way Claude Code numbers tasks (1, 2, ...); a chat that
  // deletes tasks can drift. Read the TaskCreate result instead if that ever shows up.
  if (tool === 'TaskCreate') {
    const subject = str(input.subject)
    return subject ? [...p.tasks, { id: String(p.tasks.length + 1), subject, status: 'pending' }] : p.tasks
  }
  if (tool === 'TaskUpdate') {
    const id = str(input.taskId)
    return p.tasks.map(t => t.id !== id ? t : {
      ...t,
      ...(STATUS.has(String(input.status)) ? { status: input.status as TaskRow['status'] } : {}),
      ...(str(input.subject) ? { subject: str(input.subject)! } : {}),
      ...(str(input.owner) ? { role: str(input.owner) } : {}),
    })
  }
  return p.tasks
}

/** The task list after a call, with start and finish times kept (TodoWrite rewrites the list, so rows match by subject). */
function tasksFrom(p: ChatProgress, tool: string, input: Payload, now: number): TaskRow[] {
  const next = rawTasks(p, tool, input)
  if (next === p.tasks) return next
  return next.map(t => {
    const was = p.tasks.find(o => o.id === t.id && o.subject === t.subject) ?? p.tasks.find(o => o.subject === t.subject)
    const startedAt = was?.startedAt ?? (t.status !== 'pending' ? now : undefined)
    const doneAt = t.status === 'completed' ? was?.doneAt ?? now : undefined
    const { startedAt: _s, doneAt: _d, ...rest } = t
    return { ...rest, ...(startedAt ? { startedAt } : {}), ...(doneAt ? { doneAt } : {}) }
  })
}

/** A short, safe label for what a tool call touches; never file contents or prompts (the hub is read over the LAN). Kenneth's own asks ride on ChatProgress.asked, token gated. */
export function toolTarget(tool: string, input: Payload): string | undefined {
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
  let t: string | undefined
  if (tool === 'Bash') t = str(input.command)?.slice(0, 40)
  else if (tool === 'WebFetch') { try { t = new URL(String(input.url)).host } catch { t = undefined } }
  else if (tool === 'Agent' || tool === 'Task') t = str(input.subagent_type) ?? str(input.description)
  else t = str(input.pattern) ?? path?.split('/').filter(Boolean).slice(-2).join('/')
  return t ? plainText(t).slice(0, 48).trim() || undefined : undefined
}

const cut = (v: unknown, n: number) => { const t = str(v); return t ? plainText(t).slice(0, n).trim() || undefined : undefined }
/** Ties a permission prompt to the tool call it is for, so that call's end clears it. */
const callKey = (tool: string, input: unknown) => createHash('sha1').update(`${tool}\n${JSON.stringify(input ?? {})}`).digest('hex').slice(0, 12)

/** What a permission prompt will run: the command, path or URL, cut short. */
export function askPreview(input: Payload): string | undefined {
  return cut(input.command ?? input.file_path ?? input.notebook_path ?? input.url ?? input.path ?? input.pattern, PREVIEW_MAX)
}

/** The terminal's option 2 is the first suggestion; only rule and folder ones are known to read this way. */
function alwaysLabel(s: Payload | undefined): string | undefined {
  if (s?.type === 'addRules' && Array.isArray(s.rules)) {
    const r = s.rules[0] as Payload | undefined
    const what = cut(r?.ruleContent, 80) ?? cut(r?.toolName, 80)
    return what && `Yes, and don't ask again for: ${what}`
  }
  if (s?.type === 'addDirectories' && Array.isArray(s.directories)) {
    const dir = cut(s.directories[0], 120)?.split('/').filter(Boolean).pop()
    return dir && `Yes, and always allow access to ${dir}/ from this project`
  }
  return undefined
}

/** A PermissionRequest as the terminal shows it: Yes, maybe a don't-ask-again, No. */
export function permissionAsk(payload: Payload, now: number): Ask | undefined {
  const tool = str(payload.tool_name)
  if (!tool || OWN_DIALOG.has(tool)) return undefined
  const input = (payload.tool_input ?? {}) as Payload
  const sugg = Array.isArray(payload.permission_suggestions) ? payload.permission_suggestions[0] as Payload : undefined
  const always = alwaysLabel(sugg)
  const preview = askPreview(input)
  return { id: `${now.toString(36)}.${callKey(tool, payload.tool_input)}`, kind: 'permission', tool: cut(tool, 60)!, ...(preview ? { preview } : {}), options: ['Yes', ...(always ? [always] : []), 'No'] }
}

/** An AskUserQuestion's questions, capped; undefined when any is unreadable, since the keys go one per question. */
export function questionAsk(id: string, input: Payload): Ask | undefined {
  const raw = Array.isArray(input.questions) ? input.questions.slice(0, 4) : []
  const questions: AskQuestion[] = raw.flatMap(q => {
    const o = (q ?? {}) as Payload
    const question = cut(o.question, PREVIEW_MAX)
    const options = (Array.isArray(o.options) ? o.options : []).slice(0, 8).map(x => cut((x as Payload)?.label, 80) ?? '')
    if (!question || !options.length || options.includes('')) return []
    const header = cut(o.header, 40)
    return [{ ...(header ? { header } : {}), question, options, ...(o.multiSelect === true ? { multiSelect: true } : {}) }]
  })
  return questions.length && questions.length === raw.length ? { id: cut(id, 80) ?? id, kind: 'question', tool: 'AskUserQuestion', options: [], questions } : undefined
}

export const OTHER_MAX = 200
/** Other text as it may go into a terminal: no control characters (so no escapes or newlines), one line, cut short. */
// Cut by code point, so an emoji at the cut is never halved.
export const otherText = (s: string) => Array.from(s.replace(/[\p{Cc}\u2028\u2029]/gu, ' ').replace(/\s+/g, ' ').trim()).slice(0, OTHER_MAX).join('').trim()

const DOWN = '\x1b[B'
const isOther = (c: Choice[number]): c is OtherPick => typeof c === 'object' && !Array.isArray(c)

/**
 * The keys an answer takes in the terminal, or why it cannot be typed. Checked against claude 2.1.314:
 * a permission dialog takes 1 for Yes and 2 for its first suggestion; No has no fixed number (auto mode's
 * option sits before it), so it goes as Esc, which the dialog reads as No.
 * AskUserQuestion: a single-select question takes the option's number and moves on; its Other (Type something,
 * one past the options) takes the number, the text and Enter. A multiSelect question toggles by number without
 * moving the cursor, which stays on row 1; Down walks to Type something (typing ticks it) and on to Next, then
 * Enter. Several questions, or any multiSelect one, end on a review whose option 1 is Submit.
 */
export function askKeys(ask: Ask, picked: Choice): string[] | string {
  const bad = 'that is not one of the options'
  if (ask.kind === 'permission') {
    const i = picked[0]
    if (picked.length !== 1 || typeof i !== 'number' || !(i >= 0 && i < ask.options.length)) return bad
    return [i === ask.options.length - 1 ? '\x1b' : String(i + 1)]
  }
  const qs = ask.questions ?? []
  if (picked.length !== qs.length) return bad
  const keys: string[] = []
  for (const [n, q] of qs.entries()) {
    const c = picked[n], n1 = q.options.length
    const other = isOther(c) ? otherText(String(c.other ?? '')) : undefined
    if (other === '') return 'type something for Other'
    const picks = isOther(c) ? c.picks ?? [] : [c].flat()
    if (!picks.every(i => Number.isInteger(i) && i >= 0 && i < n1) || new Set(picks).size !== picks.length) return bad
    if (!q.multiSelect) {
      if (Array.isArray(c)) return bad
      if (other !== undefined && !picks.length) keys.push(String(n1 + 1), other, '\r')
      else if (picks.length === 1 && other === undefined) keys.push(String(picks[0] + 1))
      else return bad
      continue
    }
    if (!picks.length && other === undefined) return 'pick at least one'
    keys.push(...picks.map(i => String(i + 1)))
    if (other !== undefined) keys.push(...Array(n1).fill(DOWN), other, DOWN, '\r')
    else keys.push(...Array(n1 + 1).fill(DOWN), '\r')
  }
  return qs.length > 1 || qs.some(q => q.multiSelect) ? [...keys, '1'] : keys
}

// ponytail: newest MAX_ASKS kept; more parallel prompts than that lose the oldest until Stop clears them.
const MAX_ASKS = 6
const ASKED_ITEM = 200, ASKED_MAX = 8
/** StopFailure errors that clear up by waiting; hub-service.ts retries these after the reset. */
export const LIMITS = new Set(['rate_limit'])
const LIMIT_TEXT = 'Usage limit hit. It continues by itself after the limit resets.'
const NO_ASK = { question: undefined, ask: undefined, asks: undefined }
const askText = (a: Ask) => a.kind === 'question' ? a.questions![0].question : `Claude needs your permission to use ${a.tool}`
/** The terminal shows waiting prompts one at a time, oldest first; ask is that one. */
function withAsks(p: ChatProgress, asks: Ask[]): ChatProgress {
  const q = asks.slice(-MAX_ASKS)
  return q.length ? { ...p, state: 'needs-you', question: askText(q[0]), ask: q[0], asks: q } : { ...p, state: 'working', ...NO_ASK, waiting: undefined }
}
const pendingAsks = (p: ChatProgress) => p.asks ?? (p.ask ? [p.ask] : [])

/** p with a prompt from the ask tool, once. */
export const addAsk = (p: ChatProgress, ask: Ask): ChatProgress => pendingAsks(p).some(a => a.id === ask.id) ? p : withAsks(p, [...pendingAsks(p), ask])

/** p without the prompt answered from Switchboard; the next one waiting shows. */
export function dropAsk(p: ChatProgress, askId: string): ChatProgress {
  const asks = pendingAsks(p)
  return asks.some(a => a.id === askId) ? withAsks(p, asks.filter(a => a.id !== askId)) : p
}

/** Running subagents always stay; finished ones only the newest MAX_DONE. */
const MAX_DONE = 12
/** Tool calls kept per chat, for the Lanes timeline; each is tool, a 48-char target, role and time (about 90 bytes). */
export const TOOLS_MAX = 200
function trim(roles: RoleStep[]): RoleStep[] {
  let drop = roles.filter(r => r.state === 'done').length - MAX_DONE
  return drop > 0 ? roles.filter(r => r.state !== 'done' || drop-- <= 0) : roles
}

/** The next progress for one hook payload; undefined once the chat has ended. */
export function step(prev: ChatProgress | undefined, payload: Payload, now: number): ChatProgress | undefined {
  const sessionId = str(payload.session_id)
  const event = str(payload.hook_event_name)
  if (!sessionId || !event) return prev
  if (event === 'SessionEnd') return undefined
  // Compact and resume send SessionStart on the same chat; only a new one or /clear starts over.
  const base: ChatProgress = prev && !(event === 'SessionStart' && RESET.has(String(payload.source)))
    ? prev
    : { sessionId, cwd: str(payload.cwd) ?? '', state: 'working', roles: [], tasks: [], startedAt: now, at: now }
  // A resumed chat is a new process: the old one's background subagents are gone and send no SubagentStop.
  const p: ChatProgress = event === 'SessionStart' && payload.source === 'resume' ? { ...base, at: now, running: undefined, waiting: undefined, jobs: undefined } : { ...base, at: now }
  const role = str(payload.agent_type)
  // A subagent's own events (a background one runs on after Stop) touch its role and tasks, never the chat's state.
  const sub = !!str(payload.agent_id)
  switch (event) {
    case 'SubagentStart': {
      if (!role) return p
      const id = str(payload.agent_id) ?? role
      return { ...p, ...(sub ? {} : { state: 'working', ...NO_ASK }), roles: trim([...p.roles.filter(r => r.id !== id), { id, role, state: 'active', startedAt: now }]), running: [...(p.running ?? []).filter(x => x !== id), id] }
    }
    case 'SubagentStop': {
      const id = str(payload.agent_id) ?? role
      // No id match (an old payload): the oldest running one of that role.
      const hit = p.roles.find(r => r.id === id) ?? p.roles.find(r => r.role === role && r.state === 'active')
      const { running: was, ...rest } = p
      const running = was?.filter(x => x !== id && x !== hit?.id)
      const q: ChatProgress = running?.length ? { ...rest, running } : rest
      const r = hit ? { ...q, roles: trim(q.roles.map(r => r === hit ? { ...r, state: 'done' as const } : r)) } : q
      if (!q.waiting || running?.length || q.jobs?.length) return r
      // A finished subagent always starts another lead turn, so a turn that ended with a block or every task done
      // stays wrapping up until that Stop decides; settle() covers a Stop that never comes. A plain turn goes idle now.
      if (q.finishing) return r
      const { waiting: _, ...after } = r
      return { ...after, state: 'idle' }
    }
    case 'PreToolUse': {
      const tool = str(payload.tool_name) ?? ''
      const input = (payload.tool_input ?? {}) as Payload
      const target = toolTarget(tool, input)
      const call: ToolCall = { tool, ...(target ? { target } : {}), role: sub ? role ?? 'subagent' : 'lead', at: now }
      p.tools = [...(p.tools ?? []), call].slice(-TOOLS_MAX)
      // A subagent's own TodoWrite is its private list; only the shared task tools reach the chat's list.
      if (sub) return tool === 'TodoWrite' ? p : { ...p, tasks: tasksFrom(p, tool, input, now) }
      delete p.limited
      if (tool === 'AskUserQuestion') {
        const ask = questionAsk(str(payload.tool_use_id) ?? String(now), input)
        if (ask) return withAsks(p, [...pendingAsks(p), ask])
        const q = Array.isArray(input.questions) ? str((input.questions[0] as Payload)?.question) : undefined
        return { ...p, state: 'needs-you', question: q ?? 'A question for you' }
      }
      // The lead moved on, so its own prompts are done; a subagent's still wait.
      return withAsks({ ...p, waiting: undefined, tasks: tasksFrom(p, tool, input, now) }, pendingAsks(p).filter(a => a.sub))
    }
    case 'UserPromptSubmit': {
      if (sub) return p
      // Kenneth's own asks, for the done receipt; mod prompts, task notifications and bare reminders are not his.
      const said = cut(String(payload.prompt ?? '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ''), ASKED_ITEM)
      // covered scores the old asks by index, so a new one drops them.
      const q: ChatProgress = said && !/^(Switchboard:|<task-notification>)/.test(said) ? { ...p, asked: [...(p.asked ?? []), said].slice(-ASKED_MAX), covered: undefined } : p
      // While limited the prompt may fail with no hook at all; the warning stays until real progress.
      return q.limited ? q : { ...q, state: 'working', ...NO_ASK, waiting: undefined }
    }
    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const job = event === 'PostToolUse' && !sub ? bgJob(str(payload.tool_name) ?? '', payload, now) : undefined
      if (job) p.jobs = [...(p.jobs ?? []).filter(j => j.id !== job.id), job]
      const tests = testRun(event, payload, now)
      if (tests) p.tests = tests
      // A subagent stopped with TaskStop sends no SubagentStop, a stopped shell no notification.
      const stopped = event === 'PostToolUse' && !sub && payload.tool_name === 'TaskStop' ? str((payload.tool_input as Payload | undefined)?.task_id) : undefined
      if (stopped && p.jobs) {
        const jobs = p.jobs.filter(j => j.task !== stopped)
        p.jobs = jobs.length ? jobs : undefined
      }
      if (stopped && p.running?.includes(stopped)) {
        const running = p.running.filter(x => x !== stopped)
        p.running = running.length ? running : undefined
        p.roles = p.roles.map(r => r.id === stopped ? { ...r, state: 'done' as const } : r)
      }
      // A call ending is the answer to the prompt it raised: same tool_use_id (a question) or same tool and input.
      const asks = pendingAsks(p), id = str(payload.tool_use_id)
      const key = `.${callKey(str(payload.tool_name) ?? '', payload.tool_input)}`
      const i = asks.findIndex(a => a.id === id || a.id.endsWith(key))
      if (i < 0) return sub ? p : asks.length ? p : { ...p, state: 'working', question: undefined, waiting: undefined }
      return withAsks(p, asks.filter((_, n) => n !== i))
    }
    case 'PermissionRequest': {
      // Comes just before the dialog; a subagent's counts too.
      const ask = permissionAsk(payload, now)
      return ask ? withAsks(p, [...pendingAsks(p), sub ? { ...ask, sub: true } : ask]) : p
    }
    case 'Notification':
      // A prompt waits on Kenneth whoever raised it, so a subagent's counts too. One with buttons keeps its text, so it notifies once.
      return ASKS.has(String(payload.notification_type)) ? { ...p, state: 'needs-you', question: (p.ask && p.question) || (str(payload.message) ?? 'Permission needed') } : p
    case 'Stop': {
      delete p.limited
      delete p.covered
      // An older block stays for Copy and Source Control, but only this turn's own block counts toward Done.
      const own = commitMessage(String(payload.last_assistant_message ?? ''))
      const open = p.tasks.some(t => t.status !== 'completed')
      const report = standup(String(payload.last_assistant_message ?? ''))
      // A standup with Done items counts too: a chat with nothing to change has no commit block.
      const finishing = !open && (!!own || p.tasks.length > 0 || !!report?.done.length) ? true as const : undefined
      const fresh = (at: number) => now - at <= RUNNING_CAP_MS
      const bg = new Set(p.running?.filter(id => { const r = p.roles.find(r => r.id === id); return !!r && fresh(r.startedAt) }))
      // hub-service.ts reads the ended ones from the transcript; no hook fires when a background shell ends.
      const ended = new Set(Array.isArray(payload.bg_finished) ? payload.bg_finished.map(String) : [])
      const jobs = p.jobs?.filter(j => !ended.has(j.id) && fresh(j.startedAt))
      const roles = trim(p.roles.map(r => bg.has(r.id) ? r : { ...r, state: 'done' as const }))
      const q: ChatProgress = { ...p, roles, commit: own ?? p.commit, report, running: bg.size ? [...bg] : undefined, jobs: jobs?.length ? jobs : undefined, finishing, ...NO_ASK }
      // Anything still running keeps the chat working, wrapping up, whatever the message said.
      if (q.running || q.jobs) return { ...q, state: 'working', waiting: true }
      // A turn that ends asking in plain text waits on Kenneth like a prompt does.
      const asked = finishing ? undefined : askedQuestion(String(payload.last_assistant_message ?? ''))
      if (asked) return { ...q, state: 'needs-you', question: asked, waiting: undefined }
      return settled({ ...q, waiting: undefined }, now)
    }
    case 'StopFailure': {
      // A turn killed by an API error sends this instead of Stop. A prompt sent while limited just fails again, so only real progress clears it.
      if (sub) return p
      const error = str(payload.error) ?? 'unknown'
      const question = LIMITS.has(error) ? LIMIT_TEXT : `API error (${error}): ${cut(payload.last_assistant_message, PREVIEW_MAX) ?? str(payload.error_details) ?? 'the turn ended'}`
      const keep = new Set(p.running)
      const roles = trim(p.roles.map(r => keep.has(r.id) ? r : { ...r, state: 'done' as const }))
      return { ...p, ...NO_ASK, roles, finishing: undefined, waiting: undefined, state: 'needs-you', question, limited: LIMITS.has(error) ? { at: now, error } : undefined }
    }
    case 'SwitchboardCovered':
      // Sent by the window that ran the check (coverage.ts), to itself and every mirror.
      return p.state === 'done' && Array.isArray(payload.scores) ? { ...p, covered: payload.scores.map(s => typeof s === 'number' ? s : null) } : p
    default:
      return p
  }
}

/** A chat waiting on background subagents or jobs that sent nothing for the cap has nothing left running. */
export function settle(p: ChatProgress, now: number): ChatProgress {
  if (!p.waiting || now - p.at < RUNNING_CAP_MS) return p
  const { waiting: _, running: __, jobs: ___, finishing: ____, ...rest } = p
  return { ...rest, state: 'idle', roles: rest.roles.map(r => r.state === 'active' ? { ...r, state: 'done' as const } : r) }
}

// notify.ts rules, here so the tests reach them without vscode.

/** At or under this Jev score, a request counts as not covered (coverage.ts). */
export const MISSED = 0.2
/** Requests Jev says the Done list does not cover; scores for another set of asks count for nothing. */
export const missed = (p: ChatProgress) => p.covered?.length !== p.asked?.length ? [] : (p.asked ?? []).filter((_, i) => { const s = p.covered?.[i]; return s !== null && s !== undefined && s <= MISSED })
/** Done, but Jev finds a request not covered. Left items are future work; they go to the to-do (todo.ts). */
export const almostDone = (p: ChatProgress) => p.state === 'done' && missed(p).length > 0
/** What a notification says; the same key twice in a row for one chat is shown once. Almost done and finished differ, so finishing notifies again. */
export const notifyKey = (p: ChatProgress) => `${almostDone(p) ? `almost ${missed(p).length}` : p.state}\n${(p.state === 'done' ? p.commit : p.question) ?? ''}`
/** A done chat's notification line. */
export const doneText = (p: ChatProgress) => missed(p).length
  ? `almost done, ${missed(p).length} of your requests not covered: ${missed(p)[0]}`
  : `finished${p.tasks.length ? `, all ${p.tasks.length} task${p.tasks.length === 1 ? '' : 's'} done` : ''}${p.report?.left.length ? `, ${p.report.left.length} to the to-do` : ''}`
export const shouldNotify = (prevKey: string | undefined, p: ChatProgress) => (p.state === 'done' || p.state === 'needs-you') && notifyKey(p) !== prevKey
/** Whether to show p, and the key to keep. Leaving needs-you forgets the question, so the same prompt asked again shows again; a Done key stays. */
export function notifyStep(prevKey: string | undefined, p: ChatProgress): { show: boolean; key?: string } {
  if (shouldNotify(prevKey, p)) return { show: true, key: notifyKey(p) }
  // A prompt sent while limited fails again; the same warning only shows again after real progress.
  return { show: false, key: p.state !== 'needs-you' && !p.limited && prevKey?.startsWith('needs-you\n') ? undefined : prevKey }
}

/** Source Control text is only replaced when empty or still what Switchboard wrote there. */
export const canPrefill = (current: string, lastWritten: string | undefined) => !current.trim() || current === lastWritten

/** Control characters (osascript rejects them) as spaces. */
// eslint-disable-next-line no-control-regex
export const plainText = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, ' ')

/** The end-of-day line: what finished today, what is almost done, what waits on Kenneth. Undefined on a quiet day. */
export function todayText(all: ChatProgress[], name: (p: ChatProgress) => string, now: number): string | undefined {
  const start = new Date(now).setHours(0, 0, 0, 0)
  const today = all.filter(p => (p.finishedAt ?? p.at) >= start)
  const almost = today.filter(almostDone), done = today.filter(p => p.state === 'done' && !almostDone(p)), you = today.filter(p => p.state === 'needs-you')
  if (!almost.length && !done.length && !you.length) return undefined
  const names = (ps: ChatProgress[]) => ps.length ? `: ${ps.slice(0, 3).map(name).join(', ')}${ps.length > 3 ? ` and ${ps.length - 3} more` : ''}` : ''
  return [`${done.length} finished`, `${almost.length} almost done${names(almost)}`, `${you.length} need you${names(you)}`].join('; ')
}

/** Whether version a (x.y.z) is past b; claude-runtime.ts reloads a window for it. */export const newerVersion = (a: string, b: string) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  return false
}

// Windows PowerShell's own app id, so the toast needs no registered app. The text rides in env, never in the script.
const TOAST = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null',
  '$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
  '$t = $x.GetElementsByTagName("text")',
  '$t.Item(0).AppendChild($x.CreateTextNode($env:SWITCHBOARD_TITLE)) > $null',
  '$t.Item(1).AppendChild($x.CreateTextNode($env:SWITCHBOARD_TEXT)) > $null',
  '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe").Show([Windows.UI.Notifications.ToastNotification]::new($x))',
].join('; ')

/** The OS notification as a command run with no shell; none on Linux. */
export function desktopNotice(title: string, text: string, platform: NodeJS.Platform = process.platform): { cmd: string; args: string[]; env?: Record<string, string> } | undefined {
  if (platform === 'darwin') {
    const q = (s: string) => JSON.stringify(plainText(s))
    return { cmd: 'osascript', args: ['-e', `display notification ${q(text)} with title ${q('Switchboard')} subtitle ${q(title)} sound name "Glass"`] }
  }
  if (platform === 'win32') return { cmd: 'powershell', args: ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', TOAST], env: { SWITCHBOARD_TITLE: plainText(`Switchboard: ${title}`), SWITCHBOARD_TEXT: plainText(text) } }
  return undefined
}
