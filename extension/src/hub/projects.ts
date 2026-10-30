/**
 * Projects and new chats: the folders Switchboard can open, what the clone box
 * accepts, and the command a new chat runs in its terminal. hub-panel.ts does
 * the opening, cloning and terminals.
 */
import * as path from 'path'
import type { Project } from './types'

export function mergeProjects(repos: string[], claudeDirs: string[], open?: string): Project[] {
  const seen = new Set<string>()
  const out: Project[] = []
  const add = (p: string, kind: Project['kind']) => {
    if (seen.has(p)) return
    seen.add(p)
    out.push({ name: path.basename(p), path: p, kind, isOpen: p === open })
  }
  repos.forEach(p => add(p, 'repo'))
  claudeDirs.forEach(p => add(p, 'project'))
  return out
}

// A GitHub owner or repo: no leading dot or dash, so it can never be `..` or read as a flag.
const NAME = '[A-Za-z0-9_][A-Za-z0-9_.-]*?'
const SHORT = new RegExp(`^(${NAME})/(${NAME})$`)
const HTTPS = new RegExp(`^https://github\\.com/(${NAME})/(${NAME})(?:\\.git)?/?$`)
const SSH = new RegExp(`^git@github\\.com:(${NAME})/(${NAME})(?:\\.git)?$`)

export type Shell = 'posix' | 'powershell'
/** The shell a chat terminal runs here. */
export const SHELL: Shell = process.platform === 'win32' ? 'powershell' : 'posix'
/** One line as one argument: sh single quotes, or PowerShell's with every quote, curly ones too, doubled. */
export const shellQuote = (s: string, shell: Shell) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return shell === 'posix' ? `'${one.replace(/'/g, `'\\''`)}'` : `'${one.replace(/['\u2018\u2019\u201A\u201B]/g, '$&$&')}'`
}

/** A GitHub repo from owner/repo, its https URL or its ssh address; anything else is refused. */
export function cloneTarget(input: string): { url: string; name: string } | undefined {
  const s = input.trim()
  const ssh = SSH.exec(s)
  if (ssh) return { url: `git@github.com:${ssh[1]}/${ssh[2]}.git`, name: ssh[2] }
  const m = SHORT.exec(s) ?? HTTPS.exec(s)
  return m ? { url: `https://github.com/${m[1]}/${m[2]}.git`, name: m[2] } : undefined
}

// Quoted for the shell, so git judges the rest of the name itself; only a flag, an empty name or whitespace is refused here.
const BRANCH = /^(?!-)[^\s\x00-\x1f]+$/

/**
 * `claude` with the first message, Remote Control under a name (the flag takes an
 * optional name, so without one it would swallow the message), after a new branch.
 * textFile, when given, carries the message instead: a line typed into a starting shell
 * is cut at 1024 bytes on macOS, which left long messages at a `quote>` prompt.
 */
export function newChatCommand(o: { text?: string; textFile?: string; remote?: string; branch?: string; name?: string; sessionId?: string; settings?: string; system?: string }, shell: Shell): string {
  const quote = (s: string) => shellQuote(s, shell)
  let claude = 'claude'
  if (o.name) claude += ` --name ${quote(o.name)}`
  if (o.sessionId !== undefined) {
    if (!/^[0-9a-f-]{36}$/i.test(o.sessionId)) throw new Error('Not a session id')
    claude += ` --session-id ${o.sessionId}`
  }
  if (o.settings) claude += ` --settings ${quote(o.settings)}`
  if (o.system) claude += ` --append-system-prompt ${quote(o.system)}`
  if (o.remote) claude += ` --remote-control ${quote(o.remote)}`
  if (o.textFile) claude += shell === 'posix' ? ` "$(cat ${quote(o.textFile)})"` : ` (Get-Content -Raw ${quote(o.textFile)})`
  else if (o.text?.trim()) claude += ` ${quote(o.text)}`
  if (o.branch === undefined) return claude
  if (!BRANCH.test(o.branch)) throw new Error(`Not a usable branch name: ${o.branch}`)
  const b = quote(o.branch)
  return shell === 'posix' ? `git switch -c ${b} && ${claude}` : `git switch -c ${b}; if ($?) { ${claude} }`
}

/** Handoffs only start chats in this window's folder or below it. */
export function inWorkspace(cwd: string, workspace: string | undefined): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  if (!workspace) return false
  const ws = norm(workspace), c = norm(cwd)
  return c === ws || c.startsWith(`${ws}/`)
}

const MAX_NAME = 60
const words = (s: string) => s.split(/[\s_-]+/).filter(Boolean).slice(0, 3).join(' ')
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')

/** What a chat is on: the plan's first three words (no date), else the task's, else continued. */
export function planLabel(plan?: string, task?: string): string {
  const fromPlan = plan ? words(path.basename(plan).replace(/^\d{4}-\d{2}-\d{2}-/, '').replace(/\.md$/, '')) : ''
  const label = fromPlan || words(task ?? '')
  return label ? cap(label) : 'continued'
}

/** `Project · Label`, at most 60 characters. */
export const chatLabel = (project: string, plan?: string, task?: string) => `${project} · ${planLabel(plan, task)}`.slice(0, MAX_NAME).trim()

// `Origin vN`, or the older `Origin · N`. ponytail: a name that ends in ` v18` of its own reads as a version; tag handoff names if that bites.
const CHAIN = /^(.+?)(?: v| · )(\d+)$/
/** The origin chat a name continues, without its ` vN`; undefined for an origin itself. */
export const chainBase = (name?: string) => (name ? CHAIN.exec(name.trim())?.[1] : undefined)
/** Which chat of its chain a name is: the origin is v1. */
export const chainVersion = (name?: string) => Number((name && CHAIN.exec(name.trim())?.[2]) || 1)

/** A handed-off chat's name: its origin with the next version (`Fix login v3`); a chat with no name starts from its plan or task. */
export function nextChainName(old: string | undefined, project: string, plan?: string, task?: string): string {
  const origin = chainBase(old) ?? (old?.trim() || chatLabel(project, plan, task))
  const end = ` v${chainVersion(old) + 1}`
  return `${origin.slice(0, MAX_NAME - end.length).trim()}${end}`
}

/** n: the fresh chat's version; base: the origin. */
export type NoteHeader = { n: number; base: string; from: string; id8: string; to: string; branch: string; plan: string }

/** The note with a header naming both chats; a note that already has one (either scheme) is left as is. */
export function labelNote(note: string, h: NoteHeader): string {
  if (/^# Handoff v?\d/.test(note)) return note
  return `# Handoff v${h.n} · ${h.base}\nFrom: ${h.from} (${h.id8})\nTo:   ${h.to}\nBranch: ${h.branch} · Plan: ${h.plan}\n\n${note}`
}

/** The fresh chat's first prompt; usage-meter knows a fresh chat by its `Continue from <note>.md: read it first` start. */
export const freshPrompt = (note: string) =>
  `Continue from ${note}: read it first, recreate every open task in it with the task tools before any other work, then carry on.`

/** The note with the subagents the wait cap left running, if any. */
export function stillRunning(note: string, running: string[] | undefined): string {
  if (!running?.length) return note
  const lines = running.map(r => `- ${r}: output in subagents/agent-${r.split(' ').pop()}.jsonl next to the old transcript; check it, redo the work if it is cut off`)
  return `${note.replace(/\n+$/, '')}\n\n## Still running at the 30 minute wait cap\n\n${lines.join('\n')}\n`
}

/** The fresh chat's name from a note's `To:` line. */
export const noteTo = (note: string) => /^To:\s+(.+)$/m.exec(note)?.[1].trim() || undefined

const stamp = (now: number) => new Date(now).toISOString().slice(0, 16)

/** `YYYY-MM-DD-HHMM-<project>-<label>-<id8>.md`, UTC, the name usage-meter gives its notes. */
export const handoffFile = (project: string, label: string, sessionId: string, now = Date.now()) =>
  `${stamp(now).replace('T', '-').replace(':', '')}-${slug(project)}-${slug(label)}-${sessionId.slice(0, 8)}.md`

/** The note Switchboard writes for a full Codex chat, which has no usage mod to write one. */
export function codexNote(o: { project: string; cwd: string; branch: string; plan?: string; prompt?: string }, now = Date.now()): string {
  return [
    `# Handoff: ${o.project}, ${stamp(now).replace('T', ' ')} UTC`, '',
    `Folder: ${o.cwd}`, `Branch: ${o.branch}`, `Plan: ${o.plan ?? 'none'}`, '',
    '## Last prompt', '', (o.prompt ?? '(none found)').slice(0, 500), '',
    'The old Codex chat filled its context. Read the plan and the repo state, then carry on with the open tasks.', '',
  ].join('\n')
}
