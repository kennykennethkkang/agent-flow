/**
 * A chat's progress from its own hook events, no model call: the roles it delegated to,
 * its task list, and whether it is working, done, waiting on Kenneth or idle.
 * Pure, so the tests drive it with recorded payloads; hub-service.ts keeps the results.
 */
import type { ChatProgress, RoleStep, TaskRow, ToolCall } from './types'

type Payload = Record<string, unknown>
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const STATUS = new Set(['pending', 'in_progress', 'completed'])
const RESET = new Set(['startup', 'clear'])
const ASKS = new Set(['permission_prompt', 'elicitation_dialog'])
// ponytail: a background subagent that never sends SubagentStop counts as gone after an hour, at the lead's next Stop;
// a real one running longer shows done early. Raise it if that happens.
export const RUNNING_CAP_MS = 60 * 60 * 1000

/** The fenced block after a "Commit message" heading in the chat's last message. */
export function commitMessage(text: string): string | undefined {
  const m = /commit message[^\n]*\n+```[^\n]*\n([\s\S]*?)```/i.exec(text)
  return m?.[1].trim() || undefined
}

function tasksFrom(p: ChatProgress, tool: string, input: Payload): TaskRow[] {
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

/** A short, safe label for what a tool call touches; never file contents or prompts (the hub is read over the LAN). */
export function toolTarget(tool: string, input: Payload): string | undefined {
  const path = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path)
  let t: string | undefined
  if (tool === 'Bash') t = str(input.command)?.slice(0, 40)
  else if (tool === 'WebFetch') { try { t = new URL(String(input.url)).host } catch { t = undefined } }
  else if (tool === 'Agent' || tool === 'Task') t = str(input.subagent_type) ?? str(input.description)
  else t = str(input.pattern) ?? path?.split('/').filter(Boolean).slice(-2).join('/')
  return t ? plainText(t).slice(0, 48).trim() || undefined : undefined
}

/** Running subagents always stay; finished ones only the newest MAX_DONE. */
const MAX_DONE = 12
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
  const p: ChatProgress = event === 'SessionStart' && payload.source === 'resume' ? { ...base, at: now, running: undefined, waiting: undefined } : { ...base, at: now }
  const role = str(payload.agent_type)
  // A subagent's own events (a background one runs on after Stop) touch its role and tasks, never the chat's state.
  const sub = !!str(payload.agent_id)
  switch (event) {
    case 'SubagentStart': {
      if (!role) return p
      const id = str(payload.agent_id) ?? role
      return { ...p, ...(sub ? {} : { state: 'working', question: undefined }), roles: trim([...p.roles.filter(r => r.id !== id), { id, role, state: 'active', startedAt: now }]), running: [...(p.running ?? []).filter(x => x !== id), id] }
    }
    case 'SubagentStop': {
      const id = str(payload.agent_id) ?? role
      // No id match (an old payload): the oldest running one of that role.
      const hit = p.roles.find(r => r.id === id) ?? p.roles.find(r => r.role === role && r.state === 'active')
      const { running: was, ...rest } = p
      const running = was?.filter(x => x !== id && x !== hit?.id)
      const q: ChatProgress = running?.length ? { ...rest, running } : rest
      const r = hit ? { ...q, roles: trim(q.roles.map(r => r === hit ? { ...r, state: 'done' as const } : r)) } : q
      // The lead's turn already ended: the last background subagent finishing is what makes the chat idle.
      if (!q.waiting || running?.length) return r
      const { waiting: _, ...idle } = r
      return { ...idle, state: 'idle' }
    }
    case 'PreToolUse': {
      const tool = str(payload.tool_name) ?? ''
      const input = (payload.tool_input ?? {}) as Payload
      const target = toolTarget(tool, input)
      const call: ToolCall = { tool, ...(target ? { target } : {}), role: sub ? role ?? 'subagent' : 'lead', at: now }
      p.tools = [...(p.tools ?? []), call].slice(-8)
      // A subagent's own TodoWrite is its private list; only the shared task tools reach the chat's list.
      if (sub) return tool === 'TodoWrite' ? p : { ...p, tasks: tasksFrom(p, tool, input) }
      if (tool === 'AskUserQuestion') {
        const q = Array.isArray(input.questions) ? str((input.questions[0] as Payload)?.question) : undefined
        return { ...p, state: 'needs-you', question: q ?? 'A question for you' }
      }
      return { ...p, state: 'working', question: undefined, waiting: undefined, tasks: tasksFrom(p, tool, input) }
    }
    case 'UserPromptSubmit':
      return sub ? p : { ...p, state: 'working', question: undefined, waiting: undefined }
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return sub ? p : { ...p, state: 'working', question: undefined, waiting: undefined }
    case 'Notification':
      // A prompt waits on Kenneth whoever raised it, so a subagent's counts too.
      return ASKS.has(String(payload.notification_type)) ? { ...p, state: 'needs-you', question: str(payload.message) ?? 'Permission needed' } : p
    case 'Stop': {
      // A follow-up answer with no new block keeps the last one, so Copy and Source Control still have it.
      const commit = commitMessage(String(payload.last_assistant_message ?? '')) ?? p.commit
      const allDone = p.tasks.length > 0 && p.tasks.every(t => t.status === 'completed')
      const fresh = (id: string) => { const r = p.roles.find(r => r.id === id); return !!r && now - r.startedAt <= RUNNING_CAP_MS }
      const bg = new Set(p.running?.filter(fresh))
      const roles = trim(p.roles.map(r => bg.has(r.id) ? r : { ...r, state: 'done' as const }))
      const running = bg.size ? [...bg] : undefined
      // Background subagents still at work keep the chat working, not idle.
      if (bg.size && !commit && !allDone) return { ...p, roles, commit, running, question: undefined, state: 'working', waiting: true }
      return { ...p, roles, commit, running, question: undefined, waiting: undefined, state: commit || allDone ? 'done' : 'idle' }
    }
    default:
      return p
  }
}

/** A chat waiting on background subagents that sent nothing for the cap has nothing left running. */
export function settle(p: ChatProgress, now: number): ChatProgress {
  if (!p.waiting || now - p.at < RUNNING_CAP_MS) return p
  const { waiting: _, running: __, ...rest } = p
  return { ...rest, state: 'idle', roles: rest.roles.map(r => r.state === 'active' ? { ...r, state: 'done' as const } : r) }
}

// notify.ts rules, here so the tests reach them without vscode.

/** What a notification says; the same key twice in a row for one chat is shown once. */
export const notifyKey = (p: ChatProgress) => `${p.state}\n${(p.state === 'done' ? p.commit : p.question) ?? ''}`
export const shouldNotify = (prevKey: string | undefined, p: ChatProgress) => (p.state === 'done' || p.state === 'needs-you') && notifyKey(p) !== prevKey
/** Whether to show p, and the key to keep. Leaving needs-you forgets the question, so the same prompt asked again shows again; a Done key stays. */
export function notifyStep(prevKey: string | undefined, p: ChatProgress): { show: boolean; key?: string } {
  if (shouldNotify(prevKey, p)) return { show: true, key: notifyKey(p) }
  return { show: false, key: p.state !== 'needs-you' && prevKey?.startsWith('needs-you\n') ? undefined : prevKey }
}

/** Source Control text is only replaced when empty or still what Switchboard wrote there. */
export const canPrefill = (current: string, lastWritten: string | undefined) => !current.trim() || current === lastWritten

/** Control characters (osascript rejects them) as spaces. */
// eslint-disable-next-line no-control-regex
export const plainText = (s: string) => s.replace(/[\x00-\x1f\x7f]/g, ' ')
