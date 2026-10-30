/**
 * The brain: what every live chat is doing, grouped by project, the four rules
 * that suggest a step, the brief a new chat reads, and Ask. Pure but for askBrain and the .git lookup.
 * hub-service.ts recomputes board and suggest on each change; routes.ts serves
 * brief and ask, each told only about the asking chat's own project.
 */
import { execFile } from 'child_process'
import * as path from 'path'
import { repoTop } from './projects'
import type { BoardProject, HubState, Server, SessionLive, Suggestion } from './types'

const CLASH_MS = 60 * 60 * 1000
const FULL_AT = 0.85
const BRIEF_MAX = 1200
const ASK_TIMEOUT_MS = 60_000

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
const inside = (cwd: string, root: string) => norm(cwd) === norm(root) || norm(cwd).startsWith(`${norm(root)}/`)

// Same shapes the usage mod strips from handoff notes.
const SECRETS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  /\b[0-9a-fA-F]{32,}\b/g,
]
export const redact = (text: string) => SECRETS.reduce((s, re) => s.replace(re, '[removed]'), text)

/** The project a folder belongs to: its git repo, else the longest listed project holding it, else its last part. */
function projectOf(state: HubState, cwd: string): { project: string; cwd: string } {
  const top = repoTop(cwd)
  if (top) return { project: path.basename(top), cwd: norm(top) }
  const p = state.projects.filter(x => inside(cwd, x.path)).sort((a, b) => b.path.length - a.path.length)[0]
  return p ? { project: p.name, cwd: norm(p.path) } : { project: path.basename(norm(cwd)) || cwd, cwd: norm(cwd) }
}

const percent = (s: SessionLive) => (s.tokens !== undefined && s.compactAt ? s.tokens / s.compactAt : undefined)

export function board(state: HubState): BoardProject[] {
  const by = new Map<string, BoardProject>()
  for (const s of state.live) {
    const { project, cwd } = projectOf(state, s.cwd)
    const row = by.get(cwd) ?? { project, cwd, chats: [] }
    row.chats.push({ sessionId: s.sessionId, label: s.label, prompt: s.prompt, file: s.file, percent: percent(s), at: s.at })
    by.set(cwd, row)
  }
  return [...by.values()]
}

const nameOf = (s: SessionLive) => s.label ?? s.sessionId.slice(0, 8)
const taskNumber = (title: string) => /^(\d+)\b/.exec(title)?.[1]

/** The open project's plan: the window shows one plan, for the folder it has open. */
function nextTask(state: HubState): string | undefined {
  return state.plan?.tasks.find(t => t.total > 0 && t.done < t.total)?.title
}

/** `gone`: dev servers seen earlier that stopped, from hub-service.ts. */
export function suggest(state: HubState, gone: Server[], now = Date.now()): Suggestion[] {
  const out: Suggestion[] = []
  const recent = state.live.filter(s => s.file && s.fileAt !== undefined && now - s.fileAt < CLASH_MS)
  const byFile = new Map<string, SessionLive[]>()
  for (const s of recent) byFile.set(s.file!, [...(byFile.get(s.file!) ?? []), s])
  for (const [file, chats] of byFile) {
    if (chats.length < 2) continue
    out.push({ id: `clash:${file}`, kind: 'clash', text: `${chats.map(nameOf).join(' and ')} both have ${path.basename(file)} open.`, sessions: chats.map(s => s.sessionId) })
  }
  for (const s of state.live) {
    const p = percent(s)
    if (p !== undefined && p >= FULL_AT) out.push({ id: `full:${s.sessionId}`, kind: 'full', text: `${nameOf(s)} is ${Math.round(p * 100)}% of the way to compacting.`, sessions: [s.sessionId] })
  }
  const task = nextTask(state)
  const open = state.projects.find(p => p.isOpen)
  if (task && open) {
    const n = taskNumber(task)
    // ponytail: a chat "has" a task when its latest prompt names it; a chat can drift off one silently.
    const taken = state.live.some(s => inside(s.cwd, open.path) && s.prompt && (n ? new RegExp(`\\btask\\s*${n}\\b`, 'i').test(s.prompt) : s.prompt.includes(task)))
    if (!taken) out.push({ id: `task:${task}`, kind: 'task', text: `No chat is on Task ${task}.`, sessions: [], folder: open.path, task })
  }
  for (const s of gone) out.push({ id: `server:${s.port}`, kind: 'server', text: `The dev server on :${s.port} stopped.`, sessions: [], folder: s.folder })
  return out
}

/** A Codex chat's first message: the brief in front while Brief is on (Codex has no hook to read it from). */
export const withBrief = (state: HubState, cwd: string, text: string | undefined) =>
  [state.controls.switchboard.brief ? brief(state, cwd, '') : '', text].filter(Boolean).join('\n\n')

/** What a new chat in `cwd` reads first; empty when there is nothing to tell it. */
export function brief(state: HubState, cwd: string, self: string, now = Date.now()): string {
  const home = projectOf(state, cwd)
  const rel = (f: string) => (inside(f, home.cwd) ? norm(f).slice(home.cwd.length + 1) : path.basename(f))
  const others = state.live.filter(s => s.sessionId !== self && projectOf(state, s.cwd).cwd === home.cwd)
  const files = [...new Set(others.filter(s => s.file && s.fileAt !== undefined && now - s.fileAt < CLASH_MS).map(s => rel(s.file!)))]
  const open = state.projects.find(p => p.isOpen)
  const task = open && norm(open.path) === home.cwd ? nextTask(state) : undefined
  const sites = state.servers.filter(s => inside(s.folder, home.cwd)).map(s => `http://localhost:${s.port}`)

  const lines: string[] = []
  if (others.length) {
    lines.push('Other chats in this project:')
    for (const s of others) lines.push(`- ${nameOf(s)}${s.prompt ? `: "${s.prompt.slice(0, 120)}"` : ''}${s.file ? ` (in ${rel(s.file)})` : ''}`)
  }
  if (files.length) lines.push(`Leave alone, another chat is editing: ${files.join(', ')}`)
  if (task) lines.push(`Next open plan task: ${task}`)
  if (task && state.plan?.decisions?.length) lines.push(`Recent decisions: ${state.plan.decisions.join('; ')}`)
  const todo = Object.entries(state.todos ?? {}).find(([f]) => norm(f) === home.cwd)?.[1].todo ?? []
  if (todo.length) {
    lines.push('Open to-do (if your work completes one, even one you were not asked to do, call todo_done with its id before you finish):')
    for (const t of todo) lines.push(`- ${t.id}: ${t.text.slice(0, 120)}`)
  }
  if (sites.length) lines.push(`Dev site: ${sites.join(', ')}`)
  for (const c of state.starred.filter(c => c.sessionId !== self && projectOf(state, c.cwd).cwd === home.cwd)) {
    const gist = c.digest.lastPrompt ?? c.digest.note?.split('\n').find(l => l.trim() && !l.startsWith('#'))
    lines.push(`Starred: ${c.name}${gist ? `: "${gist.slice(0, 120)}"` : ''}`)
  }
  if (!lines.length) return ''
  const head = `Switchboard brief for ${home.project}. Ask the hub_ask tool for more.`
  let text = head
  for (const line of lines) {
    const next = `${text}\n${redact(line)}`
    if (next.length > BRIEF_MAX) break
    text = next
  }
  return text
}

/** The board and suggestions for one project only: all Ask ever sees. */
export function askContext(state: HubState, cwd: string, gone: Server[], now = Date.now()): string {
  const home = projectOf(state, cwd)
  const sessions = new Set(state.live.filter(s => projectOf(state, s.cwd).cwd === home.cwd).map(s => s.sessionId))
  return redact(JSON.stringify({
    board: board(state).filter(p => p.cwd === home.cwd),
    suggestions: suggest(state, gone, now).filter(s => s.sessions.some(id => sessions.has(id)) || (s.folder && inside(s.folder, home.cwd))),
  }))
}

/** A throwaway call: no transcript saved, and no hooks, so it never shows up as a chat in Switchboard. */
// No plugins, MCP servers, tools or default system prompt: a tool pick was 17 s with them, near PICK_MS, and fell back to everything on.
export const quickAskArgs = (prompt: string) => ['-p', '--no-session-persistence', '--settings', JSON.stringify({ disableAllHooks: true }), '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands', '--tools', '', '--system-prompt', 'Answer exactly as the prompt asks.', '--model', 'haiku', prompt]

/** One quick answer from Claude Code's Haiku on the subscription; rejects on error. */
export function quickAsk(prompt: string, timeoutMs = ASK_TIMEOUT_MS): Promise<string> {
  // CLAUDE_CODE_CHILD_SESSION keeps this throwaway call out of the chat list and /resume.
  return new Promise((resolve, reject) => execFile('claude', quickAskArgs(prompt), { timeout: timeoutMs, maxBuffer: 1 << 20, env: { ...process.env, CLAUDE_CODE_CHILD_SESSION: '1' } },
    (err, stdout) => (err ? reject(err) : resolve(stdout.trim()))))
}

/** One paid Haiku call per question, with the project's board as its only context. */
export function askBrain(question: string, context: string): Promise<string> {
  const prompt = `You are the Switchboard brain. Answer in a few plain sentences from this board of the project's live chats, and say so when it does not cover the question.\n\nBoard: ${context}\n\nQuestion: ${question.slice(0, 500)}`
  return quickAsk(prompt).catch(err => `The brain could not answer (${String(err.message).split('\n')[0]}).`)
}
